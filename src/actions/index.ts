import { ActionService } from "./actionService";

export { ActionService } from "./actionService";
export * from "./types";

/**
 * The application's single ActionService instance. No providers are
 * pre-registered here — unlike src/context/index.ts's DateTime/SystemInfo
 * providers, every action provider today (Spotify) needs live settings
 * and device-specific auth, so registration happens in
 * src/main/lifecycle.ts, the same way weather/calendar/email/tasks
 * register their Context providers there.
 */
export const actionService = new ActionService();
