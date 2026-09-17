import type { ApprovalDecision, ApprovalRequest } from "@chantier/permissions";
import type { RunningState, TuiItem, UsageTotals } from "./items.ts";
import { takeSafeFlush } from "./markdown.ts";

export type TuiMode = "input" | "running";

/** Optional attachment for an approval ask; pre-wired for diff previews. */
export interface TuiPromptDetail {
  readonly diff?: string;
}

export interface TuiState {
  readonly mode: TuiMode;
  /** Finalized transcript items (rendered once via Static, never re-rendered). */
  readonly items: readonly TuiItem[];
  /** In-progress model text (the live region), replaced by items once finalized. */
  readonly streamText: string;
  /** Transient status line (e.g. "thinking…"); "" hides it. */
  readonly status: string;
  /** Status-widget state (spinner + elapsed); null hides the widget. */
  readonly running: RunningState | null;
  /** Tasks queued while a run is in flight; drained when the run settles. */
  readonly queued: readonly string[];
  /** Cumulative token usage for the footer; undefined until the first result. */
  readonly usage: UsageTotals | undefined;
  /** Transient flash message that falls back to the persistent status after a few seconds. */
  readonly statusFlash: string;
  /** Pending approval request; null while the model is streaming. */
  readonly prompt: ApprovalRequest | null;
  /** Optional diff attachment for the pending ask; null when absent. */
  readonly promptDetail: TuiPromptDetail | null;
  /** Text typed at the task prompt (input mode only). */
  readonly inputText: string;
  /** True once the owner called finish(); App exits after the final render. */
  readonly finished: boolean;
}

