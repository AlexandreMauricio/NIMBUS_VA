import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTOSTART_FLAG, loginItemRegistration } from "./autostart";

const ELECTRON_EXE = "C:\\Users\\me\\NIMBUS_VA-main\\node_modules\\electron\\dist\\electron.exe";
const APP_DIR = "C:\\Users\\me\\NIMBUS VA";

test("THE REGRESSION: running from source, the login item carries the app path", () => {
  // Without it, Windows launches Electron with no app and the user gets
  // Electron's own welcome window at every sign-in.
  const registration = loginItemRegistration(true, {
    packaged: false,
    execPath: ELECTRON_EXE,
    appPath: APP_DIR,
  });

  assert.equal(registration.openAtLogin, true);
  assert.equal(registration.path, ELECTRON_EXE);
  assert.deepEqual(registration.args, [`"${APP_DIR}"`, AUTOSTART_FLAG]);
});

test("the app path is quoted, since a real one may contain spaces", () => {
  const { args } = loginItemRegistration(true, {
    packaged: false,
    execPath: ELECTRON_EXE,
    appPath: APP_DIR,
  });
  assert.ok(args[0].startsWith('"') && args[0].endsWith('"'), args[0]);
});

test("a packaged build registers itself, with no path to pass", () => {
  const registration = loginItemRegistration(true, {
    packaged: true,
    execPath: "C:\\Program Files\\NIMBUS\\nimbus.exe",
    appPath: "C:\\Program Files\\NIMBUS\\resources\\app.asar",
  });

  assert.equal(registration.openAtLogin, true);
  assert.equal(registration.path, undefined);
  assert.deepEqual(registration.args, [AUTOSTART_FLAG]);
});

test("turning it off leaves nothing to run", () => {
  for (const packaged of [true, false]) {
    const registration = loginItemRegistration(false, {
      packaged,
      execPath: ELECTRON_EXE,
      appPath: APP_DIR,
    });
    assert.equal(registration.openAtLogin, false);
    assert.deepEqual(registration.args, [], `packaged: ${packaged}`);
  }
});
