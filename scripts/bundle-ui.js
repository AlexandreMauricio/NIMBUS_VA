// Bundles the renderer entry points into plain, self-contained browser
// scripts.
//
// Why this exists: the renderer runs with `nodeIntegration: false` and
// `contextIsolation: true`, so there is no `require` in that context.
// tsc emits CommonJS for the whole project (which main/ and preload/
// need), so the moment a renderer file gains an `import`, its compiled
// output calls `require` and the UI dies on load. Until now that was
// avoided by keeping each renderer a single import-free script — which
// also meant none of their logic could be imported by a test.
//
// esbuild resolves the imports at build time and emits one flat IIFE per
// entry point, so the renderers can be split into real modules (see
// uiFormat.ts) while the browser still receives exactly what it did
// before: one plain script per window, no module loader, nothing for the
// CSP's `script-src 'self'` to object to.
//
// Runs after tsc, overwriting tsc's own CommonJS output for these three
// files. tsc still type-checks them — esbuild does not — and its output
// for non-entry-point modules (e.g. dist/ui/uiFormat.js) is left alone,
// which is what the tests import.

const esbuild = require("esbuild");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** One per BrowserWindow NIMBUS opens; each becomes a standalone <script src> in its own HTML file. */
const ENTRY_POINTS = ["renderer", "suggestionRenderer", "timerRenderer"];

// `npm run dev` watches types with tsc -w; this is the matching watcher
// for the bundle, since tsc's own output for the entry points is not what
// the app loads any more.
const WATCH = process.argv.includes("--watch");

async function main() {
  const contexts = await Promise.all(
    ENTRY_POINTS.map((name) => {
      const options = {
        entryPoints: [path.join(ROOT, "src", "ui", `${name}.ts`)],
        outfile: path.join(ROOT, "dist", "ui", `${name}.js`),
        bundle: true,
        // An IIFE, not ESM: the HTML loads these with a plain
        // <script src>, and nothing outside them consumes their exports.
        format: "iife",
        platform: "browser",
        target: "chrome120", // Electron 33 ships Chromium 130
        sourcemap: true,
        logLevel: "warning",
      };
      return WATCH ? esbuild.context(options) : esbuild.build(options);
    })
  );

  if (!WATCH) {
    console.log(`Bundled ${ENTRY_POINTS.length} UI entry points`);
    return;
  }

  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log(`Watching ${ENTRY_POINTS.length} UI entry points for changes`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
