import type { IssueCredits } from "./readings";

/**
 * Looks up the characters and creators of issues you've read, in the
 * background, until there are none left — so a shelf of Epic Collections
 * fills itself in instead of being clicked through five at a time.
 *
 * The Grand Comics Database is a volunteer project that pauses a client for
 * about half an hour after a burst of requests. So the queue goes gently —
 * one issue every few seconds — and when GCD does ask for a pause, it waits
 * the time GCD names, slows down a little, and carries on by itself.
 * Nothing is sent but series names, years and issue numbers.
 */

export interface QueueIssue {
  series: string;
  year: number | null;
  number: number;
}

export interface CreditsQueueState {
  running: boolean;
  /** Issues still to look up. */
  left: number;
  /** Looked up since NIMBUS started. */
  done: number;
  /** When GCD's pause ends (epoch ms), or null. */
  pausedUntil: number | null;
  /** The last problem that wasn't a pause, or null. */
  problem: string | null;
  /** Seconds between lookups right now. */
  gapSeconds: number;
}

export interface CreditsQueueDeps {
  /** Up to `limit` read issues without GCD's names, and how many there are in all. */
  pending(limit: number): { issues: QueueIssue[]; total: number };
  /** GCD's names for an issue, or null when GCD has no such issue. Throws on failure. */
  lookup(issue: QueueIssue): Promise<IssueCredits | null>;
  save(issue: QueueIssue, credits: IssueCredits): void;
  /** Seconds GCD asked to wait, when the error was a pause; null otherwise. */
  pauseSeconds(err: unknown): number | null;
  onState(state: CreditsQueueState): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const START_GAP_MS = 4_000;
const MAX_GAP_MS = 30_000;
const DEFAULT_PAUSE_MS = 30 * 60_000;
const PROBLEM_WAIT_MS = 2 * 60_000;
const NONE: IssueCredits = { title: null, characters: [], writers: [], artists: [], pageCount: null };

export class CreditsQueue {
  private running = false;
  private stopped = false;
  private done = 0;
  private gap = START_GAP_MS;
  private pausedUntil: number | null = null;
  private problem: string | null = null;
  private left = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: CreditsQueueDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  state(): CreditsQueueState {
    return {
      running: this.running,
      left: this.left,
      done: this.done,
      pausedUntil: this.pausedUntil,
      problem: this.problem,
      gapSeconds: Math.round(this.gap / 1000),
    };
  }

  /** Starts working if there's anything to look up and it isn't already. Cheap to call often. */
  kick(): void {
    if (this.running || this.stopped) return;
    const { total } = this.deps.pending(1);
    this.left = total;
    if (!total) return;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
  }

  private publish(): void {
    try {
      this.deps.onState(this.state());
    } catch {
      // A listener's problem isn't the queue's.
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    this.publish();
    try {
      while (!this.stopped) {
        const { issues, total } = this.deps.pending(1);
        this.left = total;
        const issue = issues[0];
        if (!issue) break;
        try {
          const credits = await this.deps.lookup(issue);
          // No such issue on GCD: remember that, so it isn't asked for again.
          this.deps.save(issue, credits ?? NONE);
          this.done++;
          this.left = Math.max(0, total - 1);
          this.problem = null;
          this.pausedUntil = null;
          this.publish();
          await this.sleep(this.gap);
        } catch (err) {
          const pause = this.deps.pauseSeconds(err);
          if (pause !== null) {
            const ms = pause > 0 ? pause * 1000 : DEFAULT_PAUSE_MS;
            this.pausedUntil = this.now() + ms;
            this.gap = Math.min(MAX_GAP_MS, Math.round(this.gap * 1.5));
            this.publish();
            await this.sleep(ms + 5_000);
            this.pausedUntil = null;
          } else {
            this.problem = String(err instanceof Error ? err.message : err);
            this.publish();
            await this.sleep(PROBLEM_WAIT_MS);
          }
        }
      }
    } finally {
      this.running = false;
      this.publish();
    }
  }
}
