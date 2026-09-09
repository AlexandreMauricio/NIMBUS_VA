// Copies non-TypeScript UI assets (HTML/CSS) into dist/ after tsc runs,
// since tsc only emits compiled .ts files.
const fs = require("fs");
const path = require("path");

const assets = [
  ["src/ui/index.html", "dist/ui/index.html"],
  // nocturne.css is the vendored design system; styles.css layers NIMBUS's
  // own components on top and must be linked (and so copied) after it.
  ["src/ui/nocturne.css", "dist/ui/nocturne.css"],
  ["src/ui/styles.css", "dist/ui/styles.css"],
  ["src/ui/suggestion.html", "dist/ui/suggestion.html"],
  ["src/ui/timer.html", "dist/ui/timer.html"],
  ["src/assets/icon.png", "dist/assets/icon.png"],
];

// The Inter subsets nocturne.css @font-faces. Vendored rather than pulled
// from Google Fonts so the UI renders correctly with no network and
// without loosening the renderer's CSP — see nocturne.css's header.
const assetDirs = [["src/ui/fonts", "dist/ui/fonts"]];

for (const [src, dest] of assets) {
  const srcPath = path.join(__dirname, "..", src);
  const destPath = path.join(__dirname, "..", dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}

for (const [src, dest] of assetDirs) {
  const srcPath = path.join(__dirname, "..", src);
  const destPath = path.join(__dirname, "..", dest);
  fs.mkdirSync(destPath, { recursive: true });
  for (const entry of fs.readdirSync(srcPath)) {
    fs.copyFileSync(path.join(srcPath, entry), path.join(destPath, entry));
  }
}
