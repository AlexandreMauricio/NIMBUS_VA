import { ChildProcess, spawn } from "child_process";
import { logger } from "../../logging/logger";

/**
 * A single long-lived PowerShell process that scripts are fed to over
 * stdin, instead of spawning a fresh `powershell.exe` per call.
 *
 * The activity monitor polls every few seconds for as long as NIMBUS is
 * running. Starting a new PowerShell each time costs a process launch
 * plus roughly a second of .NET/PowerShell startup before any of the
 * actual work begins — tens of thousands of times a day for a background
 * tray app. Reusing one process pays that once.
 *
 * The protocol is deliberately dumb, because the alternative is parsing
 * an interactive shell's output:
 *
 *  - A script is sent as ONE line: a base64 blob unwrapped and run by
 *    `Invoke-Expression`. Sending raw multi-line text over stdin would
 *    make the session's parser state depend on the script's own
 *    formatting; encoding sidesteps that entirely, the same reason the
 *    one-shot path used `-EncodedCommand`.
 *  - Completion is signalled by the script echoing a sentinel line.
 *    Without it there is no way to know a script has finished, only that
 *    output has paused.
 *
 * Only one script may be in flight at a time — the caller (the monitor's
 * tick guard) already guarantees this, and a second concurrent call is
 * rejected rather than silently interleaved into the same stdout stream.
 *
 * Windows-specific by nature, so it lives under `src/main/`.
 */

/** Marks the end of one script's output. Long and specific so real output can't collide with it. */
const SENTINEL = "<<<NIMBUS-POWERSHELL-END-4f8a2c>>>";

export interface PowerShellRunner {
  run(script: string, timeoutMs: number): Promise<string>;
  dispose(): void;
}

export class PowerShellSession implements PowerShellRunner {
  private child: ChildProcess | null = null;
  private buffer = "";
  private pending: {
    resolve: (out: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  /**
   * Runs `script` and resolves with everything it wrote to stdout.
   *
   * Rejects — rather than hanging — if the process dies, the deadline
   * passes, or another script is already running. The caller treats any
   * rejection as a failed poll, which is already a survivable outcome.
   */
  run(script: string, timeoutMs: number): Promise<string> {
    if (this.pending) {
      return Promise.reject(new Error("A PowerShell script is already running in this session"));
    }

    let child: ChildProcess;
    try {
      child = this.ensureStarted();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A script that overran its budget leaves the session's stdout
        // stream at an unknown point — anything still to come would be
        // misattributed to the next call. Killing it forces a clean
        // restart on the next run().
        logger.warn("PowerShell script timed out — restarting the session");
        this.settle(null, new Error(`PowerShell script timed out after ${timeoutMs}ms`));
        this.kill();
      }, timeoutMs);

      this.pending = { resolve, reject, timer };
      this.buffer = "";

      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const line =
        `Invoke-Expression ([Text.Encoding]::Unicode.GetString(` +
        `[Convert]::FromBase64String('${encoded}')));` +
        `Write-Output '${SENTINEL}'\n`;

      try {
        child.stdin!.write(line);
      } catch (err) {
        this.settle(null, err instanceof Error ? err : new Error(String(err)));
        this.kill();
      }
    });
  }

  dispose(): void {
    this.settle(null, new Error("PowerShell session disposed"));
    this.kill();
  }

  private ensureStarted(): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }

    // `-Command -` reads commands from stdin. With stdin a pipe rather
    // than a console, PowerShell emits no prompts or banner, so stdout
    // carries only what the scripts themselves write.
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      windowsHide: true,
    });

    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr!.setEncoding("utf-8");
    child.stderr!.on("data", (chunk: string) => {
      // The scripts set $ErrorActionPreference themselves; anything
      // reaching stderr is unexpected and worth a breadcrumb, but is
      // never fatal on its own — the sentinel still decides completion.
      logger.debug("PowerShell session stderr", { output: chunk.trim().slice(0, 500) });
    });

    child.on("error", (err) => {
      this.settle(null, err);
      this.child = null;
    });

    child.on("exit", (code) => {
      // An in-flight script can never complete now; fail it explicitly
      // rather than leaving the caller waiting on its own timeout.
      this.settle(null, new Error(`PowerShell session exited with code ${code}`));
      this.child = null;
    });

    // Never hold the app open on account of the poller.
    child.unref();

    this.child = child;
    return child;
  }

  private onStdout(chunk: string): void {
    if (!this.pending) return; // output arriving after a timeout/kill — nothing to attribute it to

    this.buffer += chunk;
    const index = this.buffer.indexOf(SENTINEL);
    if (index === -1) return;

    this.settle(this.buffer.slice(0, index), null);
    this.buffer = "";
  }

  private settle(output: string | null, err: Error | null): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (err) pending.reject(err);
    else pending.resolve(output ?? "");
  }

  private kill(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch (err) {
      logger.debug("Failed to kill PowerShell session", { error: String(err) });
    }
    this.child = null;
  }
}
