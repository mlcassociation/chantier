import type { ApprovalDecision } from "@chantier/permissions";

/**
 * Namespaced action-id key map (spec §6a): every chord maps to a namespaced
 * action id and components ask `matches(event, "app.interrupt")` instead of
 * comparing raw key fields. This kills the BUG-3 class — any Ctrl-modified
 * key quit (app.ts:23-25 in v0.4) — because ctrl-c is the ONLY quit chord,
 * and it keeps dispatch as pure data + pure functions that unit-test without
 * mounting ink (the Hermes approvalAction pattern, matching the existing
 * keypressToDecision).
 */

/**
 * Structural subset of ink's `useInput` Key that the matcher needs. Declared
 * here (instead of importing ink) so keys.ts stays a pure, runtime-free
 * module; ink's Key is structurally compatible by construction.
 */
export interface Keychord {
  /** Raw chunk bytes; a PTY can bundle the key with its Enter ("y\r"). */
  readonly input?: string;
  readonly ctrl?: boolean;
  readonly escape?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  /** Tab key: ink clears the input bytes for non-alphanumeric keys, so the
   * tab travels on its own field (ink 7 useInput). */
  readonly tab?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

export type ActionId =
  /** Esc while a run streams: interrupt, keep completed work. */
  | "app.interrupt"
  /** Ctrl-C: the ONLY quit chord; the ×2 window lives in the caller. */
  | "app.quit"
  /** Approval card: y / a / n / esc. */
  | "app.decide.allow"
  | "app.decide.always"
  | "app.decide.deny"
  | "app.decide.abort"
  /** Enter at the task prompt (submit or queue while running). */
  | "app.submit"
  /** ↑ / ↓ history recall at an empty-ish editor. */
  | "app.history.prev"
  | "app.history.next"
  /** ↑ while queued rows exist: pop the last queued row into the editor. */
  | "app.queue.edit"
  /** Emacs set (§6f). */
  | "app.editor.home"
  | "app.editor.end"
  | "app.editor.char.back"
  | "app.editor.char.forward"
  | "app.editor.kill.to-end"
  | "app.editor.kill.line"
  | "app.editor.kill.word"
  | "app.editor.backspace"
  /** Ctrl-L clears + redraws; ink repaints from state, so this is a no-op
   * hook point today — but it must stay OUT of app.quit's chord set. */
  | "app.redraw"
  /** Palette (v0.6 §Theme 3): ↑/↓ select (preempting history/queue),
   * enter accepts the selected row, tab inserts the top match. Esc-close
   * and backspace-past-trigger are state transitions, not chords, and live
   * in the input state machine. */
  | "app.palette.prev"
  | "app.palette.next"
  | "app.palette.accept"
  | "app.palette.tab";

/**
 * The chord table. "app.queue.edit" and "app.history.prev" share the
 * up-arrow chord on purpose: callers disambiguate by state (queued rows
 * exist vs history recall), which is how OMP treats Alt+Up vs plain Up.
 */
export const ACTION_CHORDS: Readonly<Record<ActionId, readonly Keychord[]>> = {
  "app.interrupt": [{ escape: true }],
  "app.quit": [{ input: "c", ctrl: true }],
  "app.decide.allow": [{ input: "y" }],
  "app.decide.always": [{ input: "a" }],
  "app.decide.deny": [{ input: "n" }],
  "app.decide.abort": [{ escape: true }],
  "app.submit": [{ return: true }],
  "app.history.prev": [{ upArrow: true }],
  "app.history.next": [{ downArrow: true }],
  "app.queue.edit": [{ upArrow: true }],
  "app.editor.home": [{ input: "a", ctrl: true }],
  "app.editor.end": [{ input: "e", ctrl: true }],
  "app.editor.char.back": [{ input: "b", ctrl: true }],
  "app.editor.char.forward": [{ input: "f", ctrl: true }],
  "app.editor.kill.to-end": [{ input: "k", ctrl: true }],
  "app.editor.kill.line": [{ input: "u", ctrl: true }],
  "app.editor.kill.word": [{ input: "w", ctrl: true }],
  "app.editor.backspace": [{ backspace: true }, { delete: true }],
  "app.redraw": [{ input: "l", ctrl: true }],
  "app.palette.prev": [{ upArrow: true }],
  "app.palette.next": [{ downArrow: true }],
  "app.palette.accept": [{ return: true }],
  "app.palette.tab": [{ tab: true }],
};

function chordMatches(chord: Keychord, event: Keychord): boolean {
  for (const field of Object.keys(chord) as Array<keyof Keychord>) {
    if (event[field] !== chord[field]) return false;
  }
  return true;
}

/**
 * Whether the keypress resolves to the action id. Input chunks are
 * normalized by stripping CR/LF first: a PTY can deliver "y\r" as one chunk
 * while ink sets key.return only for a lone CR.
 */
export function matches(event: Keychord, id: ActionId): boolean {
  const chords = ACTION_CHORDS[id];
  if (chords === undefined) return false;
  const normalized: Keychord =
    event.input === undefined ? event : { ...event, input: event.input.replace(/[\r\n]/g, "") };
  return chords.some((chord) => chordMatches(chord, normalized));
}

/** Hint line for the approval card, verbatim spec §7 mockup. */
export const APPROVAL_HINT_PARTS = ["y allow", "a always", "n deny", "esc abort"] as const;

/**
 * Maps a prompt keypress to a decision; null = key not handled by the
 * prompt. Moved here unchanged from app.ts (spec §7): this stays the pure
 * dispatch surface, unit-tested without mounting ink.
 */
export function keypressToDecision(key: string): ApprovalDecision | null {
  // PTYs can bundle the key with its Enter ("y\r") in one chunk: strip
  // line-break bytes before matching.
  const clean = key.replace(/[\r\n]/g, "");
  if (clean === "y") return { approved: true };
  if (clean === "a") return { approved: true, remember: true };
  if (clean === "n") return { approved: false, reason: "user denied" };
  return null;
}
