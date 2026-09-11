import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextEventBus } from "../../events/eventBus";
import { DesktopActivityMonitor } from "./desktopActivityMonitor";
import { RawActivitySnapshot } from "./activitySnapshot";
import { PowerShellRunner } from "./powerShellSession";

test("each poll's windowed programs, with their Windows descriptions, reach the snapshot hook", async () => {
  const seen: RawActivitySnapshot[] = [];
  const session: PowerShellRunner = {
    run: async () =>
      JSON.stringify({
        processes: ["HaloInfinite", "svchost"],
        windowed: [
          { ProcessName: "HaloInfinite", Description: "Halo Infinite" },
          { ProcessName: "Notepad", Description: "" },
        ],
      }),
    dispose: () => {},
  };
  const monitor = new DesktopActivityMonitor(
    new ContextEventBus(),
    undefined,
    60_000,
    () => new Date("2026-09-11T10:00:00Z"),
    () => session,
    (snapshot) => seen.push(snapshot)
  );

  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  monitor.stop();

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].windowedApps, [
    { executable: "haloinfinite.exe", description: "Halo Infinite" },
    { executable: "notepad.exe", description: null },
  ]);
  assert.deepEqual(
    seen[0].processNames,
    ["haloinfinite.exe", "svchost.exe"],
    "background processes still drive events"
  );
});
