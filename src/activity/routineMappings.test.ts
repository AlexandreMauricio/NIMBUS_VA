import { test } from "node:test";
import assert from "node:assert/strict";
import { mappingsFromRoutines, knownActivityNames } from "./routineMappings";
import { detectActivity } from "./activityDetector";
import { Routine, validateRoutine } from "../routines/types";
import { ActivityMapping } from "./types";
import { WebsiteOpenedEvent } from "../events/types";

/**
 * A routine's own trigger doubling as an activity mapping — so an app or
 * website is configured once rather than twice.
 */

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    name: "Study",
    enabled: true,
    trigger: {
      type: "websiteOpened",
      matchField: "windowTitle",
      pattern: "Halo University",
      matchMode: "contains",
    },
    conditions: [],
    suggestion: { title: "Study?", message: "Start?", primaryLabel: "Yes", secondaryLabel: "No" },
    actions: [{ actionId: "demo.one", params: {} }],
    cooldownMinutes: 30,
    ...overrides,
  };
}

function siteEvent(windowTitle: string): WebsiteOpenedEvent {
  return {
    id: "e1",
    type: "websiteOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    browserExecutable: "chrome.exe",
    windowTitle,
    url: null,
    domain: null,
  };
}

test("a routine with no activity declared produces no mapping", () => {
  assert.deepEqual(mappingsFromRoutines([routine()]), []);
});

test("a website routine's trigger becomes a website mapping", () => {
  const [m] = mappingsFromRoutines([routine({ activity: { name: "Study", icon: "📚" } })]);

  assert.equal(m.activity, "Study");
  assert.equal(m.icon, "📚");
  assert.equal(m.source, "website");
  assert.equal(m.value, "Halo University", "the pattern comes from the trigger, not a second copy");
  assert.equal(m.matchMode, "contains");
});

test("an application routine's trigger becomes an application mapping", () => {
  const [m] = mappingsFromRoutines([
    routine({
      trigger: { type: "applicationOpened", application: "game.exe", matchMode: "exact" },
      activity: { name: "Gaming" },
    }),
  ]);

  assert.equal(m.source, "application");
  assert.equal(m.value, "game.exe");
  assert.equal(m.matchMode, "exact");
});

test("a folder routine's trigger becomes a folder mapping", () => {
  const [m] = mappingsFromRoutines([
    routine({
      trigger: { type: "folderOpened", path: "Projects", matchMode: "contains" },
      activity: { name: "Coding" },
    }),
  ]);

  assert.equal(m.source, "folder");
  assert.equal(m.value, "Projects");
});

test("a disabled routine declares nothing — it is off in every sense", () => {
  const mappings = mappingsFromRoutines([routine({ enabled: false, activity: { name: "Study" } })]);

  assert.deepEqual(mappings, []);
});

test("editing the routine's trigger moves the mapping with it — there is no stored copy to fall out of step", () => {
  const before = mappingsFromRoutines([routine({ activity: { name: "Study" } })])[0];
  const after = mappingsFromRoutines([
    routine({
      activity: { name: "Study" },
      trigger: {
        type: "websiteOpened",
        matchField: "windowTitle",
        pattern: "Somewhere Else",
        matchMode: "contains",
      },
    }),
  ])[0];

  assert.equal(before.value, "Halo University");
  assert.equal(after.value, "Somewhere Else");
  assert.equal(before.id, after.id, "the same routine keeps the same mapping id");
});

test("the derived mapping id is stable, so precedence never shifts between runs", () => {
  const first = mappingsFromRoutines([routine({ activity: { name: "Study" } })])[0];
  const second = mappingsFromRoutines([routine({ activity: { name: "Study" } })])[0];

  assert.equal(first.id, second.id);
  assert.equal(first.id, "routine:r1");
});

