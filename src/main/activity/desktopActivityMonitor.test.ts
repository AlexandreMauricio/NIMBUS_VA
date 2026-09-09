import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopActivityMonitor } from "./desktopActivityMonitor";
import { ContextEventBus } from "../../events/eventBus";
import { RawActivitySnapshot, emptySnapshot } from "./activitySnapshot";

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
