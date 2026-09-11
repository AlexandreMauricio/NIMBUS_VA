# The Action system

The [Context system](context-system.md) is NIMBUS *observing*.
[src/actions/](../src/actions/) is where it *does* something — a system
deliberately kept separate from Context rather than bolted onto it:

- **Context** answers "what is happening?" — read-only; a provider's
  `getContext()` never changes anything outside NIMBUS.
- **Action** answers "do something." — may change external state, and
  always returns a structured result instead of a value to read.

[src/actions/types.ts](../src/actions/types.ts) defines the contract:

- `ActionDefinition` — static, inspectable metadata about one action: id
  (namespaced by provider, e.g. `"spotify.play"`), name, description, a
  parameter schema, and four safety flags — `readOnly`,
  `changesExternalState`, `requiresConfirmation`, `affectsService`.
- `ActionResult` — what every action returns regardless of provider:
  `status` (`"success"` | `"failure"`), optional `data`/`message` on
  success, a structured `error` (a coarse `category` plus a user-safe
  `message`, never a raw API error) on failure, and timing
  (`startedAt`/`finishedAt`/`durationMs`).
- `ActionProvider` — the interface every provider implements:
  `listActions()`, `isAvailable()`, `validate(actionId, params)`,
  `execute(actionId, params)`.
- [ActionService](../src/actions/actionService.ts) — the single entry
  point, `executeAction(actionId, params)`: resolves the owning provider
  from the id prefix, checks `isAvailable()`, validates params, executes,
  and **never lets a provider's exception propagate** — throwing,
  rejecting, reporting unavailable, or **hanging** (both `isAvailable()`
  and `execute()` are bounded by a 30-second timeout) always degrades to a
  `status: "failure"` result. It keeps the last 50 results in memory
  (`getHistory()`) and logs each execution's id, status and duration only.
- `src/actions/index.ts` exports the single `actionService` instance;
  providers are registered in `src/main/lifecycle.ts`.

## Registered actions