export type TuiStore = {
  readonly state: TuiState;
  /** React-side subscription; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Appends one finalized transcript item (rendered once, never re-rendered). */
  pushItem(item: TuiItem): void;
  /** Appends in-flight model text; flushStream() finalizes it. */
  appendStream(text: string): void;
  /**
   * Finalizes buffered stream text as a markdown item (spec §1). Without
   * options, everything buffered becomes one item. With `{ safe: true }`, the
   * buffer splits at its last safe paragraph boundary (takeSafeFlush): the
   * flushed prefix becomes a markdown item and the remainder stays the live
   * region — a half-open code fence is never finalized mid-stream.
   */
  flushStream(options?: { safe?: boolean }): void;
  /** Shows a transient status (e.g. "thinking…"); "" hides it. */
  setStatus(status: string): void;
  /** Shows/clears the status-widget running state (spinner + elapsed). */
  setRunning(running: RunningState | null): void;
  /** Queues a task typed while a run is in flight. */
  pushQueued(text: string): void;
  /** Replaces the LAST queued text (the ↑-edit path); no-op when empty. */
  editQueued(text: string): void;
  /** Removes the LAST queued text; no-op when empty. */
  dropQueued(): void;
  /** Replaces the footer usage totals; undefined clears them. */
  setUsage(usage: UsageTotals | undefined): void;
  /** Transient flash message; falls back to the persistent status after ~5s. */
  flashStatus(text: string): void;
  /** Enters task-input mode; resolves the previous task signal if still open. */
  awaitTask(defaultText?: string): Promise<string | null>;
  /** Submits the typed task text; null = user quit. */
  submitTask(text: string): void;
  /** Backspace one character at the task prompt. */
  backspaceInput(): void;
  /** Types one printable character at the task prompt. */
  typeInput(char: string): void;
  /** Renders the approval prompt and waits for a keypress decision. */
  ask(req: ApprovalRequest, detail?: TuiPromptDetail): Promise<ApprovalDecision>;
  decide(decision: ApprovalDecision): void;
  /**
   * Esc aborts the current work (deny pending prompt + notify); Ctrl-C quits
   * the app with a nonzero exit signal. The queue survives aborts.
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
    items: [],
    streamText: "",
    status: "",
    running: null,
    queued: [],
    usage: undefined,
    statusFlash: "",
    prompt: null,
    promptDetail: null,
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
  // Stream coalescing: appendStream buffers incoming chunks and lands them in
  // state on one timer tick instead of one set() per chunk, so a fast token
  // stream redraws the live region at most every STREAM_COALESCE_MS.
  const STREAM_COALESCE_MS = 20;
  let pendingStream = "";
  let streamTimer: NodeJS.Timeout | null = null;
  const disarmStreamTimer = (): void => {
    if (streamTimer !== null) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
  };
  const armStreamTimer = (): void => {
    if (streamTimer !== null) return;
    streamTimer = setTimeout(() => {
      streamTimer = null;
      if (pendingStream.length === 0) return;
      const chunk = pendingStream;
      pendingStream = "";
      set({ streamText: state.streamText + chunk });
    }, STREAM_COALESCE_MS);
  };
  // Status flash (Hermes restoreStatusAfter): the flash shows alone for a few
  // seconds, then the widget falls back to the persistent status.
  const STATUS_FLASH_MS = 5000;
  let flashTimer: NodeJS.Timeout | null = null;
  const disarmFlashTimer = (): void => {
    if (flashTimer !== null) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
  };
  /** Normalizes an ask detail: only a non-empty string diff survives. */
  const normalizeDetail = (detail: TuiPromptDetail | undefined): { diff: string } | null => {
    if (typeof detail?.diff === "string" && detail.diff.length > 0) return { diff: detail.diff };
    return null;
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pushItem(item) {
      set({ items: [...state.items, item] });
    },
    appendStream(text) {
      pendingStream += text;
      if (pendingStream.length > 0) armStreamTimer();
    },
    flushStream(options) {
      disarmStreamTimer();
      // Order matters: state.streamText is the already-delivered prefix,
      // pendingStream the newer chunks still waiting on the coalesce timer.
      const buffered = `${state.streamText}${pendingStream}`;
      pendingStream = "";
      if (buffered.length === 0) return;
      if (options?.safe === true) {
        const { flushed, rest } = takeSafeFlush(buffered);
        if (flushed.length === 0) {
          // No safe boundary (plain text mid-paragraph, or an open fence):
          // everything stays the live region; fold in pending chunks.
          if (rest !== state.streamText) set({ streamText: rest });
          return;
        }
        set({ items: [...state.items, { kind: "markdown", text: flushed }], streamText: rest });
        return;
      }
      set({ items: [...state.items, { kind: "markdown", text: buffered }], streamText: "" });
    },
    setStatus(status) {
      set({ status });
    },
    setRunning(running) {
      set({ running });
    },
    pushQueued(text) {
      set({ queued: [...state.queued, text] });
    },
    editQueued(text) {
      const queued = state.queued;
      if (queued.length === 0) return;
      set({ queued: [...queued.slice(0, -1), text] });
    },
    dropQueued() {
      if (state.queued.length === 0) return;
      set({ queued: state.queued.slice(0, -1) });
    },
    setUsage(usage) {
      set({ usage });
    },
    flashStatus(text) {
      disarmFlashTimer();
      if (text.length === 0) {
        set({ statusFlash: "" });
        return;
      }
      flashTimer = setTimeout(() => {
        flashTimer = null;
        set({ statusFlash: "" });
      }, STATUS_FLASH_MS);
      set({ statusFlash: text });
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
      set({ mode: "input", inputText: "", status: "", prompt: null, promptDetail: null });
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
    async ask(req, detail) {
      const { promise, resolve } = Promise.withResolvers<ApprovalDecision>();
      pendingPrompt = { resolve };
      set({ prompt: req, promptDetail: normalizeDetail(detail) });
      return promise;
    },
    decide(decision) {
      const pending = pendingPrompt;
      if (pending === null) return;
      pendingPrompt = null;
      set({ prompt: null, promptDetail: null });
      pending.resolve(decision);
    },
    abort(kind) {
      if (pendingPrompt !== null) {
        const pending = pendingPrompt;
        pendingPrompt = null;
        set({ prompt: null, promptDetail: null });
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