import { ActionDefinition, ActionProvider, ActionResult, ActionValidationResult } from "../types";
import { TimerService, TimerPlanPhase } from "../../timers/timerService";
import { TimerType } from "../../timers/types";

export const TIMER_ACTIONS = { START: "timer.start" } as const;

const VALID_TIMER_TYPES: TimerType[] = ["focus", "pomodoro", "break", "custom"];
const VALID_MODES = ["single", "pomodoro"] as const;
type TimerActionMode = (typeof VALID_MODES)[number];

const DEFAULT_STUDY_MINUTES = 45;
const DEFAULT_BREAK_MINUTES = 15;
const DEFAULT_CYCLES = 1;

/**
 * The second Action Provider, alongside Spotify — proof the Action
 * system (and the Routine system built on top of it) was never actually
 * Spotify-specific. A Routine's action list can mix `spotify.*` and
 * `timer.start` steps freely; neither provider knows the other exists.
 *
 * Two modes, one action id: `mode: "single"` (the default, and the only
 * mode that existed before) starts one plain countdown from `duration`
 * minutes; `mode: "pomodoro"` builds a Study/Break/Study/.../Study
 * sequence from `studyMinutes`/`breakMinutes`/`cycles` and hands it to
 * `TimerService.startPlan` — the auto-chaining itself lives entirely in
 * TimerService (see its doc comment); this class only translates
 * "2 studies of 45 with 15 breaks" into the phase list that describes.
 */
export class TimerActionProvider implements ActionProvider {
  readonly id = "timer";
  readonly displayName = "Timer";

  constructor(private readonly timerService: TimerService, private readonly now: () => Date = () => new Date()) {}

  listActions(): ActionDefinition[] {
    return [
      {
        id: TIMER_ACTIONS.START,
        name: "Start timer",
        description: "Starts a NIMBUS countdown timer, either a single duration or an automatic Pomodoro study/break cycle.",
        parameters: [
          { name: "mode", type: "string", required: false, description: "single | pomodoro — defaults to single" },
          { name: "duration", type: "number", required: false, description: "Minutes — required when mode is single" },
          { name: "type", type: "string", required: false, description: "focus | pomodoro | break | custom — defaults to focus (mode: single only)" },
          { name: "title", type: "string", required: false, description: "Defaults to the timer type" },
          { name: "studyMinutes", type: "number", required: false, description: `Per-study length in minutes — mode: pomodoro only, defaults to ${DEFAULT_STUDY_MINUTES}` },
          { name: "breakMinutes", type: "number", required: false, description: `Break length in minutes between studies — mode: pomodoro only, defaults to ${DEFAULT_BREAK_MINUTES}` },
          { name: "cycles", type: "number", required: false, description: `Number of study sessions — mode: pomodoro only, defaults to ${DEFAULT_CYCLES}` },
        ],
        readOnly: false,
        changesExternalState: true,
        requiresConfirmation: false,
        affectsService: "timer",
      },
    ];
  }

  isAvailable(): boolean {
    return true; // no auth/config needed — a timer is purely local
  }

  validate(actionId: string, params: Record<string, unknown>): ActionValidationResult {
    if (actionId !== TIMER_ACTIONS.START) {
      return { valid: false, error: `Unknown timer action "${actionId}".` };
    }

    const mode = (params.mode as TimerActionMode | undefined) ?? "single";
    if (!VALID_MODES.includes(mode)) {
      return { valid: false, error: `mode must be one of: ${VALID_MODES.join(", ")}.` };
    }

    if (mode === "pomodoro") {
      for (const [name, value] of [
        ["studyMinutes", params.studyMinutes],
        ["breakMinutes", params.breakMinutes],
        ["cycles", params.cycles],
      ] as const) {
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
          return { valid: false, error: `${name} must be a positive number.` };
        }
      }
      return { valid: true };
    }

    const duration = params.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      return { valid: false, error: "duration must be a positive number of minutes." };
    }
    if (params.type !== undefined && !VALID_TIMER_TYPES.includes(params.type as TimerType)) {
      return { valid: false, error: `type must be one of: ${VALID_TIMER_TYPES.join(", ")}.` };
    }
    return { valid: true };
  }

  async execute(actionId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const startedAt = this.now();
    if (actionId !== TIMER_ACTIONS.START) {
      return this.failure(actionId, startedAt, "That action isn't available.");
    }

    const mode = ((params.mode as TimerActionMode | undefined) ?? "single") as TimerActionMode;

    if (mode === "pomodoro") {
      const studyMinutes = (params.studyMinutes as number) ?? DEFAULT_STUDY_MINUTES;
      const breakMinutes = (params.breakMinutes as number) ?? DEFAULT_BREAK_MINUTES;
      const cycles = (params.cycles as number) ?? DEFAULT_CYCLES;
      const baseTitle = (params.title as string) || "Study";

      const phases = buildPomodoroPhases(baseTitle, studyMinutes, breakMinutes, cycles);
      const state = this.timerService.startPlan(phases);

      const finishedAt = this.now();
      return {
        actionId,
        status: "success",
        message: `Started a Pomodoro plan: ${cycles} × ${formatDuration(studyMinutes)} study with ${formatDuration(breakMinutes)} breaks.`,
        data: { timerId: state.id, title: state.title, type: state.type, durationMs: state.durationMs, cycles },
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };
    }

    const durationMinutes = params.duration as number;
    const type = ((params.type as TimerType) ?? "focus") as TimerType;
    const title = (params.title as string) || defaultTitle(type);

    const state = this.timerService.start(title, durationMinutes * 60_000, type);

    const finishedAt = this.now();
    return {
      actionId,
      status: "success",
      message: `Started a ${formatDuration(durationMinutes)} ${title.toLowerCase() === title ? title : title} timer.`,
      data: { timerId: state.id, title: state.title, type: state.type, durationMs: state.durationMs },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }

  private failure(actionId: string, startedAt: Date, message: string): ActionResult {
    const finishedAt = this.now();
    return {
      actionId,
      status: "failure",
      error: { category: "not_available", message },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  }
}

/**
 * Study 1 of N, Break, Study 2 of N, Break, ..., Study N of N — a break
 * only ever sits *between* two studies, never after the last one, per
 * how Pomodoro cycles are actually used (e.g. 2 studies of 45 with 15min
 * breaks means Study → Break → Study, not Study → Break → Study →
 * Break). A single-cycle plan (`cycles: 1`) is just one Study phase with
 * no break, which still goes through the same `startPlan` path as a
 * multi-cycle one rather than needing a special case.
 */
function buildPomodoroPhases(baseTitle: string, studyMinutes: number, breakMinutes: number, cycles: number): TimerPlanPhase[] {
  const phases: TimerPlanPhase[] = [];
  for (let i = 1; i <= cycles; i++) {
    phases.push({
      title: cycles > 1 ? `${baseTitle} ${i} of ${cycles}` : baseTitle,
      durationMs: studyMinutes * 60_000,
      type: "focus",
    });
    if (i < cycles) {
      phases.push({ title: "Break", durationMs: breakMinutes * 60_000, type: "break" });
    }
  }
  return phases;
}

function defaultTitle(type: TimerType): string {
  if (type === "pomodoro") return "Pomodoro";
  if (type === "break") return "Break";
  if (type === "custom") return "Timer";
  return "Focus session";
}

function formatDuration(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
