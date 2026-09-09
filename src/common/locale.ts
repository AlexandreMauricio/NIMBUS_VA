/**
 * The locale NIMBUS uses to format dates/times in generated text (e.g.
 * the briefing's "Today is Tuesday, 8 September 2026."). Same injection
 * pattern as logger.ts's `configureFileLogging`: Core (DateTimeProvider,
 * BriefingGenerator) must not import Electron just to ask "what locale is
 * the user in?", so a host configures it once, resolved lazily rather
 * than captured at construction time — the host may not know it yet
 * when Core's providers are first created (see main.ts, which can only
 * read `app.getLocale()` after Electron's `ready` event).
 *
 * Why this exists at all: under Node (unlike a browser/Chromium
 * renderer), `Intl`'s own default-locale detection follows the OS's
 * *region/format* settings, not the user's chosen *display language* —
 * on a machine set to, say, format=English(UK) but display
 * language=Portuguese, plain `Intl.DateTimeFormat()` in the main process
 * would render English text while the renderer (which does follow the
 * display language) shows Portuguese. `app.getLocale()` is Electron's
 * bridge to the latter; main.ts feeds it in here so both processes agree.
 */
let configuredLocale: string | undefined;

export function configureLocale(locale: string | undefined): void {
  configuredLocale = locale;
}

export function resolveLocale(): string | undefined {
  return configuredLocale;
}
