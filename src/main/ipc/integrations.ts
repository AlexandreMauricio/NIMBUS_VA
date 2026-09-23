import { logger } from "../../logging/logger";
import { saveSettings } from "../../settings/settingsManager";
import { GeocodingClient } from "../../context/providers/weather";
import type { TaskPriority, TaskWriteRequest } from "../../context/providers/tasks";
import { mapPlaylists } from "../../context/providers/spotify";
import { handle } from "./handle";
import { mergeKnown } from "./mergeKnown";
import { asRecord, boolOr, idArg, numberOr, recordList } from "./input";
import type { IpcContext } from "./context";

const TASK_PRIORITIES: readonly TaskPriority[] = ["none", "low", "medium", "high"];

/** The fields of a task write the renderer may set, each only when it has the right type. */
function taskRequest(raw: unknown): Partial<TaskWriteRequest> {
  const r = asRecord(raw);
  const out: Partial<TaskWriteRequest> = {};
  const text = (value: unknown) => (typeof value === "string" ? value : value === null ? null : undefined);
  if (typeof r.title === "string") out.title = r.title;
  if (text(r.description) !== undefined) out.description = text(r.description);
  if (text(r.dueDate) !== undefined) out.dueDate = text(r.dueDate);
  if (text(r.projectId) !== undefined) out.projectId = text(r.projectId);
  if (TASK_PRIORITIES.includes(r.priority as TaskPriority)) out.priority = r.priority as TaskPriority;
  return out;
}

