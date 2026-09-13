/**
 * Where a book's cover may come from — pure, so the renderer can use it too.
 *
 * Either Open Library's cover service, by ISBN (found by the main process),
 * or a picture you chose, which the main process resizes and keeps in the
 * app's own folder and serves as `nimbus-cover://cover/<book id>.jpg`. No
 * other address is ever kept as a cover.
 */

const OPEN_LIBRARY = /^https:\/\/covers\.openlibrary\.org\/b\/isbn\/[0-9X]{10,13}-M\.jpg$/;
const CHOSEN = /^nimbus-cover:\/\/cover\/[A-Za-z0-9-]{1,80}\.jpg(?:\?v=\d{1,15})?$/;

export function isCoverUrl(value: unknown): value is string {
  return typeof value === "string" && (OPEN_LIBRARY.test(value) || CHOSEN.test(value));
}

/** A picture you chose, rather than one found by ISBN. */
export function isChosenCover(value: unknown): boolean {
  return typeof value === "string" && CHOSEN.test(value);
}

/** The address a chosen cover is served at; `version` makes a replaced picture reload. */
export function chosenCoverUrl(bookId: string, version: number): string | null {
  return /^[A-Za-z0-9-]{1,80}$/.test(bookId)
    ? `nimbus-cover://cover/${bookId}.jpg?v=${Math.floor(version)}`
    : null;
}

/** The Open Library cover address for an ISBN, or null if it isn't one. */
export function coverUrlForIsbn(isbn: string | null): string | null {
  const digits = (isbn ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
  return /^(?:\d{9}[\dX]|\d{13})$/.test(digits)
    ? `https://covers.openlibrary.org/b/isbn/${digits}-M.jpg`
    : null;
}
