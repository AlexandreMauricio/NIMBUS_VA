import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenMeteoClient } from "./openMeteoClient";

const SAMPLE_RESPONSE = {
  current: {
    temperature_2m: 21.7,
    apparent_temperature: 22.8,
    weather_code: 3,
  },
  daily: {
    time: ["2026-09-08", "2026-09-09", "2026-09-10"],
    weather_code: [3, 61, 0],
    temperature_2m_max: [27.4, 25.4, 29.9],
    temperature_2m_min: [19.0, 19.2, 19.4],
    precipitation_probability_max: [0, 60, 0],
  },
};

function fakeFetch(response: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => response,
    }) as unknown as Response) as typeof fetch;
}

test("maps Open-Meteo response into structured WeatherContext fields", async () => {
  const client = new OpenMeteoClient(fakeFetch(SAMPLE_RESPONSE));
  const result = await client.fetchForecast({ latitude: 38.7, longitude: -9.1 });

  assert.equal(result.temperatureC, 21.7);
  assert.equal(result.apparentTemperatureC, 22.8);
  assert.equal(result.condition, "Overcast");
  assert.equal(result.conditionCode, 3);
  assert.equal(result.todayHighC, 27.4);
  assert.equal(result.todayLowC, 19.0);
  assert.equal(result.precipitationProbabilityPercent, 0);
  assert.ok(result.retrievedAt);
});

test("maps the daily forecast array, one entry per day", async () => {
  const client = new OpenMeteoClient(fakeFetch(SAMPLE_RESPONSE));
  const result = await client.fetchForecast({ latitude: 38.7, longitude: -9.1 });

  assert.equal(result.forecast.length, 3);
  assert.deepEqual(result.forecast[1], {
    date: "2026-09-09",
    highC: 25.4,
    lowC: 19.2,
    condition: "Slight rain",
    precipitationProbabilityPercent: 60,
  });
});

test("throws a descriptive error when the API responds with a non-ok status", async () => {
  const client = new OpenMeteoClient(fakeFetch({}, false, 503));

  await assert.rejects(() => client.fetchForecast({ latitude: 0, longitude: 0 }), /status 503/);
});

test("unknown weather codes still produce a readable label instead of crashing", async () => {
  const oddResponse = {
    ...SAMPLE_RESPONSE,
    current: { ...SAMPLE_RESPONSE.current, weather_code: 12345 },
  };
  const client = new OpenMeteoClient(fakeFetch(oddResponse));
  const result = await client.fetchForecast({ latitude: 0, longitude: 0 });

  assert.match(result.condition, /Unknown condition/);
});
