import { test } from "node:test";
import assert from "node:assert/strict";
import { BriefingService } from "./briefingService";
import { ContextService } from "../context/contextService";
import { ContextProvider } from "../context/types";

function okProvider(id: string, data: unknown): ContextProvider {
  return { id, displayName: id, isAvailable: () => true, getContext: () => data };
}

function throwingProvider(id: string): ContextProvider {
  return {
    id,
    displayName: id,
    isAvailable: () => true,
    getContext: () => {
      throw new Error(`${id} boom`);
    },
  };
}

test("getCurrent() is null before any generation has happened", () => {
  const service = new BriefingService(new ContextService());
  assert.equal(service.getCurrent(), null);
});

test("generate() produces a briefing and getCurrent() then returns it without regenerating", async () => {
  const contextService = new ContextService();
  contextService.register(
    okProvider("dateTime", { date: "2024-01-15", time: "09:00:00", dayOfWeek: "Monday" })
  );
  const service = new BriefingService(contextService);

  const briefing = await service.generate();
  assert.ok(briefing.items.length > 0);

  const current = service.getCurrent();
  assert.equal(current, briefing);
});

test("getCurrent() never triggers a new context fetch", async () => {
  let fetchCount = 0;
  const contextService = new ContextService();
  contextService.register({
    id: "counted",
    displayName: "counted",
    isAvailable: () => true,
    getContext: () => {
      fetchCount++;
      return { n: fetchCount };
    },
  });
  const service = new BriefingService(contextService);

  await service.generate();
  service.getCurrent();
  service.getCurrent();
  service.getCurrent();

  assert.equal(fetchCount, 1);
});

test("concurrent generate() calls share a single in-flight generation", async () => {
  let fetchCount = 0;
  const contextService = new ContextService();
  contextService.register({
    id: "counted",
    displayName: "counted",
    isAvailable: () => true,
    getContext: async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 10));
      return { n: fetchCount };
    },
  });
  const service = new BriefingService(contextService);

  const [a, b, c] = await Promise.all([service.generate(), service.generate(), service.generate()]);

  assert.equal(fetchCount, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("a failing provider does not prevent a briefing from being generated", async () => {
  const contextService = new ContextService();
  contextService.register(throwingProvider("weather"));
  const service = new BriefingService(contextService);

  const briefing = await service.generate();

  assert.ok(briefing.items.length > 0);
  assert.equal(briefing.items[0].category, "greeting");
});

test("a second explicit generate() call produces a new briefing (new id)", async () => {
  const contextService = new ContextService();
  const service = new BriefingService(contextService);

  const first = await service.generate();
  const second = await service.generate();

  assert.notEqual(first.id, second.id);
});
