import { logger } from "../../logging/logger";
import { saveSettings } from "../../settings/settingsManager";
import { handle } from "./handle";
import { mergeKnown } from "./mergeKnown";
import type { IpcContext } from "./context";

/** Memory. Registered once at startup; see ARCHITECTURE.md for the channels. */
export function registerMemoryIpc(ctx: IpcContext): void {
  // Memory (src/memory/). The renderer can list, save its own memories,
  // switch any off, keep (promote) or forget — never write a learned or
  // observed item itself; those come only from the wiring below.

  handle("nimbus:list-memories", (_event, filter: unknown) => {
    const f = filter && typeof filter === "object" ? (filter as Record<string, unknown>) : {};
    return ctx.memoryService.list({
      kind: typeof f.kind === "string" ? (f.kind as never) : undefined,
      origin: typeof f.origin === "string" ? (f.origin as never) : undefined,
      source: typeof f.source === "string" ? f.source : undefined,
      text: typeof f.text === "string" ? f.text.slice(0, 200) : undefined,
      includeDisabled: f.includeDisabled === true,
    });
  });
  handle("nimbus:remember-memory", (_event, input: unknown) => {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return ctx.memoryService.remember({
      kind: i.kind as "preference" | "fact",
      title: String(i.title ?? ""),
      value:
        typeof i.value === "string" || typeof i.value === "number" || typeof i.value === "boolean"
          ? i.value
          : null,
      detail: typeof i.detail === "string" ? i.detail : null,
      expiresAt: typeof i.expiresAt === "string" ? i.expiresAt : null,
    });
  });
  handle("nimbus:update-memory", (_event, id: unknown, changes: unknown) =>
    ctx.memoryService.update(String(id ?? ""), changes)
  );
  handle("nimbus:promote-memory", (_event, id: unknown) => ctx.memoryService.promote(String(id ?? "")));
  handle("nimbus:forget-memory", (_event, id: unknown) => ctx.memoryService.forget(String(id ?? "")));
  handle("nimbus:get-memory-settings", () => ctx.settings.userPreferences.memory);
  handle("nimbus:update-memory-settings", (_event, partial: unknown) => {
    ctx.settings.userPreferences.memory = mergeKnown(ctx.settings.userPreferences.memory, partial);
    saveSettings(ctx.settings);
    logger.info("Memory settings updated", { ...ctx.settings.userPreferences.memory });
    return ctx.settings.userPreferences.memory;
  });
}
