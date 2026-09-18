import type { ApprovalRequest } from "@chantier/permissions";

/**
 * Frozen v0.5 contract shared by both TUI build workers (spec
 * local://chantier-tui-v05-spec.md §1). Types only — Worker A implements the
 * runtime store against these; Worker B consumes them from widgets/input code.
 */

/** Finalized transcript item; rendered once via ink Static, never re-rendered. */
export type TuiItem =
  | { kind: "markdown"; text: string }
  | {
      kind: "tool";
      toolName: string;
      argsSummary: string;
      outcome: "done" | "error";
      durationMs?: number;
      /** 1–2 line output preview (first non-empty line of the result content). */
      detail?: string;
      subagent?: { sessionId: string; summary: string };
    }
  | { kind: "divider"; text: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  /** BUG-6 (v0.6): the submitted task, echoed before the run starts. */
  | { kind: "prompt"; text: string }
  /** Final todo checklist flushed when the run settles (v0.6). */
  | { kind: "todo"; text: string };

/** Status-widget state; null hides the widget. */
export interface RunningState {
  /** Date.now() when the run started (elapsed clock source). */
  sinceMs: number;
  detail?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

/** Additions to TuiStore for v0.5 (Worker A implements; TuiState gains the fields). */
export interface TuiStoreV5 {
  readonly items: readonly TuiItem[];
  pushItem(item: TuiItem): void;
  setRunning(running: RunningState | null): void;
  readonly running: RunningState | null;
  readonly queued: readonly string[];
  pushQueued(text: string): void;
  /** Replaces the LAST queued text (the ↑-edit path). */
  editQueued(text: string): void;
  dropQueued(): void;
  readonly usage: UsageTotals | undefined;
  setUsage(usage: UsageTotals | undefined): void;
  readonly statusFlash: string;
  /** 4–6s transient status flash that falls back to the persistent status (Hermes restoreStatusAfter). */
  flashStatus(text: string): void;
}

/** Todo checklist row (canonical shape mirrors @chantier/core todo.ts). */
export type TodoStep = {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
};

/** Additions to TuiStore for v0.6 (TUI worker implements; TuiState gains the fields). */
export interface TuiStoreV6 {
  /** Live todo checklist from the agent's todo tool; empty = none. */
  readonly todos: readonly TodoStep[];
  /** Whole-list replace per todo-tool call. */
  setTodos(steps: readonly TodoStep[]): void;
}

/** Re-export for convenience; TuiPromptDetail is unchanged from v0.4. */
export type { ApprovalRequest };
