import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesTrigger } from "./triggerMatcher";
import { ApplicationTriggerConfig, FolderTriggerConfig, WebsiteTriggerConfig } from "./types";
import { ApplicationOpenedEvent, FolderOpenedEvent, WebsiteOpenedEvent } from "../events/types";

function appEvent(overrides: Partial<ApplicationOpenedEvent> = {}): ApplicationOpenedEvent {
  return {
    id: "e1",
    type: "applicationOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName: "steam.exe",
    windowTitle: null,
    activation: "launched",
    ...overrides,
  };
}

function websiteEvent(overrides: Partial<WebsiteOpenedEvent> = {}): WebsiteOpenedEvent {
  return {
    id: "e2",
    type: "websiteOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    browserExecutable: "chrome.exe",
    windowTitle: "SkillCert - Learn to code - Google Chrome",
    url: null,
    domain: null,
    ...overrides,
  };
}

function folderEvent(overrides: Partial<FolderOpenedEvent> = {}): FolderOpenedEvent {
  return {
    id: "e3",
    type: "folderOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    path: "C:\\Users\\me\\Projects\\NIMBUS",
    ...overrides,
  };
}

function appTrigger(overrides: Partial<ApplicationTriggerConfig> = {}): ApplicationTriggerConfig {
  return { type: "applicationOpened", application: "steam.exe", matchMode: "exact", ...overrides };
}

function websiteTrigger(overrides: Partial<WebsiteTriggerConfig> = {}): WebsiteTriggerConfig {
  return {
    type: "websiteOpened",
    matchField: "windowTitle",
    pattern: "skillcert",
    matchMode: "contains",
    ...overrides,
  };
}

function folderTrigger(overrides: Partial<FolderTriggerConfig> = {}): FolderTriggerConfig {
  return { type: "folderOpened", path: "Projects", matchMode: "contains", ...overrides };
}

test("an application trigger matches on exact executable name (case-insensitive)", () => {
  assert.equal(
    matchesTrigger(appEvent({ executableName: "Steam.exe" }), appTrigger({ application: "steam.exe" })),
    true
  );
});

test("an application trigger with exact mode does not match a different executable", () => {
  assert.equal(matchesTrigger(appEvent({ executableName: "notepad.exe" }), appTrigger()), false);
});

test("an application trigger with contains mode matches a substring", () => {
  assert.equal(
    matchesTrigger(
      appEvent({ executableName: "unityhub.exe" }),
      appTrigger({ application: "unity", matchMode: "contains" })
    ),
    true
  );
});

test("a website trigger matches the window title heuristic by contains", () => {
  assert.equal(
    matchesTrigger(
      websiteEvent({ windowTitle: "SkillCert - Google Chrome" }),
      websiteTrigger({ matchField: "windowTitle" })
    ),
    true
  );
});

test("a website trigger does not match when the pattern isn't present", () => {
  assert.equal(
    matchesTrigger(
      websiteEvent({ windowTitle: "YouTube - Google Chrome" }),
      websiteTrigger({ matchField: "windowTitle" })
    ),
    false
  );
});

test("a website trigger matching on domain fails cleanly when the event has no domain (heuristic detector limitation)", () => {
  assert.equal(
    matchesTrigger(
      websiteEvent({ domain: null }),
      websiteTrigger({ matchField: "domain", pattern: "skillcert.com" })
    ),
    false
  );
});

test("a website trigger matching on domain succeeds when a producer does supply one (exact mode)", () => {
  assert.equal(
    matchesTrigger(
      websiteEvent({ domain: "skillcert.com" }),
      websiteTrigger({ matchField: "domain", pattern: "skillcert.com", matchMode: "exact" })
    ),
    true
  );
});

test("a folder trigger matches a path substring", () => {
  assert.equal(matchesTrigger(folderEvent(), folderTrigger({ path: "projects" })), true);
});

test("a folder trigger with exact mode requires the full path to match", () => {
  assert.equal(
    matchesTrigger(
      folderEvent({ path: "C:\\Projects" }),
      folderTrigger({ path: "C:\\Projects", matchMode: "exact" })
    ),
    true
  );
  assert.equal(
    matchesTrigger(
      folderEvent({ path: "C:\\Projects\\Sub" }),
      folderTrigger({ path: "C:\\Projects", matchMode: "exact" })
    ),
    false
  );
});

test("an event never matches a trigger of a different type", () => {
  assert.equal(matchesTrigger(appEvent(), websiteTrigger()), false);
  assert.equal(matchesTrigger(websiteEvent(), appTrigger()), false);
  assert.equal(matchesTrigger(folderEvent(), appTrigger()), false);
});

test("a website trigger's pattern accepts comma-separated alternatives, matching any one of them", () => {
  const trigger = websiteTrigger({ pattern: "skillcert,nowuniversity" });
  assert.equal(matchesTrigger(websiteEvent({ windowTitle: "SkillCert - Google Chrome" }), trigger), true);
  assert.equal(matchesTrigger(websiteEvent({ windowTitle: "NowUniversity - Google Chrome" }), trigger), true);
  assert.equal(matchesTrigger(websiteEvent({ windowTitle: "YouTube - Google Chrome" }), trigger), false);
});

test("comma-separated alternatives tolerate surrounding whitespace and stray commas", () => {
  const trigger = websiteTrigger({ pattern: " skillcert , , nowuniversity ," });
  assert.equal(matchesTrigger(websiteEvent({ windowTitle: "NowUniversity - Google Chrome" }), trigger), true);
});

test("an application trigger's pattern also accepts comma-separated alternatives", () => {
  const trigger = appTrigger({ application: "steam.exe,epicgameslauncher.exe", matchMode: "exact" });
  assert.equal(matchesTrigger(appEvent({ executableName: "epicgameslauncher.exe" }), trigger), true);
  assert.equal(matchesTrigger(appEvent({ executableName: "origin.exe" }), trigger), false);
});

test("a folder trigger's path also accepts comma-separated alternatives", () => {
  const trigger = folderTrigger({ path: "Projects,Coursework" });
  assert.equal(matchesTrigger(folderEvent({ path: "C:\\Users\\me\\Coursework\\NIMBUS" }), trigger), true);
});
