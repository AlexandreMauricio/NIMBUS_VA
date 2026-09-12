import { test } from "node:test";
import assert from "node:assert/strict";
import { SiteUsageState, SiteUsageTracker, siteFromTitle } from "./siteUsage";
import { ActivityMapping } from "./types";
import { frequentAppSignals } from "../attention/signals";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

test("the site name is the last part of a browser title", () => {
  const cases: Array<[string, string | null]> = [
    ["(12) Some video - YouTube - Google Chrome", "YouTube"],
    ["Inbox (3) - someone@example.com - Gmail - Google Chrome", "Gmail"],
    ["Pull requests · user/repo · GitHub — Mozilla Firefox", "GitHub"],
    ["Python (programming language) - Wikipedia - Personal - Microsoft​ Edge", "Wikipedia"],
    ["Docs and 3 more pages - Work - Microsoft Edge", "Docs"],
    ["ChatGPT - Brave", "ChatGPT"],
    ["Netflix - Opera", "Netflix"],
    ["New Tab - Google Chrome", null],
    ["Nova guia - Google Chrome", null],
    ["someone@example.com - Google Chrome", null],
    ["(3) - Google Chrome", null],
    ["A".repeat(60) + " - Google Chrome", null],
  ];
  for (const [title, expected] of cases) assert.equal(siteFromTitle(title), expected, title);
});

function setup(options: { mappings?: ActivityMapping[]; enabled?: boolean; saved?: unknown } = {}) {
  const clock = { now: new Date("2026-09-07T09:00:00Z") };
  const saves: SiteUsageState[] = [];
  const store = {
    load: () => options.saved ?? { sites: {} },
    save: (state: SiteUsageState) => saves.push(JSON.parse(JSON.stringify(state))),
  };
  const tracker = new SiteUsageTracker(
    () => options.enabled ?? true,
    () => options.mappings ?? [],
    () => clock.now,
    store,
    () => "UTC"
  );
  const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  /** Keeps a titled window open for `minutes`, polling every minute. */
  const browse = (title: string, minutes: number) => {
    for (let i = 0; i <= minutes; i++) {
      tracker.observe([{ executable: "chrome.exe", title }]);
      if (i < minutes) advance(MINUTE);
    }
    tracker.observe([]);
  };
  return { tracker, saves, advance, browse };
}

test("a site opened on 3 of the last 7 days is offered, under its name", () => {
  const { tracker, advance, browse } = setup();
  browse("Video one - YouTube - Google Chrome", 10);
  advance(DAY);
  browse("Video two - YouTube - Google Chrome", 10);
  assert.deepEqual(tracker.candidates(), [], "two days isn't enough");
  advance(DAY);
  browse("Video three - YouTube - Google Chrome", 10);

  const [site] = tracker.candidates();
  assert.equal(site.name, "YouTube");
  assert.equal(site.executable, "youtube");
  assert.equal(site.daysUsed, 3);
  assert.equal(site.minutesUsed, 30);
  assert.equal(site.source, "website");
});

test("or 5 hours in a week, even on one day", () => {
  const { tracker, browse } = setup();
  browse("Lecture - Coursera - Google Chrome", 5 * 60);
  assert.equal(tracker.candidates()[0]?.name, "Coursera");
});

test("different pages of one site add up; two windows of it count once", () => {
  const { tracker, advance } = setup();
  for (let i = 0; i <= 60; i++) {
    tracker.observe([
      { executable: "chrome.exe", title: `Page ${i} - Wikipedia - Google Chrome` },
      { executable: "msedge.exe", title: "Other - Wikipedia - Microsoft Edge" },
    ]);
    advance(MINUTE);
  }
  const state = JSON.stringify((tracker as unknown as { state: SiteUsageState }).state);
  assert.ok(state.includes('"wikipedia"'));
  assert.ok(!state.includes("Page 3"), "only the site name is kept, never the page");
});

test("a site that's already a website activity isn't offered", () => {
  const mapping: ActivityMapping = {
    id: "m1",
    enabled: false,
    activity: "Videos",
    source: "website",
    value: "youtube",
    matchMode: "contains",
    priority: 0,
  };
  const { tracker, browse } = setup({ mappings: [mapping] });
  browse("Video - YouTube - Google Chrome", 5 * 60);
  assert.deepEqual(tracker.candidates(), [], "even a switched-off activity counts as covered");
});

test("'Not now' rests a site for a week; twice means never", () => {
  const { tracker, advance, browse } = setup();
  browse("Lecture - Coursera - Google Chrome", 5 * 60);
  tracker.decline("coursera");
  assert.deepEqual(tracker.candidates(), []);
  advance(8 * DAY);
  browse("Lecture - Coursera - Google Chrome", 5 * 60);
  assert.equal(tracker.candidates().length, 1, "back after a week");
  tracker.decline("coursera");
  advance(8 * DAY);
  browse("Lecture - Coursera - Google Chrome", 5 * 60);
  assert.deepEqual(tracker.candidates(), []);
});

test("nothing is recorded while the option is off", () => {
  const { tracker, browse, saves } = setup({ enabled: false });
  browse("Lecture - Coursera - Google Chrome", 5 * 60);
  assert.deepEqual(tracker.candidates(), []);
  assert.deepEqual(saves, []);
});

test("a saved tally is read back, and malformed records are dropped", () => {
  const { tracker } = setup({
    saved: {
      sites: {
        coursera: {
          name: "Coursera",
          dayMinutes: { "2026-09-05": 200, "2026-09-06": 120, "not-a-day": 5, "2026-09-04": "lots" },
          lastOpenedAt: null,
          declines: 0,
          snoozedUntil: null,
          never: false,
        },
        broken: { dayMinutes: {} },
        worse: "nope",
      },
    },
  });
  const [site] = tracker.candidates();
  assert.equal(site.name, "Coursera");
  assert.equal(site.minutesUsed, 320);
  assert.equal(tracker.candidates().length, 1);
});

test("Attention asks about a website with its own key and a website follow-up", () => {
  const [signal] = frequentAppSignals(
    [
      {
        executable: "youtube",
        name: "YouTube",
        daysUsed: 4,
        minutesUsed: 200,
        justOpened: true,
        source: "website",
      },
    ],
    new Date("2026-09-11T10:00:00Z")
  );
  assert.equal(signal.key, "frequentApp:site:youtube");
  assert.equal(signal.title, "Make YouTube an activity?");
  assert.deepEqual(signal.followUp, {
    type: "createActivity",
    application: "youtube",
    name: "YouTube",
    source: "website",
  });
});

test("tabs that aren't a site - an address, search results, a new tab, NIMBUS - are ignored", () => {
  for (const title of [
    "youtube.com/watch?v=sMTsmIdumgI - Google Chrome",
    "https://example.com/page - Google Chrome",
    "Novo separador - Google Chrome",
    "cats - Pesquisa Google - Google Chrome",
    "cats - Google Search - Google Chrome",
    "Routines - NIMBUS - Google Chrome",
  ]) {
    assert.equal(siteFromTitle(title), null, title);
  }
  assert.equal(siteFromTitle("Some video - YouTube - Google Chrome"), "YouTube", "real sites still count");
});
