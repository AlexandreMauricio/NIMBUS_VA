# NIMBUS — working on this repo

A personal Windows desktop assistant: Electron + TypeScript, no framework,
no AI/LLM. README.md says what it does; ARCHITECTURE.md says where every
module sits and why. Read the relevant `docs/*.md` before changing a
feature.

## Checks

- `npm run check` is the gate CI runs (Windows): lint, Prettier over
  `src/**/*.{ts,css,html}`, `npm test`, and `test:credentials`.
- `npm test` compiles with tsc and runs `dist/**/*.test.js` with
  `node --test`. Tests sit beside the code as `*.test.ts`.
- `test:credentials` needs real Electron with DPAPI, so it only runs on
  Windows; everything else runs anywhere Node 20.6+ does.
- `format:check` doesn't cover Markdown, but CHANGELOG.md and
  ARCHITECTURE.md are kept Prettier-formatted: run `npx prettier --write`
  on them after editing.

## Every change is a version

- One commit per change, and each bumps the **patch** version in
  `package.json` and both places in `package-lock.json`.
- Add the entry at the top of `CHANGELOG.md` (`## 0.x.y — YYYY-MM-DD`),
  written for the person using NIMBUS: what changed for them, in bold
  lead-ins, not a list of files.
- The commit subject is `Area: what changed (0.x.y)`; the body explains
  why and how it was checked.
- Never bump MINOR or MAJOR: Alexandre decides when a milestone is
  reached.
- Update ARCHITECTURE.md when a module is added, moved or changes layer,
  and the IPC table there when a channel is added.

## Layers

- **Core** (`src/context`, `actions`, `routines`, `activity`, `meals`,
  `collections`, `memory`, `network`, …) never imports Electron or an OS
  API; it gets stores and platforms injected. That is what lets it be
  tested with plain `node --test`, and what a future second client would
  reuse.
- **Windows-specific** code lives in `src/main/` (and `src/preload/`).
- **UI** is `src/ui/`, bundled by esbuild per window. `renderer.ts` only
  starts the main window's parts; each tab or section has its own module,
  and `rendererTypes.ts` types `window.nimbus`.

## Rules the code relies on

- **IPC**: register every channel with `handle()` from
  `src/main/ipc/handle.ts` (it refuses pages that aren't NIMBUS's). Every
  argument is `unknown`, narrowed with `ipc/input.ts` or validated by the
  service. `ipcHandlers.test.ts` calls every channel with arguments of the
  wrong kind; a new handler must pass it.
- **The renderer never names a path or a URL to fetch.** The main process
  opens dialogs and builds addresses; a page the renderer names is fetched
  only through `publicFetch.ts`, which refuses this PC and the local
  network.
- **Windows** keep `contextIsolation`, `sandbox: true` and no
  `nodeIntegration`; preloads may only `require("electron")`
  (`preload.test.ts`). No `innerHTML` with data — build elements, or use a
  constant SVG.
- **State files** go through `src/main/jsonFile.ts`: atomic writes, and
  hand-typed data set aside rather than overwritten when unreadable.
  Gathered saves (`DebouncedJsonFile`) are flushed on quit and before data
  is exported or imported — keep it that way if you add one.
- **Credentials** live only in `secrets.json` (safeStorage), never in
  `settings.json`, logs, an export, or anything sent to the renderer.
- Validate persisted data entry by entry on load; drop what's malformed
  instead of failing the whole file.

## Style

- Comments explain _why_, in plain sentences, at the density of the code
  around them; user-facing text is plain and specific.
- `catch {}` is allowed for deliberate best-effort cleanup, with a comment
  saying so.
