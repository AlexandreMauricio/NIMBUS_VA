import { test } from "node:test";
import assert from "node:assert/strict";
import { AppActionProvider, APP_ACTIONS } from "./appActionProvider";
import { ActionService } from "../actionService";
import { FakeDesktop } from "./testing/fakeDesktop";

const DISCORD = "C:\\Apps\\Discord\\Discord.exe";

function setup() {
  const desktop = new FakeDesktop();
  return { desktop, provider: new AppActionProvider(desktop) };
}

// ------------------------------------------------------------ registration

test("lists launch plus the four window actions, all under app.*", () => {
  const { provider } = setup();
  assert.deepEqual(
    provider.listActions().map((a) => a.id),
    ["app.launch", "app.focus", "app.minimize", "app.maximize", "app.close"]
  );
  for (const def of provider.listActions()) {
    assert.equal(def.affectsService, "applications");
    assert.equal(def.changesExternalState, true);
    assert.equal(def.readOnly, false);
  }
});

test("launching and closing are flagged for confirmation; arranging windows is not", () => {
  const byId = Object.fromEntries(
    setup()
      .provider.listActions()
      .map((a) => [a.id, a.requiresConfirmation])
  );
  assert.deepEqual(byId, {
    "app.launch": true,
    "app.focus": false,
    "app.minimize": false,
    "app.maximize": false,
    "app.close": true,
  });
});

test("launch's path parameter asks the editor for an application picker", () => {
  const launch = setup()
    .provider.listActions()
    .find((a) => a.id === APP_ACTIONS.LAUNCH)!;
  assert.equal(launch.parameters[0].format, "application");
});

// -------------------------------------------------------------- validation

test("launch accepts a full path to an .exe or a .lnk shortcut", () => {
  const { provider } = setup();
  assert.equal(provider.validate(APP_ACTIONS.LAUNCH, { path: DISCORD }).valid, true);
  assert.equal(
    provider.validate(APP_ACTIONS.LAUNCH, {
      path: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Discord.lnk",
    }).valid,
    true
  );
});

test("launch refuses anything that isn't a full path to an .exe or .lnk", () => {
  const { provider } = setup();
  const refused = [
    undefined,
    "",
    "Discord.exe",
    "discord",
    "C:\\Apps\\notes.txt",
    "C:\\Apps\\run.bat",
    "C:\\Apps\\a.exe:hidden",
    'C:\\Apps\\"x".exe',
    "C:\\Apps\\app.exe --flag|more",
    "cmd /c del *",
  ];
  for (const path of refused) {
    assert.equal(provider.validate(APP_ACTIONS.LAUNCH, { path }).valid, false, String(path));
  }
});

test("window actions take a plain process name, with or without .exe", () => {
  const { provider } = setup();
  for (const processName of ["discord", "Discord.exe", "Microsoft Teams", "steam_webhelper"]) {
    assert.equal(provider.validate(APP_ACTIONS.FOCUS, { processName }).valid, true, processName);
  }
});

test("window actions refuse wildcards, separators and anything command-like", () => {
  const { provider } = setup();
  const refused = [
    undefined,
    "",
    "*",
    "chrome*",
    "a;Stop-Computer",
    "$(calc)",
    "..\\x",
    "name'quote",
    "a".repeat(70),
  ];
  for (const processName of refused) {
    assert.equal(provider.validate(APP_ACTIONS.CLOSE, { processName }).valid, false, String(processName));
  }
});

// --------------------------------------------------------------- execution

test("launch starts an application that exists", async () => {
  const { desktop, provider } = setup();
  desktop.addFile(DISCORD);

  const result = await provider.execute(APP_ACTIONS.LAUNCH, { path: DISCORD });

  assert.equal(result.status, "success");
  assert.equal(result.message, "Started Discord.exe.");
  assert.deepEqual(desktop.calls, [`launch ${DISCORD}`]);
});

test("launch reports not_found for a missing application and starts nothing", async () => {
  const { desktop, provider } = setup();

  const result = await provider.execute(APP_ACTIONS.LAUNCH, { path: DISCORD });

  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_found");
  assert.deepEqual(desktop.calls, []);
});

test("launch reports not_found when the path is a folder", async () => {
  const { desktop, provider } = setup();
  desktop.addFolder("C:\\Apps\\Tool.exe");

  const result = await provider.execute(APP_ACTIONS.LAUNCH, { path: "C:\\Apps\\Tool.exe" });

  assert.equal(result.error?.category, "not_found");
  assert.deepEqual(desktop.calls, []);
});

test("execute re-validates, so skipping validate still can't launch a script", async () => {
  const { desktop, provider } = setup();
  desktop.addFile("C:\\x\\evil.bat");

  const result = await provider.execute(APP_ACTIONS.LAUNCH, { path: "C:\\x\\evil.bat" });

  assert.equal(result.error?.category, "invalid_parameters");
  assert.deepEqual(desktop.calls, []);
});

test("a platform failure becomes a structured failure, never a throw", async () => {
  const { desktop, provider } = setup();
  desktop.addFile(DISCORD);
  desktop.failWith = new Error("boom");

  const result = await provider.execute(APP_ACTIONS.LAUNCH, { path: DISCORD });

  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "unknown");
  assert.doesNotMatch(result.error?.message ?? "", /boom/, "raw errors stay out of user-facing text");
});

test("a window action on an app with no open window reports not_found", async () => {
  const { provider } = setup();

  const result = await provider.execute(APP_ACTIONS.MINIMIZE, { processName: "discord" });

  assert.equal(result.error?.category, "not_found");
  assert.equal(result.error?.message, "discord has no open window.");
});

test("a window action normalizes the name and reports what it did", async () => {
  const { desktop, provider } = setup();
  desktop.windows.set("discord", 1);

  const result = await provider.execute(APP_ACTIONS.MINIMIZE, { processName: "discord.exe" });

  assert.equal(result.status, "success");
  assert.equal(result.message, "Minimized discord.");
  assert.deepEqual(desktop.calls, ["minimize discord"]);
});

test("close asks the app to close rather than forcing it", async () => {
  const { desktop, provider } = setup();
  desktop.windows.set("notepad", 2);

  const result = await provider.execute(APP_ACTIONS.CLOSE, { processName: "notepad" });

  assert.equal(result.message, "Asked notepad to close.");
  assert.deepEqual(result.data, { processName: "notepad", windows: 2 });
  assert.deepEqual(desktop.calls, ["close notepad"]);
});

test("through ActionService, a command-like name never reaches the platform", async () => {
  const { desktop, provider } = setup();
  const service = new ActionService();
  service.register(provider);

  const result = await service.executeAction("app.focus", { processName: "x; Stop-Process" });

  assert.equal(result.error?.category, "invalid_parameters");
  assert.deepEqual(desktop.calls, []);
});
