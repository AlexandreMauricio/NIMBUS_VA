import { test } from "node:test";
import assert from "node:assert/strict";
import { diffActivitySnapshot, emptySnapshot, RawActivitySnapshot } from "./activitySnapshot";

const NOW = new Date("2026-09-09T12:00:00Z");

function snapshot(overrides: Partial<RawActivitySnapshot> = {}): RawActivitySnapshot {
  return { ...emptySnapshot(), ...overrides };
}

test("a newly appeared process produces an applicationOpened(launched) event", () => {
  const events = diffActivitySnapshot(emptySnapshot(), snapshot({ processNames: ["steam.exe"] }), NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "applicationOpened");
  assert.equal((events[0] as { executableName: string }).executableName, "steam.exe");
  assert.equal((events[0] as { activation: string }).activation, "launched");
});

test("a process that was already running in the previous snapshot does not re-fire", () => {
  const previous = snapshot({ processNames: ["steam.exe"] });
  const events = diffActivitySnapshot(previous, snapshot({ processNames: ["steam.exe"] }), NOW);
  assert.equal(events.length, 0);
});

test("a process still running across many consecutive polls never fires (no spam) — including across the initial baseline poll", () => {
  let previous: RawActivitySnapshot | null = null;
  let totalEvents = 0;
  const current = snapshot({ processNames: ["steam.exe"] });
  for (let i = 0; i < 5; i++) {
    totalEvents += diffActivitySnapshot(previous, current, NOW).length;
    previous = current;
  }
  assert.equal(totalEvents, 0);
});

test("the first poll (no previous snapshot) produces no events — it only establishes a baseline", () => {
  const events = diffActivitySnapshot(null, snapshot({ processNames: ["a.exe", "b.exe"] }), NOW);
  assert.equal(events.length, 0);
});

test("a process already running at baseline does not fire once a real second poll happens", () => {
  const baseline = snapshot({ processNames: ["steam.exe"] });
  diffActivitySnapshot(null, baseline, NOW); // establishes the baseline, no events
  const events = diffActivitySnapshot(baseline, snapshot({ processNames: ["steam.exe"] }), NOW);
  assert.equal(events.length, 0);
});

test("a browser already open on the very first poll DOES fire (unlike processes/folders) — the 'site already open, then routine configured' case", () => {
  const events = diffActivitySnapshot(
    null,
    snapshot({
      browserWindows: [{ executable: "chrome.exe", title: "Home - SkillCertPro - Google Chrome" }],
    }),
    NOW
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "websiteOpened");
});

test("an already-open folder is still suppressed on the very first poll, unlike browser windows", () => {
  const events = diffActivitySnapshot(null, snapshot({ explorerFolders: ["C:\\Projects"] }), NOW);
  assert.equal(events.length, 0);
});

test("an already-running process is still suppressed on the very first poll even when a browser window also fires that same poll", () => {
  const events = diffActivitySnapshot(
    null,
    snapshot({
      processNames: ["steam.exe"],
      browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }],
    }),
    NOW
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "websiteOpened");
});

test("a browser window with a new title produces a websiteOpened event", () => {
  const events = diffActivitySnapshot(
    emptySnapshot(),
    snapshot({ browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }] }),
    NOW
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "websiteOpened");
  assert.equal((events[0] as { windowTitle: string }).windowTitle, "SkillCert - Google Chrome");
});

test("an unchanged browser title does not re-fire on the next poll", () => {
  const previous = snapshot({
    browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }],
  });
  const events = diffActivitySnapshot(
    previous,
    snapshot({ browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }] }),
    NOW
  );
  assert.equal(events.length, 0);
});

test("a changed browser title (e.g. switched tab) fires again", () => {
  const previous = snapshot({
    browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }],
  });
  const events = diffActivitySnapshot(
    previous,
    snapshot({ browserWindows: [{ executable: "chrome.exe", title: "YouTube - Google Chrome" }] }),
    NOW
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as { windowTitle: string }).windowTitle, "YouTube - Google Chrome");
});

test("re-visiting the same site after navigating away fires again (title changed and changed back)", () => {
  let previous = snapshot({
    browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }],
  });
  const away = snapshot({ browserWindows: [{ executable: "chrome.exe", title: "YouTube - Google Chrome" }] });
  diffActivitySnapshot(previous, away, NOW);
  previous = away;
  const back = snapshot({
    browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }],
  });
  const events = diffActivitySnapshot(previous, back, NOW);
  assert.equal(events.length, 1);
});

test("a newly opened Explorer folder produces a folderOpened event", () => {
  const events = diffActivitySnapshot(
    emptySnapshot(),
    snapshot({ explorerFolders: ["C:\\Projects\\NIMBUS"] }),
    NOW
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "folderOpened");
  assert.equal((events[0] as { path: string }).path, "C:\\Projects\\NIMBUS");
});

test("an already-open folder does not re-fire", () => {
  const previous = snapshot({ explorerFolders: ["C:\\Projects\\NIMBUS"] });
  const events = diffActivitySnapshot(previous, snapshot({ explorerFolders: ["C:\\Projects\\NIMBUS"] }), NOW);
  assert.equal(events.length, 0);
});

test("multiple simultaneous changes each produce their own event", () => {
  const events = diffActivitySnapshot(
    emptySnapshot(),
    snapshot({
      processNames: ["steam.exe"],
      browserWindows: [{ executable: "chrome.exe", title: "SkillCert - Google Chrome" }],
      explorerFolders: ["C:\\Projects"],
    }),
    NOW
  );
  assert.equal(events.length, 3);
  const types = events.map((e) => e.type).sort();
  assert.deepEqual(types, ["applicationOpened", "folderOpened", "websiteOpened"]);
});

test("a browser window with an empty title is ignored rather than producing a bogus event", () => {
  const events = diffActivitySnapshot(
    emptySnapshot(),
    snapshot({ browserWindows: [{ executable: "chrome.exe", title: "" }] }),
    NOW
  );
  assert.equal(events.length, 0);
});

/* --------- applicationClosed: the signal that ends a routine session --------- */

test("a process disappearing produces an applicationClosed event", () => {
  const previous = snapshot({ processNames: ["steam.exe", "chrome.exe"] });
  const current = snapshot({ processNames: ["chrome.exe"] });

  const events = diffActivitySnapshot(previous, current, NOW);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "applicationClosed");
  assert.equal((events[0] as { executableName: string }).executableName, "steam.exe");
});

test("the baseline poll reports nothing as closed", () => {
  const events = diffActivitySnapshot(null, snapshot({ processNames: ["steam.exe"] }), NOW);

  assert.equal(
    events.some((e) => e.type === "applicationClosed"),
    false
  );
});

test("a process that keeps running produces no close event", () => {
  const previous = snapshot({ processNames: ["steam.exe"] });
  const events = diffActivitySnapshot(previous, snapshot({ processNames: ["steam.exe"] }), NOW);

  assert.equal(events.length, 0);
});

test("closing one application and opening another reports both", () => {
  const previous = snapshot({ processNames: ["steam.exe"] });
  const events = diffActivitySnapshot(previous, snapshot({ processNames: ["game.exe"] }), NOW);

  const kinds = events.map((e) => e.type).sort();
  assert.deepEqual(kinds, ["applicationClosed", "applicationOpened"]);
});