| Provider | Actions |
| --- | --- |
| `SpotifyActionProvider` | `spotify.play`, `spotify.pause`, `spotify.next`, `spotify.previous`, `spotify.setVolume`, `spotify.playSearch`, `spotify.playPlaylist` — see [spotify.md](spotify.md) |
| `TimerActionProvider` | `timer.start` (a single countdown or a Pomodoro plan), `timer.stop` (stops the timer and the rest of its plan; succeeds quietly when nothing is running), `timer.addStudy` (adds studies to the running plan) — see [routines.md](routines.md#timers) |
| `SystemActionProvider` | `system.openUrl` — opens an `http://`/`https://` URL in the default browser (any other scheme is rejected); `system.lock` — locks Windows |
| `AppActionProvider` | `app.launch` (a full path to an `.exe` or `.lnk`), and by process name: `app.focus`, `app.minimize`, `app.maximize`, `app.close` |
| `FileActionProvider` | `files.openFile` (refuses programs, scripts and shortcuts), `files.openFolder` |
| `MediaActionProvider` | `media.playPause`, `media.next`, `media.previous` (the media keys, any player), `media.setVolume` (0–100), `media.mute`, `media.unmute` |

## Desktop actions

`app.*`, `files.*`, `media.*` and `system.lock` are Core providers built on
one narrow interface, `DesktopPlatform`
([src/actions/providers/desktopPlatform.ts](../src/actions/providers/desktopPlatform.ts)):
fixed operations with typed arguments, and no member that accepts a
command line. The Windows implementation,
[src/main/desktop/windowsDesktop.ts](../src/main/desktop/windowsDesktop.ts),
is created in `lifecycle.ts` and injected into all four.

| Operation | How it's done on Windows |
| --- | --- |
| Open a file or folder; launch a `.lnk` | Electron's `shell.openPath` — what double-clicking does |
| Launch an `.exe` | `spawn(path, [], { shell: false })` — no shell, no arguments, started in its own folder |
| Focus / minimize / maximize / close | A constant PowerShell script: `user32` `ShowWindow`/`SetForegroundWindow`, and `CloseMainWindow` for close |
| Media keys | A constant PowerShell script sending the virtual media keys |
| Volume and mute | A constant PowerShell script using the Core Audio API (`IAudioEndpointVolume`) on the default output device |
| Lock | `rundll32.exe user32.dll,LockWorkStation`, fixed arguments |

**Safety rules**

- Values a step supplies (a process name, a volume) reach the PowerShell
  scripts only as **environment variables**, never as part of the script
  text, and each script re-checks them — a value cannot become code.
- Paths must be full drive-letter paths, without characters Windows
  forbids or a colon past the drive. `app.launch` accepts only `.exe` and
  `.lnk`; `files.openFile` refuses anything whose default handler would
  run it (executables, scripts, installers, shortcuts — a deliberately
  broad denylist). Existence and kind (file vs. folder) are checked before
  anything is opened.
- Process names are plain names — letters, digits, spaces, `.`, `_`, `-`,
  no wildcards — so one step addresses one app.
- `app.close` asks the app to close, exactly like clicking X; it never
  force-quits, and the app can still ask to save.
- `app.launch` and `app.close` are marked `requiresConfirmation: true`.
  Like every action's, that flag is **not enforced** by `ActionService`: in
  a routine these steps run once its suggestion is accepted, or
  automatically if the routine opts into that.
- Every provider re-validates in `execute()`, so skipping `validate()`
  still can't open a script or launch a non-`.exe`.

**Limitations**

- Window actions act on an app's **main** window(s), found by process
  name. An app with no visible main window (running only in the tray)
  can't be addressed, and Windows' focus rules can occasionally stop a
  background app from being brought to the front.
- Microsoft Store apps have no `.exe` path NIMBUS can launch.
- The **Browse…** picker may resolve a shortcut to its target, losing the
  shortcut's arguments (Discord's Start-menu shortcut depends on them);
  paste the shortcut's own path instead.
- Volume and mute act on the **default output device** only. Media keys go
  to whichever app Windows treats as the active media session.
- Each window, media-key or volume step starts a short-lived PowerShell
  process, so it takes a moment rather than being instant.

## Who calls it

- The renderer, through the generic `nimbus:execute-action` IPC channel —
  a new provider needs no new IPC handler.
- The Routine engine, when a suggestion is accepted, a routine runs
  automatically or on demand (**Run now**), or a wind-down runs.
- The timer popup's **+ Study** button, through `nimbus:timer-add-study`,
  which runs `timer.addStudy`.

The routine editor lists every registered action by service, and renders
each parameter from its schema. A parameter with a `format` hint (`file`,
`folder` or `application`) gets a **Browse…** button, backed by the
`nimbus:pick-path` file dialog; a picked path is only ever put in the text
field, and the action still validates it when it runs.

After any action runs, `onActionExecuted` in `lifecycle.ts` refreshes the
Spotify now-playing state for `spotify.*` actions and opens the timer
popup when `timer.start` succeeds.

## Action safety, today vs. later

`ActionDefinition` carries accurate metadata (every registered action is
`changesExternalState: true`, `requiresConfirmation: false`), but
**`ActionService` does not read or enforce `requiresConfirmation` or any
permission**. The only safety gates today are id and parameter
validation, and the Routine system's "suggest first" flow. Enforcement is
future work.

## Tests

`actionService.test.ts` (success, unknown id, unavailable provider,
invalid parameters, a provider's own failure passed through, throwing and
hanging providers degrading to structured failures, metadata surfaced by
`listActions()`, history ordering, duplicate registration) plus
`spotifyActionProvider.test.ts`, `timerActionProvider.test.ts` and
`systemActionProvider.test.ts`. No real service is involved.

---

[← Back to the README](../README.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
