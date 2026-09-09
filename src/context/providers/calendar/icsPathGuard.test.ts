import { test } from "node:test";
import assert from "node:assert/strict";
import { IcsCalendarSource } from "./icsCalendarSource";

/**
 * Covers the local-path restriction specifically: a non-URL address is
 * only read when it actually names a calendar file, so "not a URL means
 * it is a file path" can't turn this into a read-any-file capability.
 */

function neverReads(): (p: string) => Promise<string> {
  return async (p: string) => {
    throw new Error(`should not have read ${p}`);
  };
}

test("reads a local path that names a calendar file", async () => {
  const read = async () => "LOCAL-ICS-DATA";

  for (const address of [
    "C:\\Users\\me\\calendar.ics",
    "/home/me/work.ical",
    "C:\\Users\\me\\busy.ifb",
    "C:\\Users\\me\\CALENDAR.ICS",
  ]) {
    const source = new IcsCalendarSource(address, fetch, read);
    assert.equal(await source.fetchRaw(), "LOCAL-ICS-DATA", address);
  }
});

test("refuses a local path that is not a calendar file", async () => {
  for (const address of [
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "C:\\Users\\me\\.env",
    "/etc/passwd",
    "C:\\Users\\me\\id_rsa",
    "not-a-url-at-all",
  ]) {
    const source = new IcsCalendarSource(address, fetch, neverReads());
    await assert.rejects(() => source.fetchRaw(), /\.ics file/, address);
  }
});

test("refuses a non-http protocol rather than treating it as a path", async () => {
  // `file:` and custom schemes are not http(s), so they fall to the local
  // branch — where they must still fail the calendar-file check.
  for (const address of ["file:///etc/passwd", "ftp://example.com/calendar"]) {
    const source = new IcsCalendarSource(address, fetch, neverReads());
    await assert.rejects(() => source.fetchRaw(), /\.ics file/, address);
  }
});

test("a query string cannot be used to smuggle the extension check", async () => {
  const source = new IcsCalendarSource("C:\\Windows\\win.ini?x=.ics", fetch, neverReads());

  await assert.rejects(() => source.fetchRaw(), /\.ics file/);
});

test("an http(s) URL is still fetched regardless of its extension", async () => {
  // Publishers often serve a feed from an extensionless path — the
  // restriction applies to local files only, never to the network path.
  const fakeFetch = (async () =>
    ({ ok: true, status: 200, text: async () => "RAW" }) as unknown as Response) as typeof fetch;
  const source = new IcsCalendarSource("https://example.com/feeds/private-abc123", fakeFetch);

  assert.equal(await source.fetchRaw(), "RAW");
});
