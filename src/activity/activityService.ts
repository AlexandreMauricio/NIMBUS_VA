import { randomUUID } from "crypto";
import { logger } from "../logging/logger";
import { ContextEventBus } from "../events/eventBus";
import { ContextEvent } from "../events/types";
import { anchorProcessFor, detectActivity } from "./activityDetector";
import {
  ActivitySession,
  ActivitySettings,
  ActivityStateStore,
  CurrentActivity,
  DEFAULT_ACTIVITY_GRACE_MINUTES,
  MAX_ACTIVITY_SESSIONS,
} from "./types";

/**
 * Tracks what the user appears to be doing, as a series of sessions.
 *
 * Subscribes to the same ContextEventBus everything else does — there is
 * no second monitor here, and no new signal is collected for this
 * feature. It observes and records; it never executes anything. Routines
 * read the result through a condition, which is the only path from
 * "activity" to "something happens", and it still goes through a
 * Suggestion the user accepts.
 *
 * The three rules that make sessions useful rather than noise:
 *
 *  1. An event matching the activity already running UPDATES that
 *     session. It never starts a second one. Re-opening or re-reporting
 *     the same app is the common case, and a new session per event would
 *     reduce every duration to zero.
 *  2. An event matching NO mapping is ignored entirely. Opening an
 *     unmapped app mid-session does not end the session — silence and
 *     unrelated activity both look the same from here, and neither means
 *     the user stopped.
 *  3. A session ends only on a signal that genuinely means it: a
 *     different activity starting, or the process it is anchored to
 *     closing (after a grace period). Never on a timer, and never
 *     because nothing happened for a while — sustained work produces no
 *     events at all.
 */
