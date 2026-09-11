import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, applyDefaults, extractSecrets } from "./settingsSchema";

test("stock tracking defaults: on, with news, and no positions", () => {
  assert.deepEqual(DEFAULT_SETTINGS.userPreferences.stocks, {
    enabled: true,
    newsEnabled: true,
    baseCurrency: "EUR",
    positions: [],
  });
});

test("a settings file from before stocks existed gains the stocks defaults", () => {
  const loaded = applyDefaults({
    userPreferences: { weather: { locationMode: "auto", manualLocation: null } },
  });

  assert.deepEqual(loaded.userPreferences.stocks, {
    enabled: true,
    newsEnabled: true,
    baseCurrency: "EUR",
    positions: [],
  });
});

test("saved positions survive a load unchanged", () => {
  const positions = [
    {
      id: "p1",
      symbol: "AAPL",
      shares: 10,
      averageCost: 150,
      purchaseDate: "2024-01-15",
      notes: "long term",
    },
  ];

  const loaded = applyDefaults({
    userPreferences: { stocks: { enabled: false, newsEnabled: false, positions } },
  });

  assert.deepEqual(loaded.userPreferences.stocks, {
    enabled: false,
    newsEnabled: false,
    baseCurrency: "EUR",
    positions,
  });
});

test("positions are plain user data: saved to settings.json, nothing sent to the secret store", () => {
  const settings = applyDefaults({});
  settings.userPreferences.stocks.positions = [{ id: "p1", symbol: "AAPL", shares: 1, averageCost: 1 }];

  const { sanitized, secrets } = extractSecrets(settings);

  assert.deepEqual(sanitized.userPreferences.stocks.positions, settings.userPreferences.stocks.positions);
  assert.deepEqual(Object.keys(secrets), []);
});

test("loading never shares the default positions array between settings objects", () => {
  const a = applyDefaults({});
  a.userPreferences.stocks.positions.push({ id: "x", symbol: "X", shares: 1, averageCost: 1 });

  assert.deepEqual(applyDefaults({}).userPreferences.stocks.positions, []);
});

test("a saved base currency survives a load", () => {
  const loaded = applyDefaults({ userPreferences: { stocks: { baseCurrency: "USD" } } });
  assert.equal(loaded.userPreferences.stocks.baseCurrency, "USD");
});
