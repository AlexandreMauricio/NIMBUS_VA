import { ChildProcess, SpawnOptions, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { DesktopPlatform, MediaKey, PathInfo, WindowCommand } from "../../actions/providers/desktopPlatform";

/**
 * The Windows implementation of DesktopPlatform — the device-edge half of
 * the app/files/media/system desktop actions.
 *
 * Nothing here accepts or builds a command line from user input:
 *
 *  - Files, folders and shortcuts open through Electron's `shell.openPath`
 *    (injected), which is what double-clicking does.
 *  - An .exe is started with `spawn(path, [], { shell: false })` — no
 *    shell to interpret anything, and no arguments at all.
 *  - Window, media-key and volume operations run small PowerShell scripts
 *    that are **constants** in this file. The values they act on (a process
 *    name, a key, a volume) are passed as environment variables and read
 *    by the script as data; they are never spliced into the script text,
 *    so a value cannot become code. The scripts re-check those values too.
 *  - Locking runs `rundll32.exe user32.dll,LockWorkStation` with fixed
 *    arguments.
 */

const SCRIPT_TIMEOUT_MS = 15_000;

export type PowerShellRunner = (script: string, env: Record<string, string>) => Promise<string>;
export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type StatFn = (p: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;

/** Focus / minimize / maximize / close the named process's main window(s). */
export const WINDOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
$name = $env:NIMBUS_TARGET
$command = $env:NIMBUS_COMMAND
if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$') { throw 'invalid process name' }
if (@('focus', 'minimize', 'maximize', 'close') -notcontains $command) { throw 'invalid window command' }
$targets = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
if ($targets.Count -gt 0) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NimbusWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
  if ($command -eq 'focus') {
    $p = $targets[0]
    if ([NimbusWindow]::IsIconic($p.MainWindowHandle)) { [void][NimbusWindow]::ShowWindow($p.MainWindowHandle, 9) }
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.AppActivate($p.Id)
    [void][NimbusWindow]::SetForegroundWindow($p.MainWindowHandle)
  } else {
    foreach ($p in $targets) {
      if ($command -eq 'minimize') { [void][NimbusWindow]::ShowWindow($p.MainWindowHandle, 6) }
      elseif ($command -eq 'maximize') { [void][NimbusWindow]::ShowWindow($p.MainWindowHandle, 3) }
      else { [void]$p.CloseMainWindow() }
    }
  }
}
'{"windows":' + $targets.Count + '}'
`.trim();

/** Press one media key. */
export const MEDIA_KEY_SCRIPT = `
$ErrorActionPreference = 'Stop'
switch ($env:NIMBUS_KEY) {
  'playPause' { $vk = 0xB3 }
  'next' { $vk = 0xB0 }
  'previous' { $vk = 0xB1 }
  default { throw 'invalid media key' }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NimbusKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
[NimbusKeys]::keybd_event([byte]$vk, 0, 1, [UIntPtr]::Zero)
[NimbusKeys]::keybd_event([byte]$vk, 0, 3, [UIntPtr]::Zero)
'{"ok":true}'
`.trim();

/**
 * Master volume and mute of the default output device, through the Core
 * Audio API (IAudioEndpointVolume). The "read" operation changes nothing;
 * every operation reports the state afterwards.
 */
export const AUDIO_SCRIPT = `
$ErrorActionPreference = 'Stop'
$op = $env:NIMBUS_AUDIO_OP
$value = $env:NIMBUS_VALUE
if (@('volume', 'mute', 'read') -notcontains $op) { throw 'invalid audio operation' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify);
  int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float levelDb, IntPtr context);
  int SetMasterVolumeLevelScalar(float level, IntPtr context);
  int GetMasterVolumeLevel(out float levelDb);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint channel, float levelDb, IntPtr context);
  int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr context);
  int GetChannelVolumeLevel(uint channel, out float levelDb);
  int GetChannelVolumeLevelScalar(uint channel, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public static class NimbusAudio {
  static IAudioEndpointVolume Endpoint() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object endpoint;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
    return (IAudioEndpointVolume)endpoint;
  }
  public static void SetVolume(float level) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(level, IntPtr.Zero)); }
  public static float GetVolume() { float level; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out level)); return level; }
  public static void SetMute(bool mute) { Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, IntPtr.Zero)); }
  public static bool GetMute() { bool mute; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out mute)); return mute; }
}
'@
if ($op -eq 'volume') {
  $level = [int]$value
  if ($level -lt 0 -or $level -gt 100) { throw 'volume out of range' }
  [NimbusAudio]::SetVolume($level / 100.0)
} elseif ($op -eq 'mute') {
  [NimbusAudio]::SetMute($value -eq '1')
}
'{"volume":' + [int][Math]::Round([NimbusAudio]::GetVolume() * 100) + ',"muted":' + ([NimbusAudio]::GetMute()).ToString().ToLower() + '}'
`.trim();

/**
 * Runs one of the constant scripts above. The script travels as
 * -EncodedCommand (so nothing about it is re-quoted by anything), and the
 * values it needs as environment variables. No shell is involved.
 */
export function runEncodedPowerShell(
  script: string,
  env: Record<string, string>,
  timeoutMs: number = SCRIPT_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`PowerShell exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/** The last line of output that is a JSON object — the scripts' only result line. */
