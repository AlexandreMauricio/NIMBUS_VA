import { test } from "node:test";
import assert from "node:assert/strict";
import { IcsCalendarSource } from "./icsCalendarSource";

function fakeFetch(body: string, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      text: async () => body,
    }) as unknown as Response) as typeof fetch;
}

test("fetches over HTTP(S) when the address is a URL", async () => {
  const source = new IcsCalendarSource("https://example.com/calendar.ics", fakeFetch("RAW-ICS-DATA"));
  const raw = await source.fetchRaw();
  assert.equal(raw, "RAW-ICS-DATA");
});

test("throws a descriptive error on a non-ok HTTP response", async () => {
  const source = new IcsCalendarSource("https://example.com/calendar.ics", fakeFetch("", false, 404));
  await assert.rejects(() => source.fetchRaw(), /status 404/);
});

test("reads a local file when the address is not an http(s) URL", async () => {
  let requestedPath: string | null = null;
  const readFile = async (p: string) => {
    requestedPath = p;
    return "LOCAL-ICS-DATA";
  };
  const source = new IcsCalendarSource("C:\\fake\\calendar.ics", fetch, readFile);
  const raw = await source.fetchRaw();
  assert.equal(raw, "LOCAL-ICS-DATA");
  assert.equal(requestedPath, "C:\\fake\\calendar.ics");
});
