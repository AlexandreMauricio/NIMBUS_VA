import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, learnedConfidence } from "./memoryService";
import { recordActivityEnded, recordNewNetworkDevice, recordRoutineDecision } from "./recorders";
import {
  MAX_ITEMS,
  MemoryItem,
  MemoryOrigin,
  MemoryStateStore,
  parseMemoryItem,
  validateMemoryValue,
} from "./types";

const DAY = 24 * 60 * 60_000;

class FakeStore implements MemoryStateStore {
  files: Partial<Record<MemoryOrigin, unknown>> = {};
  saves: MemoryOrigin[] = [];
  load(origin: MemoryOrigin): unknown {
    return this.files[origin];
  }
  save(origin: MemoryOrigin, items: MemoryItem[]): void {
    this.saves.push(origin);
    this.files[origin] = JSON.parse(JSON.stringify(items));
  }
}

function setup(store = new FakeStore(), learning = { on: true }) {
  const clock = { now: new Date("2026-09-11T10:00:00Z") };
  let n = 0;
  const memory = new MemoryService(
    store,
    () => clock.now,
    () => `m${++n}`,
    () => learning.on
  );
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { memory, store, clock, advance, learning };
}

const pattern = (key = "activity:study") => ({
  key,
  source: "activity",
  update: (previous: unknown) => ({ count: ((previous as { count?: number } | null)?.count ?? 0) + 1 }),
  title: "Study is a habit",
});

// ------------------------------------------------------------------- model

