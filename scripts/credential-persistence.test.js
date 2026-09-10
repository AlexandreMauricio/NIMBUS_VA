// End-to-end credential persistence test.
//
// This cannot live in the normal `node --test` suite: it exercises
// SecretStore, which needs Electron's safeStorage and a real `app`
// lifecycle. Run it with `npm run test:credentials` (also part of
// `npm run check`).
//
// It exists because of a bug that reached a user. loadSettings() read the
// credential store during startApp(), before `app` was ready — and
// safeStorage reports itself UNAVAILABLE that early, silently returning
// false rather than throwing. Every credential read back as unset, and
// the next save wrote that emptiness over the store, destroying the saved
// token.
//
// Shape of the test: this file is the plain-Node runner, and it drives
// real Electron child processes (one per app "launch") through the modes
// below. Separate processes are the whole point — the decisive case,
// `coldstart`, has to read settings BEFORE the ready event exactly as
// startApp does, and testing that in-process after ready would not
// reproduce the bug at all.
//
// Each launch shuts down with app.quit() rather than app.exit(): on
// Windows, Chromium's OSCrypt keeps its key in a `Local State` file that
// is only flushed on a clean shutdown, and without it every process
// encrypts under a different ephemeral key. Everything runs against a
// throwaway userData directory, so the developer's own settings.json and
// secrets.json are never touched.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN = "tok_secret_abc123";
const SETTINGS = path.join(__dirname, "..", "dist/settings/settingsManager.js");

// ---------------------------------------------------------------- child

if (process.env.NIMBUS_CREDTEST_MODE) {
  const { app } = require("electron");
  app.setPath("userData", process.env.NIMBUS_CREDTEST_USERDATA);
  const settings = require(SETTINGS);
  const mode = process.env.NIMBUS_CREDTEST_MODE;

  // Read settings here, at module scope, because that is where the real
  // app reads them: startApp() runs before the ready event.
  const loadedBeforeReady = settings.loadSettings();
  const tokenBeforeReady = loadedBeforeReady.userPreferences.tasks.accounts[0]?.apiToken ?? "";

  app.whenReady().then(() => {
    const report = { tokenBeforeReady };

    if (mode === "seed") {
      const s = settings.hydrateCredentials(loadedBeforeReady);
      s.userPreferences.tasks.accounts = [
        { id: "task-1", label: "Personal", provider: "todoist", apiToken: TOKEN, enabled: true },
      ];
      settings.saveSettings(s);
    } else if (mode === "coldstart") {
      // A normal launch: hydrate, then save as the app does for window
      // bounds shortly after startup.
      const s = settings.hydrateCredentials(loadedBeforeReady);
      report.tokenAfterHydrate = s.userPreferences.tasks.accounts[0]?.apiToken ?? "";
      settings.saveSettings(s);
    } else if (mode === "save-without-hydrating") {
      // The destructive path: something saves before hydration, so the
      // in-memory credentials are blanks.
      settings.saveSettings(loadedBeforeReady);
    } else if (mode === "remove-account") {
      const s = settings.hydrateCredentials(loadedBeforeReady);
      s.userPreferences.tasks.accounts = [];
      settings.saveSettings(s);
    }

    console.log("NIMBUS_CREDTEST_RESULT " + JSON.stringify(report));
    app.quit();
  });
  return;
}

// --------------------------------------------------------------- runner

const electron = require("electron"); // in plain Node this resolves to the binary path
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-credtest-"));

/** Runs one "app launch" and returns what it reported. */
function launch(mode) {
  const res = spawnSync(electron, [__filename], {
    env: { ...process.env, NIMBUS_CREDTEST_MODE: mode, NIMBUS_CREDTEST_USERDATA: TMP },
    encoding: "utf-8",
    // A child that throws before reaching app.quit() would otherwise
    // leave the runner waiting forever rather than failing.
    timeout: 60_000,
  });
  const line = (res.stdout || "").split("\n").find((l) => l.startsWith("NIMBUS_CREDTEST_RESULT "));
  if (!line) {
    throw new Error(`launch(${mode}) reported nothing.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  return JSON.parse(line.slice("NIMBUS_CREDTEST_RESULT ".length));
}

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
const secretsExist = () => fs.existsSync(path.join(TMP, "secrets.json"));
const settingsText = () => fs.readFileSync(path.join(TMP, "settings.json"), "utf-8");

try {
  // 1. A launch where the user adds an account and its token.
  launch("seed");
  check("the token is never written to settings.json", !settingsText().includes(TOKEN));
  check("the encrypted store was written", secretsExist());

  // 2. The regression: a real cold start, reading settings before ready.
  const cold = launch("coldstart");
  check(
    "loadSettings before app-ready yields no credential (it must not read the store)",
    cold.tokenBeforeReady === "",
    cold.tokenBeforeReady
  );
  check(
    "THE REGRESSION: the token survives a cold start",
    cold.tokenAfterHydrate === TOKEN,
    cold.tokenAfterHydrate
  );
  check("the store survives that launch's own save", secretsExist());

  // 3. A save from an un-hydrated settings object must not wipe the
  //    store, even though the credentials it holds are blank.
  launch("save-without-hydrating");
  check("a save before hydration leaves the store alone", secretsExist());
  const after = launch("coldstart");
  check(
    "the token is still intact after that save",
    after.tokenAfterHydrate === TOKEN,
    after.tokenAfterHydrate
  );

  // 4. An entry that can't be decrypted must survive a save. Before the
  //    fix, the account read as "no token", the launch's own save wrote
  //    the store without it, and a single failed decrypt was permanent.
  const secretsPath = path.join(TMP, "secrets.json");
  const stored = JSON.parse(fs.readFileSync(secretsPath, "utf-8"));
  const key = "tasks.task-1.apiToken";
  stored.secrets[key] = Buffer.from("not a real ciphertext").toString("base64");
  fs.writeFileSync(secretsPath, JSON.stringify(stored));
  const garbled = launch("coldstart");
  check(
    "an undecryptable credential reads as unset",
    garbled.tokenAfterHydrate === "",
    garbled.tokenAfterHydrate
  );
  const kept = JSON.parse(fs.readFileSync(secretsPath, "utf-8")).secrets[key];
  check("THE REGRESSION: a save keeps a credential it couldn't decrypt", kept === stored.secrets[key], kept);

  // 5. Genuinely removing the account does clear its secret.
  launch("remove-account");
  check("removing the account clears the store", !secretsExist());
} catch (err) {
  check("the test harness ran", false, String(err));
}

for (const r of results) {
  const detail = r.detail !== undefined && !r.pass ? "  got=" + JSON.stringify(r.detail) : "";
  console.log(`${r.pass ? "ok  " : "not ok"}  ${r.name}${detail}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`# pass ${results.length - failed}`);
console.log(`# fail ${failed}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
