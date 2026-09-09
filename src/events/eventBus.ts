import { logger } from "../logging/logger";
import { ContextEvent } from "./types";

/**
 * A minimal publish/subscribe hub for Context Events. Deliberately dumb —
 * no filtering, no persistence, no Electron dependency — so any Core
 * producer (a detector, a future Context provider) can publish, and any
 * Core consumer (the Routine system's trigger matcher) can subscribe,
 * without either knowing about the other or about IPC/windows.
 *
 * One listener throwing never stops the others from receiving the event
 * — the same failure-isolation discipline ContextService/ActionService
 * already apply to their own callbacks.
 */
export class ContextEventBus {
  private readonly listeners = new Set<(event: ContextEvent) => void>();

  subscribe(listener: (event: ContextEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ContextEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn("A Context Event listener threw", { eventType: event.type, error: String(err) });
      }
    }
  }
}