test("several routines each contribute their own mapping", () => {
  const mappings = mappingsFromRoutines([
    routine({ id: "a", activity: { name: "Study" } }),
    routine({
      id: "b",
      trigger: { type: "applicationOpened", application: "game.exe", matchMode: "exact" },
      activity: { name: "Gaming" },
    }),
  ]);

  assert.deepEqual(
    mappings.map((m) => m.activity),
    ["Study", "Gaming"]
  );
});

test("a routine-derived mapping actually drives detection", () => {
  const mappings = mappingsFromRoutines([routine({ activity: { name: "Study", icon: "📚" } })]);

  const match = detectActivity(siteEvent("Halo University - Course - Chrome"), mappings);

  assert.equal(match?.activity, "Study");
  assert.equal(match?.sourceValue, "Halo University", "the configured pattern, not the window title");
});

test("a specific routine mapping beats a broad standalone one at equal priority", () => {
  // The exact case this feature is for: the routine already names the
  // study site; a generic "any Chrome window is Browsing" rule must not
  // win over it.
  const broad: ActivityMapping = {
    id: "standalone",
    enabled: true,
    activity: "Browsing",
    source: "website",
    value: "chrome",
    matchMode: "contains",
    priority: 0,
  };
  const derived = mappingsFromRoutines([routine({ activity: { name: "Study" } })]);

  const match = detectActivity(siteEvent("Halo University - Chrome"), [...derived, broad]);

  assert.equal(match?.activity, "Study");
});

test("a standalone mapping still wins if the user gives it a higher priority", () => {
  const override: ActivityMapping = {
    id: "standalone",
    enabled: true,
    activity: "Browsing",
    source: "website",
    value: "chrome",
    matchMode: "contains",
    priority: 99,
  };
  const derived = mappingsFromRoutines([routine({ activity: { name: "Study" } })]);

  const match = detectActivity(siteEvent("Halo University - Chrome"), [...derived, override]);

  assert.equal(match?.activity, "Browsing", "explicit priority still has the final say");
});

// --------------------------------------------------------- validation

const KNOWN = ["demo.one"];

test("a routine activity needs a name", () => {
  const result = validateRoutine(routine({ activity: { name: "  " } }), KNOWN);
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /activity needs a name/);
});

test("a timer-completed trigger cannot define an activity", () => {
  const result = validateRoutine(
    routine({
      trigger: { type: "timerCompleted", timerType: "focus" },
      activity: { name: "Study" },
    }),
    KNOWN
  );
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /moment, not something you spend time doing/);
});

test("a routine with a valid activity passes validation", () => {
  assert.equal(validateRoutine(routine({ activity: { name: "Study", icon: "📚" } }), KNOWN).valid, true);
});

test("a routine with no activity field is still valid — nothing changes for existing routines", () => {
  assert.equal(validateRoutine(routine(), KNOWN).valid, true);
});

// ------------------------------------------------- known activity names

test("known activities come from both routines and standalone mappings", () => {
  const names = knownActivityNames(
    [routine({ id: "a", activity: { name: "Study" } })],
    [{ activity: "Gaming" }]
  );

  assert.deepEqual(names, ["Gaming", "Study"], "sorted, so the list is stable");
});

test("the same activity defined twice appears once, keeping the first spelling", () => {
  const names = knownActivityNames(
    [routine({ id: "a", activity: { name: "Study" } })],
    [{ activity: "study" }]
  );

  assert.deepEqual(names, ["Study"]);
});

test("a disabled routine still contributes its activity name", () => {
  // Turning a routine off shouldn't make other routines' references to
  // its activity look like they point at nothing.
  const names = knownActivityNames([routine({ id: "a", enabled: false, activity: { name: "Study" } })]);

  assert.deepEqual(names, ["Study"]);
});

test("routines with no activity contribute nothing", () => {
  assert.deepEqual(knownActivityNames([routine()]), []);
});

test("blank names are ignored rather than offered as a choice", () => {
  const names = knownActivityNames([routine({ id: "a", activity: { name: "   " } })], [{ activity: "" }]);

  assert.deepEqual(names, []);
});
