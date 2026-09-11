import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaActionProvider, MEDIA_ACTIONS } from "./mediaActionProvider";
import { FakeDesktop } from "./testing/fakeDesktop";

function setup() {
  const desktop = new FakeDesktop();
  return { desktop, provider: new MediaActionProvider(desktop) };
}

test("lists six actions under media.*, none needing confirmation", () => {
  const defs = setup().provider.listActions();
  assert.deepEqual(
    defs.map((d) => d.id),
    ["media.playPause", "media.next", "media.previous", "media.setVolume", "media.mute", "media.unmute"]
  );
  for (const def of defs) {
    assert.equal(def.affectsService, "media");
    assert.equal(def.requiresConfirmation, false);
  }
});

test("setVolume accepts 0 to 100 and refuses anything else", () => {
  const { provider } = setup();
  for (const volumePercent of [0, 30, 100, 42.5]) {
    assert.equal(
      provider.validate(MEDIA_ACTIONS.SET_VOLUME, { volumePercent }).valid,
      true,
      String(volumePercent)
    );
  }
  for (const volumePercent of [-1, 101, "50", NaN, Infinity, undefined]) {
    assert.equal(
      provider.validate(MEDIA_ACTIONS.SET_VOLUME, { volumePercent }).valid,
      false,
      String(volumePercent)
    );
  }
});

test("the key actions press the matching media key", async () => {
  const { desktop, provider } = setup();

  await provider.execute(MEDIA_ACTIONS.PLAY_PAUSE, {});
  await provider.execute(MEDIA_ACTIONS.NEXT, {});
  await provider.execute(MEDIA_ACTIONS.PREVIOUS, {});

  assert.deepEqual(desktop.calls, ["key playPause", "key next", "key previous"]);
});

test("setVolume rounds and reports the volume set", async () => {
  const { desktop, provider } = setup();

  const result = await provider.execute(MEDIA_ACTIONS.SET_VOLUME, { volumePercent: 30.4 });

  assert.equal(result.status, "success");
  assert.equal(result.message, "System volume set to 30%.");
  assert.deepEqual(desktop.calls, ["volume 30"]);
});

test("mute and unmute set an explicit state rather than toggling", async () => {
  const { desktop, provider } = setup();

  await provider.execute(MEDIA_ACTIONS.MUTE, {});
  await provider.execute(MEDIA_ACTIONS.UNMUTE, {});

  assert.deepEqual(desktop.calls, ["muted true", "muted false"]);
});

test("an invalid volume never reaches the platform", async () => {
  const { desktop, provider } = setup();

  const result = await provider.execute(MEDIA_ACTIONS.SET_VOLUME, { volumePercent: 250 });

  assert.equal(result.error?.category, "invalid_parameters");
  assert.deepEqual(desktop.calls, []);
});

test("a platform failure becomes a structured failure", async () => {
  const { desktop, provider } = setup();
  desktop.failWith = new Error("no audio device");

  const result = await provider.execute(MEDIA_ACTIONS.MUTE, {});

  assert.equal(result.status, "failure");
  assert.equal(result.error?.category, "not_available");
});
