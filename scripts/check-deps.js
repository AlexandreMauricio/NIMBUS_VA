// Fails early, and in plain language, when the build tools aren't installed.
//
// Without this, a fresh copy of the project (a downloaded ZIP, a new
// clone) answers `npm start` or `npm run package` with
// "'tsc' is not recognized as an internal or external command" — which
// says nothing about the actual problem: node_modules isn't there yet.
const fs = require("fs");
const path = require("path");

/** The tools every build step needs, by the folder each installs into. */
const REQUIRED = ["typescript", "esbuild", "electron", "pdfjs-dist"];

function missingDependencies(root) {
  return REQUIRED.filter((name) => !fs.existsSync(path.join(root, "node_modules", name)));
}

// The project root, or an explicit one (used by this script's own check).
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..");
const missing = missingDependencies(root);

if (missing.length > 0) {
  const hasNodeModules = fs.existsSync(path.join(root, "node_modules"));
  console.error("");
  console.error("  NIMBUS: dependencies are not installed in this folder.");
  console.error("");
  console.error(`  Folder:  ${root}`);
  console.error(`  Missing: ${missing.join(", ")}${hasNodeModules ? " (node_modules is incomplete)" : ""}`);
  console.error("");
  console.error("  Run this first, in this same folder:");
  console.error("");
  console.error("      npm install");
  console.error("");
  console.error("  Each copy of the project needs its own node_modules — a fresh");
  console.error("  download or clone does not inherit one from another folder.");
  console.error("");
  process.exit(1);
}

module.exports = { missingDependencies, REQUIRED };
