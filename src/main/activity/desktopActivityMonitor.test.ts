import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopActivityMonitor } from "./desktopActivityMonitor";
import { ContextEventBus } from "../../events/eventBus";
import { RawActivitySnapshot, emptySnapshot } from "./activitySnapshot";
import { PowerShellRunner } from "./powerShellSession";

test("the first poll after starting establishes a baseline and publishes no events", async () => {
  const bus = new ContextEventBus();
  const received: string[] = [];
  bus.subscribe((e) => received.push(e.type));

  const poll = async (): Promise<RawActivitySnapshot> => ({ ...emptySnapshot(), processNames: ["steam.exe"] });
  const monitor = new DesktopActivityMonitor(bus, poll, 999_999);

  monitor.start();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(received, []);
  monitor.stop();
});

test("a process that appears on a later poll (after the baseline) fires an event", async () => {
  const bus = new ContextEventBus();
  const received: string[] = [];
  bus.subscribe((e) => received.push(e.type));

  let current: RawActivitySnapshot = emptySnapshot();
  const poll = async () => current;
  const monitor = new DesktopActivityMonitor(bus, poll, 10);

  monitor.start(); // baseline poll — nothing running yet
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(received, []);

  current = { ...emptySnapshot(), processNames: ["steam.exe"] };
  await new Promise((r) => setTimeout(r, 30)); // a real interval tick picks up the new process
  monitor.stop();

  assert.deepEqual(received, ["applicationOpened"]);
});

test("an unchanged snapshot across ticks publishes nothing further", async () => {
  const bus = new ContextEventBus();
  let count = 0;
  bus.subscribe(() => count++);

  const snapshot: RawActivitySnapshot = { ...emptySnapshot(), processNames: ["steam.exe"] };
  const poll = async () => snapshot;
  const monitor = new DesktopActivityMonitor(bus, poll, 10);

  monitor.start(); // baseline — no events even though steam.exe is "running"
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 0);

  await new Promise((r) => setTimeout(r, 30)); // still the same snapshot — nothing changed
  monitor.stop();
  assert.equal(count, 0);
});

test("a poll function that throws is handled gracefully and does not stop the monitor", async () => {
  const bus = new ContextEventBus();
  let received = 0;
  bus.subscribe(() => received++);

  let shouldThrow = true;
  const poll = async (): Promise<RawActivitySnapshot> => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error("PowerShell unavailable (simulated)");
    }
    return { ...emptySnapshot(), processNames: ["steam.exe"] };
  };
  const monitor = new DesktopActivityMonitor(bus, poll, 10);

  monitor.start(); // first tick throws — no baseline established yet
  await new Promise((r) => setImmediate(r));
  assert.equal(received, 0);

  // Second tick succeeds and becomes the (first successful) baseline —
  // still correctly produces no event for a process that was already
  // there when the baseline was captured.
  await new Promise((r) => setTimeout(r, 30));
  monitor.stop();
  assert.equal(received, 0);
});

test("stopping the monitor resets its baseline — restarting requires a fresh baseline poll again", async () => {
  const bus = new ContextEventBus();
  const received: string[] = [];
  bus.subscribe((e) => received.push(e.type));

  const poll = async (): Promise<RawActivitySnapshot> => ({ ...emptySnapshot(), processNames: ["steam.exe"] });
  const monitor = new DesktopActivityMonitor(bus, poll, 999_999);

  monitor.start();
  await new Promise((r) => setImmediate(r));
  monitor.stop();

  monitor.start();
  await new Promise((r) => setImmediate(r));
  monitor.stop();

  assert.deepEqual(received, []); // both were baseline polls (steam.exe never "changed") — no events either time
});

/**
 * A stub for the persistent PowerShell session — records how often it
 * was created and run, and can be made to fail on demand.
 */
class StubSession implements PowerShellRunner {
  static created = 0;
  static disposed = 0;
  runs = 0;
  shouldFail = false;

  constructor() {
    StubSession.created++;
  }
  async run(): Promise<string> {
    this.runs++;
    if (this.shouldFail) throw new Error("session died");
    return "{}";
  }
  dispose(): void {
    StubSession.disposed++;
  }
}

test("repeated polls reuse one PowerShell session rather than starting one each tick", async () => {
  StubSession.created = 0;
  const session = new StubSession();
  const bus = new ContextEventBus();
  let runScriptRef: ((script: string) => Promise<string>) | undefined;

  const poll = async (runScript?: (script: string) => Promise<string>) => {
    runScriptRef = runScript;
    if (runScript) await runScript("dummy");
    return emptySnapshot();
  };
  const monitor = new DesktopActivityMonitor(bus, poll, 999_999, () => new Date(), () => session);

  monitor.start();
  await new Promise((r) => setImmediate(r));
  await runScriptRef!("dummy");
  await runScriptRef!("dummy");

  assert.equal(StubSession.created, 1, "the session should be constructed once, not per poll");
  assert.equal(session.runs, 3);
  monitor.stop();
});

test("stopping the monitor disposes the PowerShell session", async () => {
  StubSession.disposed = 0;
  const session = new StubSession();
  const bus = new ContextEventBus();
  const poll = async (runScript?: (script: string) => Promise<string>) => {
    if (runScript) await runScript("dummy");
    return emptySnapshot();
  };
  const monitor = new DesktopActivityMonitor(bus, poll, 999_999, () => new Date(), () => session);

  monitor.start();
  await new Promise((r) => setImmediate(r));
  monitor.stop();

  assert.equal(StubSession.disposed, 1);
});

test("a failing session stops being retried after repeated failures", async () => {
  StubSession.disposed = 0;
  const session = new StubSession();
  session.shouldFail = true;
  const bus = new ContextEventBus();
  let runScriptRef: ((script: string) => Promise<string>) | undefined;

  const poll = async (runScript?: (script: string) => Promise<string>) => {
    runScriptRef = runScript;
    return emptySnapshot();
  };
  const monitor = new DesktopActivityMonitor(bus, poll, 999_999, () => new Date(), () => session);

  monitor.start();
  await new Promise((r) => setImmediate(r));

  // Each call falls back to the one-shot path, which has no PowerShell
  // here — what matters is that the session is abandoned, not the result.
  for (let i = 0; i < 3; i++) {
    await runScriptRef!("dummy").catch(() => undefined);
  }

  assert.equal(session.runs, 3, "the session should be tried three times, then abandoned");
  assert.equal(StubSession.disposed >= 1, true);

  await runScriptRef!("dummy").catch(() => undefined);
  assert.equal(session.runs, 3, "no further attempts once the session has been given up on");

  monitor.stop();
});
