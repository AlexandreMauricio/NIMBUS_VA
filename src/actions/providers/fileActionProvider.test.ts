import { test } from "node:test";
import assert from "node:assert/strict";
import { FileActionProvider, FILE_ACTIONS } from "./fileActionProvider";
import { FakeDesktop } from "./testing/fakeDesktop";

const DOC = "C:\\Users\\me\\Documents\\plan.pdf";
const DIR = "C:\\Users\\me\\Documents";

function setup() {
  const desktop = new FakeDesktop();
  return { desktop, provider: new FileActionProvider(desktop) };
}

test("lists open-file and open-folder under files.*, with picker hints and no confirmation", () => {
  const defs = setup().provider.listActions();
  assert.deepEqual(
    defs.map((d) => [d.id, d.parameters[0].format, d.requiresConfirmation, d.affectsService]),
    [
      ["files.openFile", "file", false, "files"],
      ["files.openFolder", "folder", false, "files"],
    ]
  );
});

test("openFile accepts a document path", () => {
  assert.equal(setup().provider.validate(FILE_ACTIONS.OPEN_FILE, { path: DOC }).valid, true);
});

test("openFile refuses programs, scripts and shortcuts, whatever the case", () => {
  const { provider } = setup();
  const exts = [
    ".exe",
    ".EXE",
    ".bat",
    ".cmd",
    ".ps1",
    ".vbs",
    ".js",
    ".msi",
    ".lnk",
    ".url",
    ".reg",
    ".scr",
    ".hta",
  ];
  for (const ext of exts) {
    const result = provider.validate(FILE_ACTIONS.OPEN_FILE, { path: `C:\\x\\file${ext}` });
    assert.equal(result.valid, false, ext);
    assert.match(result.error ?? "", /Launch an app/);
  }
});

test("both actions refuse relative or malformed paths", () => {
  const { provider } = setup();
  for (const action of [FILE_ACTIONS.OPEN_FILE, FILE_ACTIONS.OPEN_FOLDER]) {
    for (const path of [undefined, "", "Documents", ".\\plan.pdf", "C:\\x\\a.pdf:stream", "C:\\x\\a|b.pdf"]) {
      assert.equal(provider.validate(action, { path }).valid, false, `${action} ${String(path)}`);
    }
  }
});

test("openFile opens an existing file", async () => {
  const { desktop, provider } = setup();
  desktop.addFile(DOC);

  const result = await provider.execute(FILE_ACTIONS.OPEN_FILE, { path: DOC });

  assert.equal(result.status, "success");
  assert.equal(result.message, "Opened plan.pdf.");
  assert.deepEqual(desktop.calls, [`open ${DOC}`]);
});

test("openFolder opens an existing folder", async () => {
  const { desktop, provider } = setup();
  desktop.addFolder(DIR);

  const result = await provider.execute(FILE_ACTIONS.OPEN_FOLDER, { path: DIR });

  assert.equal(result.status, "success");
  assert.deepEqual(desktop.calls, [`open ${DIR}`]);
});

test("the wrong kind of thing, or nothing at all, is not_found and opens nothing", async () => {
  const { desktop, provider } = setup();
  desktop.addFile(DOC);
  desktop.addFolder(DIR);

  const fileAsFolder = await provider.execute(FILE_ACTIONS.OPEN_FOLDER, { path: DOC });
  const folderAsFile = await provider.execute(FILE_ACTIONS.OPEN_FILE, { path: DIR });
  const missing = await provider.execute(FILE_ACTIONS.OPEN_FILE, { path: "C:\\nope\\gone.pdf" });

  for (const result of [fileAsFolder, folderAsFile, missing]) {
    assert.equal(result.error?.category, "not_found");
  }
  assert.deepEqual(desktop.calls, []);
});

test("execute re-validates, so skipping validate still can't open an executable", async () => {
  const { desktop, provider } = setup();
  desktop.addFile("C:\\x\\setup.exe");

  const result = await provider.execute(FILE_ACTIONS.OPEN_FILE, { path: "C:\\x\\setup.exe" });

  assert.equal(result.error?.category, "invalid_parameters");
  assert.deepEqual(desktop.calls, []);
});

test("a platform failure becomes a structured failure", async () => {
  const { desktop, provider } = setup();
  desktop.addFile(DOC);
  desktop.failWith = new Error("no handler");

  const result = await provider.execute(FILE_ACTIONS.OPEN_FILE, { path: DOC });

  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "unknown");
});
