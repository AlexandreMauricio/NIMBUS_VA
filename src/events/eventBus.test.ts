import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextEventBus } from "./eventBus";
import { ContextEvent } from "./types";

function appEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    id: "e1",
    type: "applicationOpened",
    occurredAt: new Date().toISOString(),
    executableName: "steam.exe",
    windowTitle: null,
    activation: "launched",
    ...overrides,
  } as ContextEvent;
}

test("a subscribed listener receives a published event", () => {
  const bus = new ContextEventBus();
  const received: ContextEvent[] = [];
  bus.subscribe((e) => received.push(e));

  const event = appEvent();
  bus.publish(event);

  assert.equal(received.length, 1);
  assert.equal(received[0], event);
});

test("multiple listeners all receive the same event", () => {
  const bus = new ContextEventBus();
  let count = 0;
  bus.subscribe(() => count++);
  bus.subscribe(() => count++);

  bus.publish(appEvent());
  assert.equal(count, 2);
});

test("unsubscribing stops further delivery", () => {
  const bus = new ContextEventBus();
  let count = 0;
  const unsubscribe = bus.subscribe(() => count++);

  bus.publish(appEvent());
  unsubscribe();
  bus.publish(appEvent());

  assert.equal(count, 1);
});

test("a throwing listener does not prevent other listeners from receiving the event", () => {
  const bus = new ContextEventBus();
  let secondCalled = false;
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe(() => {
    secondCalled = true;
  });

  bus.publish(appEvent());
  assert.equal(secondCalled, true);
});

test("publishing with no subscribers does not throw", () => {
  const bus = new ContextEventBus();
  assert.doesNotThrow(() => bus.publish(appEvent()));
});
