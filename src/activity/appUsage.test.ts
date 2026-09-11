import { test } from "node:test";
import assert from "node:assert/strict";
import { AppUsageState, AppUsageStateStore, AppUsageTracker } from "./appUsage";
import { ActivityMapping } from "./types";

const DAY = 24 * 60 * 60_000;

function setup(options: { enabled?: boolean; mappings?: ActivityMapping[]; saved?: AppUsageState } = {}) {
  const clock = { now: new Date("2026-09-11T10:00:00Z") };
  const settings = { enabled: options.enabled ?? true };
  const saves: AppUsageState[] = [];
  const store: AppUsageStateStore = {
    load: () => options.saved ?? { apps: {} },
    save: (state) => saves.push(JSON.parse(JSON.stringify(state))),
  };
  const tracker = new AppUsageTracker(
    () => settings.enabled,
    () => options.mappings ?? [],
    () => clock.now,
    store,
    () => "UTC"
  );
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  const halo = [{ executable: "haloinfinite.exe", description: "Halo Infinite" }];
  /** The game open for `minutes`, polled every 5 s, then closed. */
  const play = (minutes: number) => {
    for (let s = 0; s <= minutes * 60; s += 5) {
      tracker.observe(halo);
      advance(5_000);
    }
    tracker.observe([]);
  };
  return { tracker, settings, clock, advance, saves, play };
}

test("an app used on three days of the week becomes a candidate, named as Windows names it", () => {
  const { tracker, advance, play } = setup();
  play(10);
  advance(DAY);
  play(10);
  assert.deepEqual(tracker.candidates(), [], "two days isn't enough yet");
  advance(DAY);
  play(10);

  const [halo] = tracker.candidates();
  assert.equal(halo.executable, "haloinfinite.exe");
  assert.equal(halo.name, "Halo Infinite");
  assert.equal(halo.daysUsed, 3);
  assert.equal(halo.minutesUsed, 30);
  assert.equal(halo.justOpened, false, "it's closed now");
});

test("five hours in a single day is enough too", () => {
  const { tracker, play } = setup();
  play(5 * 60);
  assert.equal(tracker.candidates()[0]?.minutesUsed, 300);
});

test("just opened means opened a moment ago and still open", () => {
  const { tracker, advance, play } = setup();
  play(10);
  advance(DAY);
  play(10);
  advance(DAY);
  play(10);
  advance(60_000);

  tracker.observe([{ executable: "haloinfinite.exe", description: "Halo Infinite" }]);
  assert.equal(tracker.candidates()[0].justOpened, true);
  advance(3 * 60_000);
  tracker.observe([{ executable: "haloinfinite.exe", description: "Halo Infinite" }]);
  assert.equal(tracker.candidates()[0].justOpened, false, "no longer a moment ago");
});

test("a long gap between polls (sleep) counts as a minute at most", () => {
  const { tracker, advance } = setup();
  const halo = [{ executable: "haloinfinite.exe", description: null }];
  tracker.observe(halo);
  advance(3 * 60 * 60_000);
  tracker.observe(halo);
  tracker.observe([]);
  advance(DAY);
  tracker.observe(halo);
  tracker.observe([]);
  advance(DAY);
  tracker.observe(halo);
  const [app] = tracker.candidates();
  assert.equal(app.minutesUsed, 1);
  assert.equal(app.name, "haloinfinite", "no description: the executable name");
});

test("shell windows, browsers and NIMBUS itself are never counted", () => {
  const { tracker, play } = setup();
  tracker.observe([
    { executable: "explorer.exe", description: "Windows Explorer" },
    { executable: "chrome.exe", description: "Google Chrome" },
    { executable: "electron.exe", description: "Electron" },
  ]);
  play(6 * 60);
  assert.deepEqual(
    tracker.candidates().map((c) => c.executable),
    ["haloinfinite.exe"]
  );
});

test("an app that is already an activity is never suggested — even if that activity is switched off", () => {
  const mapping: ActivityMapping = {
    id: "m1",
    enabled: false,
    activity: "Gaming",
    source: "application",
    value: "haloinfinite.exe",
    matchMode: "exact",
    priority: 0,
  };
  const { tracker, play } = setup({ mappings: [mapping] });
  play(6 * 60);
  assert.deepEqual(tracker.candidates(), []);
});

test("'Not now' rests an app for a week; a second 'Not now' means never", () => {
  const { tracker, advance, play } = setup();
  play(6 * 60);
  tracker.decline("haloinfinite.exe");
  assert.deepEqual(tracker.candidates(), []);

  advance(8 * DAY);
  play(6 * 60);
  assert.equal(tracker.candidates().length, 1, "back after the week");

  tracker.decline("haloinfinite.exe");
  advance(30 * DAY);
  play(6 * 60);
  assert.deepEqual(tracker.candidates(), [], "never again");
});

test("'Yes' rests it for a week, in case no activity was saved after all", () => {
  const { tracker, advance, play } = setup();
  play(6 * 60);
  tracker.accept("haloinfinite.exe");
  assert.deepEqual(tracker.candidates(), []);
  advance(8 * DAY);
  play(6 * 60);
  assert.equal(tracker.candidates().length, 1);
});

test("while switched off, nothing is recorded and nothing suggested", () => {
  const { tracker, settings, play, saves } = setup({ enabled: false });
  play(6 * 60);
  settings.enabled = true;
  assert.deepEqual(tracker.candidates(), []);
  assert.deepEqual(saves, []);
});

test("answers and usage survive a restart; days older than two weeks are dropped", () => {
  const first = setup();
  first.play(6 * 60);
  first.tracker.decline("haloinfinite.exe");
  first.tracker.decline("haloinfinite.exe");
  const saved = first.saves[first.saves.length - 1];
  assert.equal(saved.apps["haloinfinite.exe"].never, true);

  const restarted = setup({ saved });
  restarted.play(6 * 60);
  assert.deepEqual(restarted.tracker.candidates(), [], "the 'never' was remembered");

  const old = setup({
    saved: {
      apps: {
        "old.exe": {
          name: "Old",
          dayMinutes: { "2026-08-01": 500 },
          lastOpenedAt: null,
          declines: 0,
          snoozedUntil: null,
          never: false,
        },
      },
    },
  });
  old.tracker.observe([]);
  old.tracker.flush();
  assert.equal(old.saves[old.saves.length - 1].apps["old.exe"], undefined);
});
