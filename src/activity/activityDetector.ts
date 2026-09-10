import { matchString, splitPatterns } from "../common/patternMatch";
import { ContextEvent } from "../events/types";
import { ActivityMapping, ActivityMatch, ActivitySource } from "./types";

/**
 * Turns one Context Event into an activity, using only the user's own
 * mappings. Pure: no state, no I/O, no clock — the same event and
 * mappings always give the same answer.
 *
 * Events that no enabled mapping covers produce `null`, which callers
 * must read as "this tells me nothing", NOT as "the user stopped what
 * they were doing". Opening an unmapped app in the middle of a study
 * session is the overwhelmingly common case, and treating it as the end
 * of that session is precisely the mistake that would make sessions
 * useless.
 */
export function detectActivity(event: ContextEvent, mappings: ActivityMapping[]): ActivityMatch | null {
  const observed = observedValue(event);
  if (!observed) return null;

  const candidates: Array<{ mapping: ActivityMapping; matched: string }> = [];
  for (const m of mappings) {
    if (!m.enabled || m.source !== observed.source) continue;
    const matched = splitPatterns(m.value).find((pattern) =>
      matchString(observed.value, pattern, m.matchMode)
    );
    if (matched !== undefined) candidates.push({ mapping: m, matched });
  }

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (comparePrecedence(b.mapping, a.mapping) > 0 ? b : a));
  return {
    activity: best.mapping.activity,
    icon: best.mapping.icon,
    source: best.mapping.source,
    // The pattern the user configured, NOT the raw thing observed. For an
    // application those are usually the same; for a website they are very
    // much not — a window title carries whatever page someone is on, and
    // recording that would turn a session list into a browsing log. See
    // the privacy note in types.ts.
    sourceValue: best.matched,
    mappingId: best.mapping.id,
  };
}

/**
 * Which of two matching mappings wins. Positive means `a` beats `b`.
 *
 * Priority first, because that is the knob the user actually turns.
 * Then the more specific pattern — the longest alternative that could
 * have matched — so "skillcert" beats a catch-all "chrome" even if
 * someone forgets to set priorities. Then id, purely so the result never
 * depends on the order mappings happen to be stored in; an arbitrary but
 * *stable* answer is far easier to debug than one that changes when a
 * list is reordered.
 */
function comparePrecedence(a: ActivityMapping, b: ActivityMapping): number {
  if (a.priority !== b.priority) return a.priority - b.priority;

  const aSpecificity = longestPatternLength(a.value);
  const bSpecificity = longestPatternLength(b.value);
  if (aSpecificity !== bSpecificity) return aSpecificity - bSpecificity;

  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function longestPatternLength(value: string): number {
  return splitPatterns(value).reduce((max, p) => Math.max(max, p.length), 0);
}

/** What an event offers to match against, and which kind of mapping reads it. */
function observedValue(event: ContextEvent): { source: ActivitySource; value: string } | null {
  switch (event.type) {
    case "applicationOpened":
      return { source: "application", value: event.executableName };
    case "websiteOpened":
      // The window title is what today's detector can actually see; URL
      // and domain stay null without a browser extension (see
      // events/types.ts), so matching them here would silently never fire.
      return { source: "website", value: event.windowTitle };
    case "folderOpened":
      return { source: "folder", value: event.path };
    default:
      // applicationClosed and timerCompleted say nothing about what the
      // user is now doing. Closing is handled by the session manager as
      // an ending signal, not as a new activity.
      return null;
  }
}

/**
 * The process whose lifetime an activity's session should follow.
 *
 * For an application, that is the application. For a website it is the
 * *browser*, which is the only process NIMBUS can see — a tab closing is
 * invisible to it. For a folder there is no meaningful process, so such
 * a session only ends when another activity begins.
 */
export function anchorProcessFor(event: ContextEvent): string | null {
  switch (event.type) {
    case "applicationOpened":
      return event.executableName;
    case "websiteOpened":
      return event.browserExecutable;
    default:
      return null;
  }
}
