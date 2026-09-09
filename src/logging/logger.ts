import * as fs from "fs";
import * as path from "path";
import { config, LogLevel } from "../config/config";

/**
 * Minimal console + optional-file logger for NIMBUS.
 *
 * This module is used by Core (context/, briefing/) as well as the
 * Windows client, so it must not hard-depend on Electron or any other
 * device-specific runtime — that's what would make Core unusable from a
 * future Android/web client (or from plain `node --test`, which is how
 * Core is unit tested today, with no Electron process behind it).
 *
 * File logging is therefore opt-in: a host (today, `src/main/main.ts`)
 * calls `configureFileLogging()` with a directory resolver appropriate to
 * its platform. Until that happens — including in tests, or a
 * hypothetical client that only wants console output — logging still
 * works, it just doesn't persist to a file.
 */

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let resolveLogDirectory: (() => string) | null = null;
let cachedLogFilePath: string | null = null;

/**
 * Enables writing log lines to a file, in addition to the console.
 * Call once, as early as possible, from a platform's entry point —
 * e.g. `src/main/main.ts` passes an Electron `userData`-based path.
 */
export function configureFileLogging(directoryProvider: () => string): void {
  resolveLogDirectory = directoryProvider;
  cachedLogFilePath = null;
}

function getLogFilePath(): string | null {
  if (!resolveLogDirectory) return null;

  if (!cachedLogFilePath) {
    const logsDir = resolveLogDirectory();
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    cachedLogFilePath = path.join(logsDir, "nimbus.log");
  }
  return cachedLogFilePath;
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[config.logLevel]) {
    return;
  }

  const timestamp = new Date().toISOString();
  const metaStr = meta !== undefined ? ` ${JSON.stringify(meta)}` : "";
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;

  const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleMethod(line);

  const filePath = getLogFilePath();
  if (!filePath) return;

  try {
    fs.appendFileSync(filePath, line + "\n");
  } catch {
    // Logging must never crash the app. If the file write fails, the
    // console line above is still the best-effort record.
  }
}

export const logger = {
  error: (message: string, meta?: unknown) => write("error", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
};
