// Copies non-TypeScript UI assets (HTML/CSS) into dist/ after tsc runs,
// since tsc only emits compiled .ts files.
const fs = require("fs");
const path = require("path");

const assets = [
  ["src/ui/index.html", "dist/ui/index.html"],
  ["src/ui/styles.css", "dist/ui/styles.css"],
  ["src/ui/suggestion.html", "dist/ui/suggestion.html"],
  ["src/ui/timer.html", "dist/ui/timer.html"],
  ["src/assets/icon.png", "dist/assets/icon.png"],
];

for (const [src, dest] of assets) {
  const srcPath = path.join(__dirname, "..", src);
  const destPath = path.join(__dirname, "..", dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}