/** Weather, calendar, email, tasks and Spotify settings, and the Tasks tab. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerIntegrationsIpc(ctx: IpcContext): void {
  handle("nimbus:get-weather-settings", () => ctx.settings.userPreferences.weather);
  // City search for the manual location; only the typed name leaves the PC.
  const geocoding = new GeocodingClient();
  handle("nimbus:search-places", (_event, query: unknown) => geocoding.searchPlaces(query));

  handle("nimbus:update-weather-settings", (_event, partial: unknown) => {
    const next = mergeKnown(ctx.settings.userPreferences.weather, partial);
    if (next.locationMode !== "auto" && next.locationMode !== "manual") {
      throw new Error('Weather locationMode must be "auto" or "manual".');
    }
    ctx.settings.userPreferences.weather = next;
    saveSettings(ctx.settings);
    logger.info("Weather settings updated", ctx.settings.userPreferences.weather);
    return ctx.settings.userPreferences.weather;
  });

  handle("nimbus:get-calendar-settings", () => ctx.settings.userPreferences.calendar);

  handle("nimbus:update-calendar-settings", (_event, partial: unknown) => {
    const next = mergeKnown(ctx.settings.userPreferences.calendar, partial);
    for (const feed of next.feeds) {
      if (
        !feed ||
        typeof feed.id !== "string" ||
        typeof feed.label !== "string" ||
        typeof feed.address !== "string" ||
        typeof feed.enabled !== "boolean"
      ) {
        throw new Error("Each calendar feed needs an id, label, address and enabled flag.");
      }
    }
    ctx.settings.userPreferences.calendar = next;
    saveSettings(ctx.settings);
    // Feed addresses are credentials (private ICS URLs) — log only
    // shape/counts, never the addresses themselves.
    logger.info("Calendar settings updated", {
      enabled: ctx.settings.userPreferences.calendar.enabled,
      feedCount: ctx.settings.userPreferences.calendar.feeds.length,
    });
    return ctx.settings.userPreferences.calendar;
  });

  // Unlike calendar's feed address, an email account's password is never
  // sent to the renderer at all — not even masked. The Settings form is
  // write-only for it: `hasPassword` tells the UI whether one is already
  // saved (to decide what placeholder to show), and saving a new value
  // goes through nimbus:update-email-settings, which is never read back.
  handle("nimbus:get-email-settings", () => ({
    enabled: ctx.settings.userPreferences.email.enabled,
    defaultSinceDays: ctx.settings.userPreferences.email.defaultSinceDays,
    accounts: ctx.settings.userPreferences.email.accounts.map(({ password, ...rest }) => ({
      ...rest,
      hasPassword: password.length > 0,
    })),
  }));

  handle("nimbus:update-email-settings", (_event, raw: unknown) => {
    const partial = asRecord(raw);
    const current = ctx.settings.userPreferences.email;
    type EmailAccount = (typeof current.accounts)[number];

    // Accounts come back without a `password` field (see get-email-settings
    // above) — `newPassword` is only present when the user actually typed
    // a new one. Anything else must keep its existing stored password;
    // otherwise every non-password edit (toggling enabled, renaming...)
    // would silently wipe it.
    const accounts =
      partial.accounts !== undefined
        ? recordList(partial.accounts, "Email accounts").map(({ newPassword, ...rest }) => {
            if (typeof rest.id !== "string") throw new Error("Each email account needs an id.");
            const existing = current.accounts.find((a) => a.id === rest.id);
            return {
              ...(rest as Omit<EmailAccount, "password">),
              password: typeof newPassword === "string" ? newPassword : (existing?.password ?? ""),
            };
          })
        : current.accounts;

    ctx.settings.userPreferences.email = {
      enabled: boolOr(partial.enabled, current.enabled),
      defaultSinceDays: numberOr(partial.defaultSinceDays, current.defaultSinceDays),
      accounts,
    };
    saveSettings(ctx.settings);
    // Never log account credentials — shape/counts only.
    logger.info("Email settings updated", {
      enabled: ctx.settings.userPreferences.email.enabled,
      accountCount: ctx.settings.userPreferences.email.accounts.length,
    });
    return {
      enabled: ctx.settings.userPreferences.email.enabled,
      defaultSinceDays: ctx.settings.userPreferences.email.defaultSinceDays,
      accounts: ctx.settings.userPreferences.email.accounts.map(({ password, ...rest }) => ({
        ...rest,
        hasPassword: password.length > 0,
      })),
    };
  });

  // Unlike calendar's feed address, a task account's API token is never
  // sent to the renderer at all — same write-only pattern as email's
  // password. `hasApiToken` tells the UI whether one is already saved;
  // saving a new value goes through nimbus:update-task-settings, which is
  // never read back.
  handle("nimbus:get-task-settings", () => ({
    enabled: ctx.settings.userPreferences.tasks.enabled,
    accounts: ctx.settings.userPreferences.tasks.accounts.map(({ apiToken, ...rest }) => ({
      ...rest,
      hasApiToken: apiToken.length > 0,
    })),
  }));

  handle("nimbus:update-task-settings", (_event, raw: unknown) => {
    const partial = asRecord(raw);
    const current = ctx.settings.userPreferences.tasks;
    type TaskAccount = (typeof current.accounts)[number];

    // Accounts come back without an `apiToken` field (see
    // get-task-settings above) — `newApiToken` is only present when
    // the user actually typed a new one. Anything else must keep its
    // existing stored token; otherwise every non-token edit (toggling
    // enabled, renaming...) would silently wipe it.
    const accounts =
      partial.accounts !== undefined
        ? recordList(partial.accounts, "Task accounts").map(({ newApiToken, ...rest }) => {
            if (typeof rest.id !== "string") throw new Error("Each task account needs an id.");
            const existing = current.accounts.find((a) => a.id === rest.id);
            return {
              ...(rest as Omit<TaskAccount, "apiToken">),
              apiToken: typeof newApiToken === "string" ? newApiToken : (existing?.apiToken ?? ""),
            };
          })
        : current.accounts;

    ctx.settings.userPreferences.tasks = {
      enabled: boolOr(partial.enabled, current.enabled),
      accounts,
    };
    saveSettings(ctx.settings);
    // Never log account credentials — shape/counts only.
    logger.info("Task settings updated", {
      enabled: ctx.settings.userPreferences.tasks.enabled,
      accountCount: ctx.settings.userPreferences.tasks.accounts.length,
    });
    return {
      enabled: ctx.settings.userPreferences.tasks.enabled,
      accounts: ctx.settings.userPreferences.tasks.accounts.map(({ apiToken, ...rest }) => ({
        ...rest,
        hasApiToken: apiToken.length > 0,
      })),
    };
  });

  // The Tasks tab's management surface — list/create/edit/complete/
  // delete, all delegating straight to TaskProvider (which resolves the
  // right Todoist account per call; see TaskProvider.resolveAccount).
  // Distinct from nimbus:get-context's task snapshot, which is the
  // briefing-focused bucketed/capped view — this is the full list a
  // management UI actually needs. Every handler lets a rejection
  // propagate to the renderer's own try/catch rather than swallowing it
  // into a generic "false" — the renderer needs the real error message
  // (e.g. "status 403" for a revoked token) to show the user anything
  // useful.
  handle("nimbus:list-tasks", () => ctx.taskProvider.listAllTasks());
  handle("nimbus:list-task-projects", () => ctx.taskProvider.listProjects());
  handle("nimbus:create-task", (_event, request: unknown) => {
    const task = taskRequest(request);
    if (typeof task.title !== "string" || !task.title.trim()) throw new Error("A task needs a title.");
    return ctx.taskProvider.createTask({ ...task, title: task.title });
  });
  handle("nimbus:update-task", (_event, taskId: unknown, request: unknown) =>
    ctx.taskProvider.updateTask(idArg(taskId), taskRequest(request))
  );
  handle("nimbus:complete-task", (_event, taskId: unknown) => ctx.taskProvider.completeTask(idArg(taskId)));
  handle("nimbus:reopen-task", (_event, taskId: unknown) => ctx.taskProvider.reopenTask(idArg(taskId)));
  handle("nimbus:delete-task", (_event, taskId: unknown) => ctx.taskProvider.deleteTask(idArg(taskId)));

  // Spotify's connection state is derived from SpotifyAuthManager (has a
  // stored refresh token or not) rather than persisted as its own
  // settings field — the tokens themselves are the source of truth, kept
  // out of settings.json entirely (see src/main/spotify/spotifyTokenStore.ts).
  handle("nimbus:get-spotify-settings", () => ({
    enabled: ctx.settings.userPreferences.spotify.enabled,
    preferredDeviceId: ctx.settings.userPreferences.spotify.preferredDeviceId,
    connected: ctx.spotifyAuth.isAuthenticated(),
  }));

  handle("nimbus:update-spotify-settings", (_event, partial: unknown) => {
    ctx.settings.userPreferences.spotify = mergeKnown(ctx.settings.userPreferences.spotify, partial);
    saveSettings(ctx.settings);
    logger.info("Spotify settings updated", ctx.settings.userPreferences.spotify);
    return {
      enabled: ctx.settings.userPreferences.spotify.enabled,
      preferredDeviceId: ctx.settings.userPreferences.spotify.preferredDeviceId,
      connected: ctx.spotifyAuth.isAuthenticated(),
    };
  });

  // Starts the PKCE auth flow (opens the system browser). The renderer
  // only ever gets a connected/not-connected boolean back — never a token
  // of any kind, at any point in this exchange.
  handle("nimbus:spotify-connect", async () => {
    try {
      await ctx.spotifyAuth.startAuthFlow();
      return { connected: ctx.spotifyAuth.isAuthenticated(), error: null };
    } catch (err) {
      logger.warn("Spotify auth flow failed", { error: String(err) });
      return { connected: ctx.spotifyAuth.isAuthenticated(), error: "Couldn't connect to Spotify." };
    }
  });

  handle("nimbus:spotify-disconnect", () => {
    ctx.spotifyAuth.disconnect();
    return { connected: false };
  });

  // Playlist metadata only (name/id/artwork/owner/track count) — never
  // downloads a playlist's actual tracks. Lets requests reject naturally
  // (not authenticated, API down, etc.) rather than pretending success;
  // the renderer already handles a rejected invoke with its own try/catch.
  handle("nimbus:spotify-list-playlists", async () => {
    const raw = await ctx.spotifyClient.listPlaylists();
    return mapPlaylists(raw);
  });
}
