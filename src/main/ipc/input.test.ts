import { test } from "node:test";
import assert from "node:assert/strict";
import { asRecord, boolOr, idArg, numberOr, recordList } from "./input";
import { mergeKnown } from "./mergeKnown";

test("asRecord: a plain object as is, anything else empty", () => {
  const object = { a: 1 };
  assert.equal(asRecord(object), object);
  for (const raw of [undefined, null, 0, "x", true, [], [1]]) assert.deepEqual(asRecord(raw), {});
});

test("idArg: strings as they are, anything else as text", () => {
  assert.equal(idArg("abc"), "abc");
  assert.equal(idArg(undefined), "");
  assert.equal(idArg(null), "");
  assert.equal(idArg(42), "42");
});

test("boolOr and numberOr: only the right kind, else the fallback", () => {
  assert.equal(boolOr(false, true), false);
  assert.equal(boolOr("false", true), true);
  assert.equal(boolOr(1, false), false);
  assert.equal(numberOr(5, 1), 5);
  assert.equal(numberOr("5", 1), 1);
  assert.equal(numberOr(NaN, 1), 1);
  assert.equal(numberOr(Infinity, 1), 1);
});

test("recordList: a list of objects, or an error naming it", () => {
  assert.deepEqual(recordList([{ a: 1 }, {}], "Routines"), [{ a: 1 }, {}]);
  assert.deepEqual(recordList([], "Routines"), []);
  for (const raw of [undefined, null, {}, "x", [1], [null], [[]], [{}, "x"]])
    assert.throws(() => recordList(raw, "Routines"), /^Error: Routines must be a list\.$/);
});

test("mergeKnown: only known fields, only values of the same kind", () => {
  const current = { enabled: false, minutes: 30, name: "a", tags: ["x"], device: null as string | null };
  assert.deepEqual(mergeKnown(current, { enabled: true, minutes: 45, extra: "no" }), {
    ...current,
    enabled: true,
    minutes: 45,
  });
  // The wrong kind is ignored; a list never replaces a non-list or the other way round.
  assert.deepEqual(mergeKnown(current, { enabled: "yes", minutes: "45", tags: "x", name: ["b"] }), current);
  // null clears a nullable field, and a null field takes a value.
  assert.deepEqual(mergeKnown({ ...current, device: "phone" }, { device: null }).device, null);
  assert.equal(mergeKnown(current, { device: "phone" }).device, "phone");
  // Anything that isn't an object leaves it as it was.
  for (const raw of [undefined, null, 1, "x", [], [{ enabled: true }]])
    assert.equal(mergeKnown(current, raw), current);
  // A key from the prototype chain isn't a field.
  assert.equal("polluted" in mergeKnown(current, JSON.parse('{"__proto__": {"polluted": true}}')), false);
});
