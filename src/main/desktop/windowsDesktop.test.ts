import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import type { ChildProcess, SpawnOptions } from "child_process";
import {
  AUDIO_SCRIPT,
  MEDIA_KEY_SCRIPT,
  WINDOW_SCRIPT,
  WindowsDesktop,
  parseScriptResult,
  Spawner,
} from "./windowsDesktop";

function recordingRunner(output: string) {
  const calls: Array<{ script: string; env: Record<string, string> }> = [];
  return {
    calls,
    run: async (script: string, env: Record<string, string>) => {
      calls.push({ script, env });
      return output;
    },
  };
}

function fakeSpawner(outcome: "spawn" | "error" = "spawn") {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawnFn: Spawner = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    setImmediate(() =>
      outcome === "spawn" ? child.emit("spawn") : child.emit("error", new Error("ENOENT"))
    );
    return child as unknown as ChildProcess;
  };
  return { calls, spawnFn };
}

const noOpen = async () => "";

// -------------------------------------------------- values never become code

test("a window command passes the process and command as data, and reads the count", async () => {
  const runner = recordingRunner('Add-Type noise\r\n{"windows":2}\r\n');
  const desktop = new WindowsDesktop(noOpen, runner.run);

  assert.deepEqual(await desktop.windowCommand("discord", "minimize"), { windows: 2 });
  assert.equal(runner.calls[0].script, WINDOW_SCRIPT);
  assert.deepEqual(runner.calls[0].env, { NIMBUS_TARGET: "discord", NIMBUS_COMMAND: "minimize" });
});

test("the script is a constant: the value it acts on is never part of it", async () => {
  const runner = recordingRunner('{"windows":1}');
  const desktop = new WindowsDesktop(noOpen, runner.run);

  await desktop.windowCommand("discord", "focus");
  await desktop.windowCommand("chrome", "focus");

  assert.equal(runner.calls[0].script, runner.calls[1].script);
  assert.doesNotMatch(runner.calls[0].script, /discord|chrome/);
});

test("the scripts check their inputs again, independently of the caller", () => {
  assert.match(WINDOW_SCRIPT, /-notmatch '\^\[A-Za-z0-9\]/);
  assert.match(WINDOW_SCRIPT, /invalid window command/);
  assert.match(MEDIA_KEY_SCRIPT, /invalid media key/);
  assert.match(AUDIO_SCRIPT, /invalid audio operation/);
  assert.match(AUDIO_SCRIPT, /volume out of range/);
});

test("a window script that returns no result is an error, not zero windows", async () => {
  const desktop = new WindowsDesktop(noOpen, recordingRunner("garbage").run);
  await assert.rejects(desktop.windowCommand("discord", "focus"));
});

test("setVolume and setMuted pass the operation and value as data", async () => {
  const runner = recordingRunner('{"volume":30,"muted":false}');
  const desktop = new WindowsDesktop(noOpen, runner.run);

  await desktop.setVolume(30.4);
  await desktop.setMuted(true);
  await desktop.setMuted(false);

  assert.ok(runner.calls.every((c) => c.script === AUDIO_SCRIPT));
  assert.deepEqual(
    runner.calls.map((c) => c.env),
    [
      { NIMBUS_AUDIO_OP: "volume", NIMBUS_VALUE: "30" },
      { NIMBUS_AUDIO_OP: "mute", NIMBUS_VALUE: "1" },
      { NIMBUS_AUDIO_OP: "mute", NIMBUS_VALUE: "0" },
    ]
  );
});

test("sendMediaKey passes the key as data", async () => {
  const runner = recordingRunner('{"ok":true}');
  const desktop = new WindowsDesktop(noOpen, runner.run);

  await desktop.sendMediaKey("next");

  assert.equal(runner.calls[0].script, MEDIA_KEY_SCRIPT);
  assert.deepEqual(runner.calls[0].env, { NIMBUS_KEY: "next" });
});

// ------------------------------------------------------ launching & locking

test("an .exe is started directly: no shell, no arguments, from its own folder", async () => {
  const spawner = fakeSpawner();
  const desktop = new WindowsDesktop(noOpen, undefined, spawner.spawnFn);

  await desktop.launchApplication("C:\\Games\\Terraria\\Terraria.exe");

  const [call] = spawner.calls;
  assert.equal(call.command, "C:\\Games\\Terraria\\Terraria.exe");
  assert.deepEqual(call.args, []);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, "ignore");
  assert.equal(call.options.cwd, "C:\\Games\\Terraria");
});

test("a failed start is reported, not swallowed", async () => {
  const desktop = new WindowsDesktop(noOpen, undefined, fakeSpawner("error").spawnFn);
  await assert.rejects(desktop.launchApplication("C:\\Games\\missing.exe"));
});

test("a shortcut is opened the way clicking it would, not spawned", async () => {
  const opened: string[] = [];
  const spawner = fakeSpawner();
  const desktop = new WindowsDesktop(
    async (p) => {
      opened.push(p);
      return "";
    },
    undefined,
    spawner.spawnFn
  );

  await desktop.launchApplication("C:\\Start Menu\\Discord.lnk");

  assert.deepEqual(opened, ["C:\\Start Menu\\Discord.lnk"]);
  assert.deepEqual(spawner.calls, []);
});

test("openPath's error message becomes a rejection", async () => {
  const desktop = new WindowsDesktop(async () => "No application is associated with this file");
  await assert.rejects(desktop.openPath("C:\\x\\file.xyz"), /No application is associated/);
});

test("locking runs rundll32 with fixed arguments and no shell", async () => {
  const spawner = fakeSpawner();
  const desktop = new WindowsDesktop(noOpen, undefined, spawner.spawnFn);

  await desktop.lockScreen();

  assert.equal(spawner.calls[0].command, "rundll32.exe");
  assert.deepEqual(spawner.calls[0].args, ["user32.dll,LockWorkStation"]);
  assert.equal(spawner.calls[0].options.shell, false);
});

// ------------------------------------------------------------------ helpers

test("pathInfo reports a missing path as not existing rather than throwing", async () => {
  const missing = new WindowsDesktop(noOpen, undefined, undefined, async () => {
    throw new Error("ENOENT");
  });
  const file = new WindowsDesktop(noOpen, undefined, undefined, async () => ({
    isFile: () => true,
    isDirectory: () => false,
  }));

  assert.deepEqual(await missing.pathInfo("C:\\nope"), { exists: false, isFile: false, isDirectory: false });
  assert.deepEqual(await file.pathInfo("C:\\yes.pdf"), { exists: true, isFile: true, isDirectory: false });
});

test("parseScriptResult takes the last JSON line", () => {
  assert.deepEqual(parseScriptResult('warning\n{"a":1}\nmore\n{"windows":3}\n'), { windows: 3 });
  assert.throws(() => parseScriptResult("nothing here"));
});
