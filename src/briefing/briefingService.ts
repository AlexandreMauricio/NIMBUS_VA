import { logger } from "../logging/logger";
import { ContextService } from "../context/contextService";
import { BriefingGenerator } from "./briefingGenerator";
import { Briefing } from "./types";

/**
 * Owns the briefing's lifecycle: generate once, cache the result, and let
 * callers (IPC handlers, UI on load) fetch the *current* briefing without
 * triggering a new one each time. This is what keeps a UI reload — or
 * several windows/components asking at once — from producing a fresh
 * briefing (and a fresh weather API call) every time.
 *
 * `generate()` is the only thing that produces a new briefing, and
 * concurrent calls to it share a single in-flight generation rather than
 * racing multiple context fetches.
 */
export class BriefingService {
  private current: Briefing | null = null;
  private pending: Promise<Briefing> | null = null;

  constructor(
    private readonly contextService: ContextService,
    private readonly generator: BriefingGenerator = new BriefingGenerator()
  ) {}

  /** Generates a fresh briefing (startup, or an explicit manual refresh). */
  generate(): Promise<Briefing> {
    if (!this.pending) {
      this.pending = this.doGenerate().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /** The last generated briefing, or null if none has been generated yet. Never triggers generation. */
  getCurrent(): Briefing | null {
    return this.current;
  }

  private async doGenerate(): Promise<Briefing> {
    const snapshot = await this.contextService.getSnapshot();
    const briefing = this.generator.generate(snapshot);
    this.current = briefing;
    logger.info("Briefing generated", {
      id: briefing.id,
      itemCount: briefing.items.length,
      categories: briefing.items.map((i) => i.category),
    });
    return briefing;
  }
}
