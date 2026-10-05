import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import Module from "module";

/**
 * Every IPC handler, run without Electron.
 *
 * `electron` is swapped for a stand-in before the ipc modules load, and
 * every service in IpcContext stops the handler when it is reached (with
 * `ServiceReached`). That leaves exactly the code these tests are about:
 * each handler's own reading of what the renderer sent, up to where it
 * hands that to a service — past that point it works on NIMBUS's own data.
 * The services check their own input in their own tests. Two promises are
 * checked for every channel registered:
 *
 * - a call from a page that isn't NIMBUS's is refused (handle.ts);
 * - arguments of the wrong kind — missing, null, numbers, strings, lists,
 *   objects — are narrowed or refused with a plain Error, never followed
 *   into a TypeError ("Cannot read properties of undefined"). That's the
 *   "every argument unknown" rule in input.ts, held to across all of them.
 */

type Listener = (event: unknown, ...args: unknown[]) => unknown;

/** Accepts any property read, call or `new`, and gives itself back. Never a promise, iterates as empty, counts as 0. */
function anything(): any {
  const proxy: any = new Proxy(() => undefined, {
    get(_target, key) {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === Symbol.iterator) return function* () {};
      if (key === "length") return 0;
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

/** Thrown by every stand-in service: the handler got as far as calling it. */
class ServiceReached extends Error {}

/** A service stand-in (or one of IpcContext's own functions): called, or any member called, throws ServiceReached. */
function service(): any {
  const reached = () => {
    throw new ServiceReached();
  };
  return new Proxy(reached, { get: (_target, key) => (key === "then" ? undefined : reached) });
}

/** A stand-in object: the listed members as given, anything else `anything()`. */
function partial(members: Record<string, unknown>): any {
  return new Proxy(members, {
    get: (target, key) => (key in target ? target[key as string] : key === "then" ? undefined : anything()),
  });
}

const handlers = new Map<string, Listener>();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-ipc-"));

const fakeElectron = partial({
  __esModule: undefined,
  ipcMain: { handle: (channel: string, listener: Listener) => handlers.set(channel, listener) },
  app: partial({
    getPath: () => userData,
    getVersion: () => "0.0.0",
    isPackaged: false,
    relaunch: () => {
      throw new Error("test: app.relaunch");
    },
    exit: () => {
      throw new Error("test: app.exit");
    },
  }),
  dialog: partial({
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 0 }),
  }),
  safeStorage: partial({ isEncryptionAvailable: () => false }),
  BrowserWindow: partial({
    getAllWindows: () => [],
    getFocusedWindow: () => null,
    fromWebContents: () => null,
  }),
});

const stubs: Record<string, unknown> = {
  electron: fakeElectron,
  "electron-updater": { autoUpdater: anything() },
};
const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = (request, ...rest) => (request in stubs ? stubs[request] : realLoad(request, ...rest));

// Nothing a handler does in these tests may reach the Internet.
globalThis.fetch = (async () => {
  throw new Error("test: no network");
}) as typeof fetch;

const trusted = {
  senderFrame: { url: pathToFileURL(path.join(__dirname, "..", "..", "ui", "index.html")).href },
};
const untrusted = { senderFrame: { url: "https://example.com/" } };

async function registerAll(): Promise<void> {
  if (handlers.size) return;
  const { DEFAULT_SETTINGS } = await import("../../settings/settingsSchema");
  const settings = structuredClone(DEFAULT_SETTINGS);
  const given: Record<string, unknown> = {
    settings,
    mainWindow: null,
    activityMonitor: null,
    appUsage: null,
    siteUsage: null,
    presenceService: null,
    coverAttempted: new Set<string>(),
  };
  const ctx: any = new Proxy(given, {
    get: (target, key) => (key in target ? target[key as string] : key === "then" ? undefined : service()),
  });
  const modules = [
    await import("./actions"),
    await import("./app"),
    await import("./books"),
    await import("./collections"),
    await import("./home"),
    await import("./integrations"),
    await import("./meals"),
    await import("./memory"),
    await import("./network"),
    await import("./popups"),
    await import("./routines"),
    await import("./stocks"),
  ];
  // What a module schedules at startup (the reading-credits queue's first
  // run) belongs to a running NIMBUS, not to these calls: held back.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (() => realSetTimeout(() => undefined, 0)) as unknown as typeof setTimeout;
  try {
    for (const mod of modules)
      for (const [name, register] of Object.entries(mod))
        if (name.startsWith("register") && typeof register === "function") register(ctx);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

/** What a renderer might send by mistake, or a page by design. */
const WRONG: unknown[] = [undefined, null, 0, -1, NaN, "", "x", true, [], [null], {}, { id: {} }, [[{}]]];

/** Channels whose whole job is a side effect the stand-ins can't absorb. */
const SKIPPED = new Set([
  // Restarts NIMBUS; dataTransfer's own checks run before it and are tested in bundle.test.ts.
  "nimbus:apply-import",
  // Quits the app.
  "nimbus:install-update",
]);

function isCrash(err: unknown): boolean {
  return err instanceof TypeError || err instanceof ReferenceError;
}

async function call(listener: Listener, event: unknown, args: unknown[]): Promise<unknown> {
  return await listener(event, ...args);
}

test("ipc: every module registers its channels, each under a unique nimbus: name", async () => {
  await registerAll();
  assert.ok(handlers.size > 150, `only ${handlers.size} channels registered`);
  for (const channel of handlers.keys()) assert.match(channel, /^nimbus:[a-z0-9-]+$/);
});

test("ipc: every channel refuses a page that isn't NIMBUS's", async () => {
  await registerAll();
  for (const [channel, listener] of handlers) {
    await assert.rejects(call(listener, untrusted, []), /Not allowed/, channel);
    await assert.rejects(call(listener, {}, []), /Not allowed/, `${channel}, no sender frame`);
  }
});

test("ipc: no channel crashes on arguments of the wrong kind", async () => {
  await registerAll();
  const crashes: string[] = [];
  for (const [channel, listener] of handlers) {
    if (SKIPPED.has(channel)) continue;
    const attempts: unknown[][] = [[]];
    for (const value of WRONG) {
      attempts.push([value, value, value, value]);
      attempts.push(["x", value, value, value]);
    }
    for (const args of attempts) {
      try {
        await call(listener, trusted, args);
      } catch (err) {
        if (isCrash(err)) {
          const shown = args.map((a) => (a === undefined ? "undefined" : JSON.stringify(a))).join(", ");
          crashes.push(`${channel}(${shown}): ${String(err)}`);
          break;
        }
      }
    }
  }
  assert.deepEqual(crashes, []);
});