export function parseScriptResult(output: string): Record<string, unknown> {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error("The script returned no result.");
  return JSON.parse(line) as Record<string, unknown>;
}

export class WindowsDesktop implements DesktopPlatform {
  constructor(
    /** Electron's `shell.openPath`: resolves "" on success, or an error message. */
    private readonly openPathFn: (p: string) => Promise<string>,
    private readonly runPowerShell: PowerShellRunner = runEncodedPowerShell,
    private readonly spawnFn: Spawner = (command, args, options) => spawn(command, args, options),
    private readonly statFn: StatFn = (p) => fs.promises.stat(p)
  ) {}

  async pathInfo(p: string): Promise<PathInfo> {
    try {
      const stats = await this.statFn(p);
      return { exists: true, isFile: stats.isFile(), isDirectory: stats.isDirectory() };
    } catch {
      return { exists: false, isFile: false, isDirectory: false };
    }
  }

  async openPath(p: string): Promise<void> {
    const error = await this.openPathFn(p);
    if (error) throw new Error(error);
  }

  async launchApplication(p: string): Promise<void> {
    // A shortcut carries its own target and arguments — opening it is
    // exactly what clicking it in the Start menu does.
    if (path.win32.extname(p).toLowerCase() === ".lnk") return this.openPath(p);
    await this.spawnDetached(p, [], { cwd: path.win32.dirname(p), windowsHide: false });
  }

  async windowCommand(processName: string, command: WindowCommand): Promise<{ windows: number }> {
    const output = await this.runPowerShell(WINDOW_SCRIPT, {
      NIMBUS_TARGET: processName,
      NIMBUS_COMMAND: command,
    });
    const windows = Number(parseScriptResult(output).windows);
    if (!Number.isFinite(windows)) throw new Error("The window script returned no window count.");
    return { windows };
  }

  async sendMediaKey(key: MediaKey): Promise<void> {
    parseScriptResult(await this.runPowerShell(MEDIA_KEY_SCRIPT, { NIMBUS_KEY: key }));
  }

  async setVolume(percent: number): Promise<void> {
    parseScriptResult(
      await this.runPowerShell(AUDIO_SCRIPT, {
        NIMBUS_AUDIO_OP: "volume",
        NIMBUS_VALUE: String(Math.round(percent)),
      })
    );
  }

  async setMuted(muted: boolean): Promise<void> {
    parseScriptResult(
      await this.runPowerShell(AUDIO_SCRIPT, { NIMBUS_AUDIO_OP: "mute", NIMBUS_VALUE: muted ? "1" : "0" })
    );
  }

  async lockScreen(): Promise<void> {
    await this.spawnDetached("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true });
  }

  /** Starts a process that outlives this call, resolving once Windows has actually started it. */
  private spawnDetached(command: string, args: string[], options: SpawnOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(command, args, {
        ...options,
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}
