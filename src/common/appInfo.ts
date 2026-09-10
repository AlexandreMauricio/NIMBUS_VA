/**
 * Central branding/identity constants for NIMBUS.
 * Other modules should import from here rather than hard-coding the name/version.
 */
export const APP_NAME = "NIMBUS";
export const APP_FULL_NAME = "Navigation & Intelligent Monitoring Base for User Systems";
/**
 * Read from package.json rather than written here, because it was
 * written here: this said 0.1.0 while package.json said 0.2.0, and the
 * sidebar reported the wrong version for a release and a half. Two
 * places to change a version means one of them is eventually stale, and
 * the one on screen is the one nobody thinks to update.
 *
 * Safe to read at module load: this file is imported only by the main
 * process (and the context provider it runs), never bundled into the
 * renderer, so `require` is available and package.json sits beside the
 * compiled output's root in both a dev run and a packaged app.
 */
export const APP_VERSION: string = (require("../../package.json") as { version: string }).version;