test("values are small: scalars or one flat object of them", () => {
  for (const ok of ["text", 3, true, null, { a: 1, b: "x", c: null }])
    assert.equal(validateMemoryValue(ok), null);
  for (const bad of [{ a: { nested: 1 } }, [1, 2], "x".repeat(1001), Number.NaN, { a: [1] }]) {
    assert.ok(validateMemoryValue(bad), JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- explicit

test("a saved memory is fully trusted, never expires by default, and is persisted in its own tier", () => {
  const { memory, store } = setup();
  const item = memory.remember({
    kind: "preference",
    title: " Preferred volume ",
    value: 40,
    detail: "For music",
  });

  assert.equal(item.origin, "explicit");
  assert.equal(item.title, "Preferred volume");
  assert.equal(item.confidence, 1);
  assert.equal(item.expiresAt, null);
  assert.equal(item.source, "user");
  assert.deepEqual(store.saves, ["explicit"]);
  assert.equal((store.files.explicit as MemoryItem[])[0].value, 40);
});

test("saving checks what's saved", () => {
  const { memory } = setup();
  assert.throws(() => memory.remember({ kind: "preference", title: "" }), /needs a title/);
  assert.throws(() => memory.remember({ kind: "preference", title: "x".repeat(121) }), /at most 120/);
  assert.throws(() => memory.remember({ kind: "pattern" as "fact", title: "x" }), /preference or a fact/);
  assert.throws(
    () => memory.remember({ kind: "fact", title: "x", value: { a: { b: 1 } } as never }),
    /Field "a"/
  );
  assert.throws(() => memory.remember({ kind: "fact", title: "x", expiresAt: "2020-01-01" }), /future/);
  assert.throws(() => memory.remember({ kind: "fact", title: "x", expiresAt: "soon" }), /isn't valid/);
});

test("the user's own memories can be edited; learned ones only switched off", () => {
  const { memory } = setup();
  const saved = memory.remember({ kind: "fact", title: "My project", value: "NIMBUS" });
  const edited = memory.update(saved.id, {
    title: "Main project",
    value: "NIMBUS 0.4",
    detail: "desktop app",
  });
  assert.equal(edited.title, "Main project");
  assert.equal(edited.value, "NIMBUS 0.4");

  const learned = memory.reinforce(pattern())!;
  assert.throws(() => memory.update(learned.id, { title: "No" }), /only be switched off/);
  assert.equal(memory.update(learned.id, { disabled: true }).disabled, true);
  assert.throws(() => memory.update("nope", { disabled: true }), /no longer exists/);
  assert.throws(() => memory.update(saved.id, { disabled: "yes" }), /true or false/);
});

// ----------------------------------------------------------------- learned

test("a pattern is reinforced in place: evidence grows, and so does confidence — never to certainty", () => {
  const { memory } = setup();
  let item = memory.reinforce(pattern())!;
  assert.equal(item.evidence, 1);
  assert.equal(item.confidence, 0.25);
  for (let i = 0; i < 8; i++) item = memory.reinforce(pattern())!;
  assert.equal(item.evidence, 9);
  assert.equal(item.confidence, 0.75);
  assert.deepEqual(item.value, { count: 9 });
  assert.equal(memory.list({ origin: "learned" }).length, 1, "one pattern, not nine");
  assert.equal(learnedConfidence(1000), 0.95);
});

test("a pattern the user switched off isn't learned from any more", () => {
  const { memory } = setup();
  const item = memory.reinforce(pattern())!;
  memory.update(item.id, { disabled: true });
  const after = memory.reinforce(pattern())!;
  assert.equal(after.evidence, 1);
  assert.equal(after.disabled, true);
});

test("with learning off, nothing is observed or learned — the user can still save", () => {
  const { memory, learning } = setup();
  learning.on = false;
  assert.equal(memory.reinforce(pattern()), null);
  assert.equal(memory.observe({ key: "k", kind: "history", title: "t", value: 1, source: "network" }), null);
  assert.equal(memory.remember({ kind: "fact", title: "Still works" }).origin, "explicit");
});

// ---------------------------------------------------------------- observed

test("an observation is updated if seen again, and forgotten after its time", () => {
  const { memory, advance, store } = setup();
  memory.observe({
    key: "network:new:a",
    kind: "history",
    title: "New device",
    value: { ip: "1" },
    source: "network",
  });
  const again = memory.observe({
    key: "network:new:a",
    kind: "history",
    title: "New device",
    value: { ip: "2" },
    source: "network",
  })!;
  assert.equal(again.evidence, 2);
  assert.deepEqual(again.value, { ip: "2" });
  assert.equal(again.confidence, 0.5);
  assert.equal(memory.list().length, 1);

  advance(31 * DAY);
  assert.deepEqual(memory.list(), []);
  assert.deepEqual(store.files.observed, [], "expired items are removed from disk too");
});

test("learned patterns fade after 90 days without new evidence; reinforcement keeps them", () => {
  const { memory, advance } = setup();
  memory.reinforce(pattern("a"));
  memory.reinforce(pattern("b"));
  advance(80 * DAY);
  memory.reinforce(pattern("b"));
  advance(20 * DAY);
  assert.deepEqual(
    memory.list().map((i) => i.key),
    ["b"]
  );
});

test("a saved memory with a forget date is forgotten on that date", () => {
  const { memory, advance } = setup();
  memory.remember({ kind: "fact", title: "Guest wifi password changed", expiresAt: "2026-09-12T10:00:00Z" });
  assert.equal(memory.list().length, 1);
  advance(DAY);
  assert.equal(memory.list().length, 0);
});

test("tiers have caps; over one, the least recently updated observations go", () => {
  const { memory, advance } = setup();
  for (let i = 0; i <= MAX_ITEMS.observed; i++) {
    memory.observe({ key: `k${i}`, kind: "history", title: `t${i}`, value: i, source: "test" });
    advance(1000);
  }
  const keys = memory.list({ origin: "observed" }).map((i) => i.key);
  assert.equal(keys.length, MAX_ITEMS.observed);
  assert.ok(!keys.includes("k0"));
});

// ------------------------------------------------------- retrieval / trust

test("recall prefers the most trusted enabled memory for a key", () => {
  const { memory } = setup();
  memory.observe({ key: "volume", kind: "preference", title: "Volume seen", value: 30, source: "media" });
  const learned = memory.reinforce({ ...pattern("volume"), kind: "preference", title: "Usual volume" })!;
  assert.equal(memory.recall("volume")?.origin, "learned");

  const kept = memory.promote(learned.id);
  assert.equal(kept.origin, "explicit");
  assert.equal(kept.confidence, 1);
  assert.equal(kept.expiresAt, null);
  assert.equal(memory.recall("volume")?.id, kept.id);
  assert.equal(memory.list({ origin: "learned" }).length, 0, "moved, not copied");

  memory.update(kept.id, { disabled: true });
  assert.equal(memory.recall("volume")?.origin, "observed", "a switched-off memory isn't used");
  assert.equal(memory.recall("nothing"), null);
});

test("search and filters: kind, origin, source and text; switched-off items only on request", () => {
  const { memory } = setup();
  memory.remember({ kind: "preference", title: "Preferred playlist", value: "Deep Focus" });
  memory.remember({ kind: "fact", title: "Living room TV", value: "Samsung Q60" });
  memory.reinforce(pattern());
  const off = memory.remember({ kind: "fact", title: "Old fact" });
  memory.update(off.id, { disabled: true });

  assert.deepEqual(
    memory.list({ kind: "fact" }).map((i) => i.title),
    ["Living room TV"]
  );
  assert.equal(memory.list({ origin: "learned" }).length, 1);
  assert.equal(memory.list({ source: "user" }).length, 2);
  assert.deepEqual(
    memory.list({ text: "samsung" }).map((i) => i.title),
    ["Living room TV"],
    "the value is searched too"
  );
  assert.equal(memory.list({ includeDisabled: true }).length, 4);
  assert.equal(memory.list()[0].origin, "explicit", "most trusted first");
});

test("forgetting removes an item from memory and from disk", () => {
  const { memory, store } = setup();
  const item = memory.remember({ kind: "fact", title: "x" });
  assert.equal(memory.forget(item.id), true);
  assert.equal(memory.forget(item.id), false);
  assert.equal(memory.get(item.id), null);
  assert.deepEqual(store.files.explicit, []);
});

// -------------------------------------------------------------- persistence

test("everything survives a restart, each tier from its own file", () => {
  const first = setup();
  first.memory.remember({ kind: "preference", title: "Volume", value: 40 });
  first.memory.reinforce(pattern());
  first.memory.observe({ key: "k", kind: "history", title: "Seen", value: 1, source: "network" });

  const restarted = setup(first.store);
  assert.deepEqual(
    restarted.memory.list().map((i) => i.origin),
    ["explicit", "learned", "observed"]
  );
  const learned = restarted.memory.reinforce(pattern())!;
  assert.equal(learned.evidence, 2, "the pattern continues where it was");
});

test("malformed persisted data is skipped item by item — or tier by tier — never fatal", () => {
  const { store } = setup();
  const good = {
    id: "g1",
    kind: "fact",
    origin: "explicit",
    key: null,
    title: "Good",
    value: "ok",
    detail: null,
    source: "user",
    confidence: 1,
    evidence: 1,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    expiresAt: null,
    disabled: false,
  };
  store.files.explicit = [
    good,
    { ...good, id: "wrong-tier", origin: "learned" },
    { ...good, id: "bad-date", createdAt: "yesterday" },
    { ...good, id: "bad-value", value: { deep: { x: 1 } } },
    { ...good, id: "bad-kind", kind: "secret" },
    { ...good, id: "g1", title: "duplicate id" },
    "not even an object",
  ];
  store.files.learned = { not: "a list" };
  store.files.observed = null;

  const { memory } = setup(store);
  assert.deepEqual(
    memory.list().map((i) => i.id),
    ["g1"]
  );
  assert.equal(memory.list()[0].title, "Good");
  assert.equal(parseMemoryItem({ ...good, confidence: 2 }, "explicit"), null);
});

test("a store that throws on load or save doesn't stop memory working", () => {
  const broken: MemoryStateStore = {
    load: () => {
      throw new Error("disk gone");
    },
    save: () => {
      throw new Error("disk full");
    },
  };
  const memory = new MemoryService(
    broken,
    () => new Date("2026-09-11T10:00:00Z"),
    () => "x1"
  );
  assert.equal(memory.remember({ kind: "fact", title: "In memory only" }).id, "x1");
  assert.equal(memory.list().length, 1);
});

test("listeners hear about every change", () => {
  const { memory } = setup();
  let changes = 0;
  memory.onChange(() => changes++);
  const item = memory.remember({ kind: "fact", title: "x" });
  memory.update(item.id, { disabled: true });
  memory.forget(item.id);
  assert.equal(changes, 3);
});

// --------------------------------------------------------------- recorders

test("finished activity sessions build a recurring-activity pattern; short ones don't count", () => {
  const { memory } = setup();
  const session = (startIso: string, minutes: number) =>
    recordActivityEnded(
      memory,
      {
        id: "e",
        type: "activityEnded",
        occurredAt: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
        source: "activityService",
        activity: "Study",
        durationMs: minutes * 60_000,
      },
      "UTC"
    );

  assert.equal(session("2026-09-10T20:05:00Z", 5), null, "five minutes isn't a habit");
  session("2026-09-08T20:00:00Z", 60);
  session("2026-09-09T20:30:00Z", 90);
  const item = session("2026-09-10T09:00:00Z", 30)!;

  assert.equal(item.key, "activity:study");
  assert.equal(item.origin, "learned");
  assert.equal(item.title, "Study — usually around 20:00");
  assert.equal(item.detail, "3 sessions, 3 h in all");
  assert.equal((item.value as Record<string, unknown>).sessions, 3);
  assert.equal(item.confidence, 0.5);
});

test("routine decisions build an acceptance pattern", () => {
  const { memory } = setup();
  const routine = { id: "r1", name: "Study mode" };
  recordRoutineDecision(memory, routine, "accepted");
  recordRoutineDecision(memory, routine, "dismissed");
  const item = recordRoutineDecision(memory, routine, "accepted")!;
  assert.equal(item.title, 'Routine "Study mode"');
  assert.equal(item.detail, "Accepted 2 of 3 suggestions");
  assert.equal(item.source, "routines");
});

test("a new network device is kept as history for 30 days", () => {
  const { memory, advance } = setup();
  const item = recordNewNetworkDevice(memory, {
    id: "e",
    type: "networkDeviceAppeared",
    occurredAt: "2026-09-11T10:00:00Z",
    source: "networkService",
    deviceId: "mac:3c:22:fb:00:00:04",
    ip: "192.168.1.42",
    mac: "3c:22:fb:00:00:04",
    hostname: null,
    vendor: "Example Networks",
  })!;
  assert.equal(item.kind, "history");
  assert.equal(item.origin, "observed");
  assert.equal(item.detail, "Example Networks at 192.168.1.42");
  assert.equal(item.confidence, 0.9);
  advance(31 * DAY);
  assert.equal(memory.list().length, 0);
});