export class ActivityService {
  private current: ActivitySession | null = null;
  /** When `current`'s anchor process closed, if it has. Null while it is running. */
  private anchorClosedAt: Date | null = null;
  private readonly history: ActivitySession[] = [];
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly getSettings: () => ActivitySettings,
    private readonly eventBus: ContextEventBus,
    private readonly now: () => Date = () => new Date(),
    private readonly stateStore?: ActivityStateStore
  ) {
    if (!stateStore) return;
    try {
      const state = stateStore.load();
      for (const session of state.sessions ?? []) {
        // Anything that was still running when NIMBUS stopped is closed
        // out at its last known activity rather than resumed. NIMBUS
        // cannot know whether the app kept running, whether the machine
        // slept, or how long any of it lasted — and inventing that time
        // would put fabricated durations into the user's own history.
        this.history.push(
          session.state === "active" ? { ...session, state: "ended", endedAt: session.lastActiveAt } : session
        );
      }
    } catch (err) {
      logger.warn("Could not restore activity history", { error: String(err) });
    }
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe((event) => this.handleEvent(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    // Ending the session on shutdown is the honest counterpart of not
    // resuming one on startup — and if the anchor had already closed,
    // that earlier moment is when the activity really stopped.
    this.endCurrent(this.anchorClosedAt ?? this.now());
  }

  /** Notified whenever the current activity changes — for the Home page to refresh. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * What the user appears to be doing now, or null. Resolves a session
   * whose grace period has run out on the way, so a caller never sees an
   * activity that has actually finished.
   */
  getCurrentActivity(): CurrentActivity | null {
    this.resolveGrace();
    if (!this.current) return null;
    const startedAt = new Date(this.current.startedAt);
    return {
      activity: this.current.activity,
      icon: this.current.icon,
      source: this.current.source,
      sourceValue: this.current.sourceValue,
      startedAt: this.current.startedAt,
      durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
    };
  }

  /** The active session, if any. */
  getCurrentSession(): ActivitySession | null {
    this.resolveGrace();
    return this.current ? { ...this.current } : null;
  }

  /** Recent sessions, most recent first, including the one in progress. */
  getRecentSessions(limit = MAX_ACTIVITY_SESSIONS): ActivitySession[] {
    this.resolveGrace();
    const all = this.current ? [{ ...this.current }, ...this.history] : [...this.history];
    return all
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit);
  }

  private handleEvent(event: ContextEvent): void {
    const settings = this.getSettings();
    if (!settings.enabled) return;

    if (event.type === "applicationClosed") {
      this.handleProcessClosed(event.executableName);
      return;
    }

    const match = detectActivity(event, settings.mappings ?? []);
    if (!match) {
      // Rule 2 with one exception. An unmapped *application* opening says
      // nothing — alt-tabbing to a chat app is not "stopped studying".
      // But a website session is defined by what its browser is showing,
      // and NIMBUS cannot see tabs: closing the tab or navigating away
      // just makes that browser report a different title. If the browser
      // this session is anchored to is now showing something that
      // doesn't match, the site is gone, and waiting for the whole
      // browser to close would leave the session running all day.
      //
      // It starts the grace period rather than ending outright, so
      // flicking to another tab and back continues the same session.
      if (
        event.type === "websiteOpened" &&
        this.current?.source === "website" &&
        this.current.anchorProcess === event.browserExecutable.toLowerCase()
      ) {
        this.beginGrace();
      }
      return;
    }

    const at = this.now();
    this.resolveGrace();

    if (this.current && this.current.activity === match.activity) {
      // Rule 1: the same activity continuing. Update, never restart —
      // and clear any pending end, because the activity is demonstrably
      // still happening.
      this.current.lastActiveAt = at.toISOString();
      this.current.sourceValue = match.sourceValue;
      const anchor = anchorProcessFor(event);
      if (anchor) this.current.anchorProcess = anchor;
      this.anchorClosedAt = null;
      return;
    }

    // Rule 3: a different activity genuinely began.
    //
    // Ended when its anchor closed, if it already had — not now. Closing
    // a study app and opening a game two minutes later means studying
    // stopped when the app closed; crediting those two minutes to Study
    // because that is when NIMBUS found out would overstate the session
    // by up to a whole grace period.
    this.endCurrent(this.anchorClosedAt ?? at);
    this.current = {
      id: randomUUID(),
      activity: match.activity,
      icon: match.icon,
      source: match.source,
      sourceValue: match.sourceValue,
      anchorProcess: anchorProcessFor(event),
      startedAt: at.toISOString(),
      lastActiveAt: at.toISOString(),
      endedAt: null,
      state: "active",
    };
    this.anchorClosedAt = null;
    logger.info("Activity started", { activity: this.current.activity, source: this.current.source });
    this.persist();
    this.notify();
  }

  /**
   * The process a session is anchored to has gone. That starts the grace
   * period rather than ending the session immediately: an app that
   * crashed, was restarted, or was closed for a moment is not the same
   * as the user moving on, and reopening it should continue the session
   * they were already in.
   */
  private handleProcessClosed(executableName: string): void {
    if (!this.current) return;
    if (this.current.anchorProcess !== executableName.toLowerCase()) return;
    this.beginGrace();
  }

  /**
   * The thing that defined this activity is no longer visible — the app
   * closed, or the browser moved off the site. Starts the countdown to
   * the session ending, without ending it yet.
   *
   * Idempotent: a second signal while already counting down must not
   * push the deadline back, or a browser cycling through unmatched tabs
   * would keep a finished session alive indefinitely.
   */
  private beginGrace(): void {
    if (!this.current || this.anchorClosedAt) return;
    this.anchorClosedAt = this.now();
    this.resolveGrace();
  }

  /**
   * Ends a session whose anchor closed longer than the grace period ago.
   *
   * Lazy rather than scheduled: evaluated whenever anyone asks what is
   * happening, so it needs no timer, cannot fire while the app is busy
   * elsewhere, and gives the same answer no matter when it is called.
   * The session is recorded as having ended when the process closed —
   * not when this happened to run — so the duration reflects the user's
   * day rather than NIMBUS's polling.
   */
  private resolveGrace(): void {
    if (!this.current || !this.anchorClosedAt) return;
    const graceMs = (this.getSettings().graceMinutes ?? DEFAULT_ACTIVITY_GRACE_MINUTES) * 60_000;
    if (this.now().getTime() - this.anchorClosedAt.getTime() < graceMs) return;
    this.endCurrent(this.anchorClosedAt);
  }

  private endCurrent(endedAt: Date): void {
    if (!this.current) return;
    const ended: ActivitySession = {
      ...this.current,
      state: "ended",
      endedAt: endedAt.toISOString(),
    };
    this.history.unshift(ended);
    if (this.history.length > MAX_ACTIVITY_SESSIONS) {
      this.history.length = MAX_ACTIVITY_SESSIONS;
    }
    const durationMs = new Date(ended.endedAt!).getTime() - new Date(ended.startedAt).getTime();
    logger.info("Activity ended", {
      activity: ended.activity,
      durationMinutes: Math.round(durationMs / 60_000),
    });

    // Announced so Routines can react to an activity finishing — the one
    // thing no other event can express. Still only a *statement* that it
    // happened: what to do about it stays a Routine's decision, and the
    // user's to approve.
    this.eventBus.publish({
      id: randomUUID(),
      type: "activityEnded",
      occurredAt: ended.endedAt!,
      source: "activityService",
      activity: ended.activity,
      durationMs,
    });
    this.current = null;
    this.anchorClosedAt = null;
    this.persist();
    this.notify();
  }

  private persist(): void {
    if (!this.stateStore) return;
    try {
      const sessions = this.current ? [this.current, ...this.history] : [...this.history];
      this.stateStore.save({ sessions: sessions.slice(0, MAX_ACTIVITY_SESSIONS) });
    } catch (err) {
      logger.warn("Could not persist activity history", { error: String(err) });
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("An activity listener threw", { error: String(err) });
      }
    }
  }
}
