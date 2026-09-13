import { test } from "node:test";
import assert from "node:assert/strict";
import { GeocodingClient } from "./geocoding";

function recordingFetch(
  response: unknown,
  ok = true,
  status = 200
): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    return { ok, status, json: async () => response } as unknown as Response;
  }) as typeof fetch;
  return { fetchFn, urls };
}

test("maps results into labelled places, dropping a region that repeats the name", async () => {
  const { fetchFn, urls } = recordingFetch({
    results: [
      { name: "Lisbon", admin1: "Lisbon", country: "Portugal", latitude: 38.71667, longitude: -9.13333 },
      { name: "Lisbon", admin1: "Ohio", country: "United States", latitude: 40.77, longitude: -80.77 },
    ],
  });
  const places = await new GeocodingClient(fetchFn).searchPlaces("  Lisbon ");

  assert.deepEqual(
    places.map((p) => [p.label, p.latitude, p.longitude]),
    [
      ["Lisbon, Portugal", 38.71667, -9.13333],
      ["Lisbon, Ohio, United States", 40.77, -80.77],
    ]
  );
  const url = new URL(urls[0]);
  assert.equal(url.hostname, "geocoding-api.open-meteo.com");
  assert.equal(url.searchParams.get("name"), "Lisbon");
});

test("no results, and results without coordinates, give an empty list", async () => {
  assert.deepEqual(await new GeocodingClient(recordingFetch({}).fetchFn).searchPlaces("Nowhere"), []);
  const { fetchFn } = recordingFetch({ results: [{ name: "Broken", latitude: "x" }] });
  assert.deepEqual(await new GeocodingClient(fetchFn).searchPlaces("Broken"), []);
});

test("a query shorter than two characters, or not a string, never calls the API", async () => {
  const { fetchFn, urls } = recordingFetch({ results: [] });
  const client = new GeocodingClient(fetchFn);
  assert.deepEqual(await client.searchPlaces("a"), []);
  assert.deepEqual(await client.searchPlaces(42), []);
  assert.equal(urls.length, 0);
});

test("an HTTP error is thrown for the caller to report", async () => {
  const client = new GeocodingClient(recordingFetch({}, false, 503).fetchFn);
  await assert.rejects(() => client.searchPlaces("Lisbon"), /503/);
});
