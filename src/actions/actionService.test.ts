import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionService } from "./actionService";
import { ActionDefinition, ActionProvider, ActionResult, ActionValidationResult } from "./types";

function def(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    id: "demo.doThing",
    name: "Do thing",
    description: "Does a thing.",
    parameters: [],
    readOnly: false,
    changesExternalState: true,
    requiresConfirmation: false,
    affectsService: "demo",
    ...overrides,
  };
}

function successResult(actionId: string, message = "Done."): ActionResult {
  const now = new Date().toISOString();
  return { actionId, status: "success", message, startedAt: now, finishedAt: now, durationMs: 1 };
}

/** A minimal stub ActionProvider for exercising ActionService in isolation. */
class StubProvider implements ActionProvider {
  readonly id = "demo";
  readonly displayName = "Demo";
  available: boolean | Promise<boolean> = true;
  executeImpl: (actionId: string, params: Record<string, unknown>) => Promise<ActionResult> = async (
    actionId
  ) => successResult(actionId);
  validateImpl: (actionId: string, params: Record<string, unknown>) => ActionValidationResult = () => ({
    valid: true,
  });
  actions: ActionDefinition[] = [def()];

  listActions() {
    return this.actions;
  }
  isAvailable() {
    return this.available;
  }
  validate(actionId: string, params: Record<string, unknown>) {
    return this.validateImpl(actionId, params);
  }
  execute(actionId: string, params: Record<string, unknown>) {
    return this.executeImpl(actionId, params);
  }
}

test("executing a valid, available action returns a success result", async () => {
  const service = new ActionService();
  service.register(new StubProvider());

  const result = await service.executeAction("demo.doThing", {});
  assert.equal(result.status, "success");
  assert.equal(result.actionId, "demo.doThing");
});

test("an unknown action id (no matching provider) fails with not_available", async () => {
  const service = new ActionService();
  service.register(new StubProvider());

  const result = await service.executeAction("nonexistent.doThing", {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_available");
});

test("a provider that reports unavailable fails with not_available, never calling execute", async () => {
  const service = new ActionService();
  const provider = new StubProvider();
  provider.available = false;
  let executeCalled = false;
  provider.executeImpl = async (actionId) => {
    executeCalled = true;
    return successResult(actionId);
  };
  service.register(provider);

  const result = await service.executeAction("demo.doThing", {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_available");
  assert.equal(executeCalled, false);
});

test("invalid parameters fail validation before execute is called", async () => {
  const service = new ActionService();
  const provider = new StubProvider();
  provider.validateImpl = () => ({ valid: false, error: "volumePercent must be 0-100" });
  let executeCalled = false;
  provider.executeImpl = async (actionId) => {
    executeCalled = true;
    return successResult(actionId);
  };
  service.register(provider);

  const result = await service.executeAction("demo.doThing", { volumePercent: 500 });
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "invalid_parameters");
  assert.match(result.error!.message, /volumePercent/);
  assert.equal(executeCalled, false);
});

test("a provider's own reported failure passes through as a structured ActionResult", async () => {
  const service = new ActionService();
  const provider = new StubProvider();
  provider.executeImpl = async (actionId) => ({
    actionId,
    status: "failure",
    error: { category: "not_found", message: "I couldn't find that." },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 5,
  });
  service.register(provider);

  const result = await service.executeAction("demo.doThing", {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_found");
});

test("a provider throwing from execute() never propagates — it degrades to a structured failure", async () => {
  const service = new ActionService();
  const provider = new StubProvider();
  provider.executeImpl = async () => {
    throw new Error("boom");
  };
  service.register(provider);

  const result = await service.executeAction("demo.doThing", {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "unknown");
  assert.doesNotMatch(result.error!.message, /boom/); // technical detail never reaches the result
});

test("a provider throwing from isAvailable() degrades to unavailable rather than crashing", async () => {
  const service = new ActionService();
  const provider = new StubProvider();
  provider.isAvailable = () => {
    throw new Error("boom");
  };
  service.register(provider);

  const result = await service.executeAction("demo.doThing", {});
  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_available");
});

test("listActions surfaces each provider's declared permission/confirmation metadata", () => {
  const service = new ActionService();
  service.register(
    new (class extends StubProvider {
      actions = [
        def({ id: "demo.harmless", requiresConfirmation: false, changesExternalState: true }),
        def({ id: "demo.risky", requiresConfirmation: true, changesExternalState: true }),
      ];
    })()
  );

  const actions = service.listActions();
  assert.equal(actions.find((a) => a.id === "demo.harmless")?.requiresConfirmation, false);
  assert.equal(actions.find((a) => a.id === "demo.risky")?.requiresConfirmation, true);
});

test("getHistory records executed actions, most recent first", async () => {
  const service = new ActionService();
  service.register(new StubProvider());

  await service.executeAction("demo.doThing", {});
  await service.executeAction("demo.doThing", {});
  const history = service.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].actionId, "demo.doThing");
});

test("registering two providers with the same id throws", () => {
  const service = new ActionService();
  service.register(new StubProvider());
  assert.throws(() => service.register(new StubProvider()));
});

test("an action provider hanging in execute resolves to a timeout failure", async () => {
  const service = new ActionService(20);
  const provider = new StubProvider();
  provider.executeImpl = () => new Promise<ActionResult>(() => {});
  service.register(provider);

  const result = await service.executeAction("demo.doThing");

  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "timeout");
});

test("an action provider hanging in isAvailable reports the action as not available", async () => {
  const service = new ActionService(20);
  const provider = new StubProvider();
  provider.available = new Promise<boolean>(() => {});
  service.register(provider);

  const result = await service.executeAction("demo.doThing");

  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_available");
});

test("a timed-out action still lands in history like any other result", async () => {
  const service = new ActionService(20);
  const provider = new StubProvider();
  provider.executeImpl = () => new Promise<ActionResult>(() => {});
  service.register(provider);

  await service.executeAction("demo.doThing");

  assert.equal(service.getHistory().length, 1);
  assert.equal(service.getHistory()[0].error?.category, "timeout");
});
