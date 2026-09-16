import type { ApprovalDecision, ApprovalRequest } from "@chantier/permissions";

export type TuiMode = "input" | "running";

export interface TuiState {
  readonly mode: TuiMode;
  /** Finalized transcript lines (rendered once, never re-rendered). */
  readonly lines: readonly string[];
  /** In-progress model text, replaced by lines once finalized. */
  readonly streamText: string;
  /** Transient status line (e.g. "thinking…"); "" hides it. */
  readonly status: string;
  /** Pending approval request; null while the model is streaming. */
  readonly prompt: ApprovalRequest | null;
  /** Text typed at the task prompt (input mode only). */
  readonly inputText: string;
  /** True once the owner called finish(); App exits after the final render. */
  readonly finished: boolean;
}

export type TuiStore = {
  readonly state: TuiState;
  /** React-side subscription; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Appends one finalized transcript line. */
  pushLine(line: string): void;
  /** Appends in-flight model text; flushStream() finalizes it. */
  appendStream(text: string): void;
  /** Moves buffered stream text (if any) into finalized lines. */
  flushStream(): void;
  /** Shows a transient status (e.g. "thinking…"); "" hides it. */
  setStatus(status: string): void;
  /** Enters task-input mode; resolves the previous task signal if still open. */
  awaitTask(defaultText?: string): Promise<string | null>;
  /** Submits the typed task text; null = user quit. */
  submitTask(text: string): void;
  /** Backspace one character at the task prompt. */
  backspaceInput(): void;
  /** Types one printable character at the task prompt. */
  typeInput(char: string): void;
  /** Renders the approval prompt and waits for a keypress decision. */
  ask(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** Key handlers, called from the App's useInput. */
  decide(decision: ApprovalDecision): void;
  /**
   * Esc aborts the current work (deny pending prompt + notify); Ctrl-C quits
   * the app with a nonzero exit signal.
   */
  abort(kind: AbortKind): void;
  /** Marks the store finished; App unmounts on the next render. */
  finish(): void;
};

export type AbortKind = "escape" | "ctrl-c";

export function createTuiStore(
  handlers: { onAbort: (kind: AbortKind) => void },
  isQuitCommand: (text: string) => boolean = (text) => /^(q|exit|quit)$/i.test(text.trim()),
): TuiStore {
  let state: TuiState = {
    mode: "input",
    lines: [],
    streamText: "",
    status: "",
    prompt: null,
    inputText: "",
    finished: false,
  };
  const listeners = new Set<() => void>();
  const pendingTasks: Array<{ resolve: (task: string | null) => void }> = [];
  let pendingPrompt: { resolve: (decision: ApprovalDecision) => void } | null = null;

  const set = (patch: Partial<TuiState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pushLine(line) {
      set({ lines: [...state.lines, line] });
    },
    appendStream(text) {
      set({ streamText: state.streamText + text });
    },
    flushStream() {
      if (state.streamText.length === 0) return;
      const flushed = [...state.lines, ...state.streamText.split("\n").map((l) => l)];
      set({ lines: flushed, streamText: "" });
    },
    setStatus(status) {
      set({ status });
    },
    backspaceInput() {
      set({ inputText: state.inputText.slice(0, -1) });
    },
    typeInput(char) {
      set({ inputText: state.inputText + char });
    },
    awaitTask() {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      pendingTasks.push({ resolve });
      set({ mode: "input", inputText: "", status: "", prompt: null });
      return promise;
    },
    submitTask(text) {
      if (state.mode !== "input") return;
      if (isQuitCommand(text)) {
        for (const task of pendingTasks.splice(0)) task.resolve(null);
        set({ finished: true, inputText: "" });
        return;
      }
      for (const task of pendingTasks.splice(0)) task.resolve(text);
      set({ mode: "running", inputText: "" });
    },
    async ask(req) {
      const { promise, resolve } = Promise.withResolvers<ApprovalDecision>();
      pendingPrompt = { resolve };
      set({ prompt: req });
      return promise;
    },
    decide(decision) {
      const pending = pendingPrompt;
      if (pending === null) return;
      pendingPrompt = null;
      set({ prompt: null });
      pending.resolve(decision);
    },
    abort(kind) {
      if (pendingPrompt !== null) {
        const pending = pendingPrompt;
        pendingPrompt = null;
        set({ prompt: null });
        pending.resolve({ approved: false, reason: "user aborted" });
      }
      if (kind === "ctrl-c") {
        set({ finished: true, mode: "input" });
        for (const task of pendingTasks.splice(0)) task.resolve(null);
      }
      handlers.onAbort(kind);
    },
    finish() {
      set({ finished: true, mode: "input" });
      for (const task of pendingTasks.splice(0)) task.resolve(null);
    },
  };
}
