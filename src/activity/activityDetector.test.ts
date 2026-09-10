import { test } from "node:test";
import assert from "node:assert/strict";
import { detectActivity } from "./activityDetector";
import { ActivityMapping } from "./types";
import { ApplicationOpenedEvent, FolderOpenedEvent, WebsiteOpenedEvent } from "../events/types";

function mapping(overrides: Partial<ActivityMapping> = {}): ActivityMapping {
  return {
    id: "m1",
    enabled: true,
    activity: "Study",
    source: "application",
    value: "study.exe",
    matchMode: "exact",
    priority: 0,
    ...overrides,
  };
}

function appEvent(executableName: string): ApplicationOpenedEvent {
  return {
    id: "e1",
    type: "applicationOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName,
    windowTitle: null,
    activation: "launched",
  };
}

function siteEvent(windowTitle: string): WebsiteOpenedEvent {
  return {
    id: "e2",
    type: "websiteOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    browserExecutable: "chrome.exe",
    windowTitle,
    url: null,
    domain: null,
  };
}

function folderEvent(path: string): FolderOpenedEvent {
  return {
    id: "e3",
    type: "folderOpened",
    occurredAt: new Date().toISOString(),
    source: "test",
    path,
  };
}

test("an application maps to its configured activity", () => {
  const match = detectActivity(appEvent("study.exe"), [mapping()]);

  assert.equal(match?.activity, "Study");
  assert.equal(match?.source, "application");
  assert.equal(match?.sourceValue, "study.exe");
});

test("a website maps by window title", () => {
  const match = detectActivity(siteEvent("Course - MySchool - Chrome"), [
    mapping({ source: "website", value: "myschool", matchMode: "contains" }),
  ]);

  assert.equal(match?.activity, "Study");
});

test("a folder maps by path", () => {
  const match = detectActivity(folderEvent("C:\\Projects\\thing"), [
    mapping({ activity: "Coding", source: "folder", value: "projects", matchMode: "contains" }),
  ]);

  assert.equal(match?.activity, "Coding");
});

test("an unmapped application produces no activity", () => {
  assert.equal(detectActivity(appEvent("unknown.exe"), [mapping()]), null);
});

test("no mappings at all produces no activity", () => {
  assert.equal(detectActivity(appEvent("study.exe"), []), null);
});

test("a disabled mapping is ignored", () => {
  assert.equal(detectActivity(appEvent("study.exe"), [mapping({ enabled: false })]), null);
});

test("a mapping only matches its own source kind", () => {
  // A website rule must not match an application event that happens to
  // contain the same text.
  const website = mapping({ source: "website", value: "study", matchMode: "contains" });

  assert.equal(detectActivity(appEvent("study.exe"), [website]), null);
});

test("comma-separated alternatives all map to the same activity", () => {
  const games = mapping({ activity: "Gaming", value: "gamea.exe, gameb.exe" });

  assert.equal(detectActivity(appEvent("gamea.exe"), [games])?.activity, "Gaming");
  assert.equal(detectActivity(appEvent("gameb.exe"), [games])?.activity, "Gaming");
  assert.equal(detectActivity(appEvent("gamec.exe"), [games]), null);
});

test("higher priority wins when two rules match", () => {
  // The generic browser rule and the specific site rule both match.
  const browsing = mapping({
    id: "generic",
    activity: "Browsing",
    source: "website",
    value: "chrome",
    matchMode: "contains",
    priority: 0,
  });
  const study = mapping({
    id: "specific",
    activity: "Study",
    source: "website",
    value: "myschool",
    matchMode: "contains",
    priority: 10,
  });

  const match = detectActivity(siteEvent("MySchool course - Chrome"), [browsing, study]);

  assert.equal(match?.activity, "Study");
});

test("priority wins regardless of the order the mappings are listed in", () => {
  const browsing = mapping({ id: "a", activity: "Browsing", value: "app.exe", priority: 0 });
  const study = mapping({ id: "b", activity: "Study", value: "app.exe", priority: 5 });

  assert.equal(detectActivity(appEvent("app.exe"), [browsing, study])?.activity, "Study");
  assert.equal(detectActivity(appEvent("app.exe"), [study, browsing])?.activity, "Study");
});

test("with equal priority, the more specific pattern wins", () => {
  // Someone who never sets a priority should still get the sensible
  // answer rather than whichever happens to be first.
  const broad = mapping({
    id: "a",
    activity: "Browsing",
    source: "website",
    value: "chrome",
    matchMode: "contains",
  });
  const narrow = mapping({
    id: "b",
    activity: "Study",
    source: "website",
    value: "myschool course",
    matchMode: "contains",
  });

  const match = detectActivity(siteEvent("MySchool course - Chrome"), [broad, narrow]);

  assert.equal(match?.activity, "Study");
});

test("a fully ambiguous pair still resolves the same way every time", () => {
  const a = mapping({ id: "aaa", activity: "One", value: "app.exe" });
  const b = mapping({ id: "bbb", activity: "Two", value: "app.exe" });

  const first = detectActivity(appEvent("app.exe"), [a, b])?.activity;
  const second = detectActivity(appEvent("app.exe"), [b, a])?.activity;

  assert.equal(first, second, "the answer must not depend on list order");
});

test("closing and timer events yield no activity", () => {
  const closed = {
    id: "e4",
    type: "applicationClosed" as const,
    occurredAt: new Date().toISOString(),
    source: "test",
    executableName: "study.exe",
  };

  assert.equal(detectActivity(closed, [mapping()]), null);
});

test("detection reports which mapping decided, for debugging", () => {
  const match = detectActivity(appEvent("study.exe"), [mapping({ id: "the-one" })]);

  assert.equal(match?.mappingId, "the-one");
});

test("the icon travels with the activity", () => {
  const match = detectActivity(appEvent("study.exe"), [mapping({ icon: "📚" })]);

  assert.equal(match?.icon, "📚");
});
