import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Box, Text, useInput, usePaste } from "ink";
import { createElement, type ReactNode, useRef } from "react";
import { matches } from "./keys.ts";
import type { TuiSymbols } from "./symbols.ts";

/**
 * v0.5 input surface (spec §6c-f): editor keys, paste, history. The emacs
 * transforms and the paste thresholds are pure functions (testable without
 * mounting ink); `TaskInput` is the props-driven ink component the app
 * mounts at integration. Paste travels ink's separate usePaste channel —
 * bracketed paste content never reaches useInput (verified in ink 7.1.1),
 * which is exactly the fix for the v0.4 paste-destruction bug.
 */

// --- Editor state (pure transforms) ----------------------------------------------

export interface EditorState {
  readonly text: string;
  /** Insertion point, 0..text.length. */
  readonly cursor: number;
}

export function emptyEditor(): EditorState {
  return { text: "", cursor: 0 };
}

export function editorInsert(state: EditorState, insert: string): EditorState {
  const text = state.text.slice(0, state.cursor) + insert + state.text.slice(state.cursor);
  return { text, cursor: state.cursor + insert.length };
}

export function editorBackspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  return {
    text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor),
    cursor: state.cursor - 1,
  };
}

export type EditorAction =
  | "home"
  | "end"
  | "char.back"
  | "char.forward"
  | "kill.to-end"
  | "kill.line"
  | "kill.word";

/**
 * Emacs set (§6f) as pure (text, cursor) transforms: ctrl+a/e home/end,
 * ctrl+b/f char moves, ctrl+k kill to end, ctrl+u clear, ctrl+w kill word
 * back. Single-line editor only; multiline ctrl+j is v0.6.
 */
export function applyEditorAction(state: EditorState, action: EditorAction): EditorState {
  const len = state.text.length;
  switch (action) {
    case "home":
      return { text: state.text, cursor: 0 };
    case "end":
      return { text: state.text, cursor: len };
    case "char.back":
      return { text: state.text, cursor: Math.max(0, cursorAt(state) - 1) };
    case "char.forward":
      return { text: state.text, cursor: Math.min(len, cursorAt(state) + 1) };
    case "kill.to-end":
      // ctrl+k: delete from the cursor to the end of the line.
      return { text: state.text.slice(0, cursorAt(state)), cursor: cursorAt(state) };
    case "kill.line":
      // ctrl+u: clear the whole editor (spec §6f).
      return emptyEditor();
    case "kill.word": {
      // ctrl+w: delete back to the previous word boundary — skip any run of
      // spaces directly before the cursor, then the word's own characters.
      const cursor = cursorAt(state);
      let index = cursor;
      while (index > 0 && state.text[index - 1] === " ") index -= 1;
      while (index > 0 && state.text[index - 1] !== " ") index -= 1;
      return { text: state.text.slice(0, index) + state.text.slice(cursor), cursor: index };
    }
  }
}

function cursorAt(state: EditorState): number {
  return Math.min(state.cursor, state.text.length);
}

// --- Paste (§6e) -----------------------------------------------------------------

export interface PasteResult {
  /** Chip text when the paste exceeds the thresholds; null = insert verbatim. */
  readonly chip: string | null;
  readonly lines: number;
}

/**
 * Chip thresholds (§6e): >3 lines or >800 chars chips; under 12 terminal
 * rows the CC narrow rule applies (1 line / 200 chars).
 */
export function pasteChip(text: string, rows?: number): PasteResult {
  const lines = text.split("\n").length;
  const narrow = rows !== undefined && rows < 12;
  const lineLimit = narrow ? 1 : 3;
  const charLimit = narrow ? 200 : 800;
  const over = lines > lineLimit || text.length > charLimit;
  return { chip: over ? `[pasted +${lines} lines]` : null, lines };
}

/** Restores full paste text from its chip markers before submit. */
export function expandPasteChips(text: string, chunks: ReadonlyMap<string, string>): string {
  let expanded = text;
  for (const [chip, full] of chunks) {
    if (expanded.includes(chip)) expanded = expanded.split(chip).join(full);
  }
  return expanded;
}

// --- History (§6f) ----------------------------------------------------------------

/** File-backed history; the path is injectable so tests never touch $HOME. */
export function historyPath(home: string = homedir()): string {
  return join(home, ".chantier", "history.jsonl");
}

export interface HistoryStore {
  readonly entries: readonly string[];
  /** Appends unless it duplicates the last entry; silent on file failure. */
  record(text: string): Promise<void>;
  /** ↑: empty editor → last → older. */
  prev(): string | null;
  /** ↓: forward; past the newest entry → null (empty editor). */
  next(): string | null;
  /** Typed input ends a browse sequence. */
  reset(): void;
}

export function createHistoryStore(
  opts: { entries?: readonly string[]; file?: string } = {},
): HistoryStore {
  const entries: string[] = [...(opts.entries ?? [])];
  let index: number | null = null;
  return {
    get entries(): readonly string[] {
      return entries;
    },
    async record(text) {
      if (text.trim().length === 0) return;
      const last = entries[entries.length - 1];
      // Consecutive dupes collapse: resubmitting the same line does not
      // grow the recall list.
      if (last === text) return;
      entries.push(text);
      if (opts.file === undefined) return;
      // Silent failure (§6f): history must never break a submit.
      try {
        await mkdir(join(opts.file, ".."), { recursive: true });
        await appendFile(opts.file, `${JSON.stringify({ text })}\n`, "utf8");
      } catch {
        return;
      }
    },
    prev() {
      if (entries.length === 0) return null;
      index = index === null ? entries.length - 1 : Math.max(0, index - 1);
      return entries[index] ?? null;
    },
    next() {
      if (index === null) return null;
      index += 1;
      if (index >= entries.length) {
        index = null;
        return null;
      }
      return entries[index] ?? null;
    },
    reset() {
      index = null;
    },
  };
}

/** Reads the JSONL history; silent failure yields an empty list. */
export async function loadHistory(file: string): Promise<string[]> {
  try {
    const raw = await readFile(file, "utf8");
    const texts: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "text" in parsed &&
          typeof (parsed as { text?: unknown }).text === "string"
        ) {
          texts.push((parsed as { text: string }).text);
        }
      } catch {}
    }
    return texts;
  } catch {
    return [];
  }
}

// --- TaskInput component -----------------------------------------------------------

export const QUIT_HINT = "press ctrl-c again to quit";

const INPUT_HINT_PARTS = ["type a task", "enter run", "q quit"] as const;

/** Default two-stage quit window (§6c). */
const QUIT_WINDOW_MS = 2000;

export interface TaskInputProps {
  /** Controlled editor state; the host owns the single source of truth. */
  readonly editor: EditorState;
  readonly onEditorChange: (next: EditorState) => void;
  /** Enter: the host routes to submitTask (idle) or pushQueued (running). */
  readonly onSubmit: (text: string) => void;
  /** True while a run streams: submit queues, ↑ edits the queue. */
  readonly running: boolean;
  readonly queuedCount: number;
  /** Pops the last queued row back into the editor (§6d, OMP Alt+Up). */
  readonly onQueueEdit: () => void;
  /** Approval pending: every editor key is inert (input lock). */
  readonly locked?: boolean;
  /** Terminal rows for paste thresholds; undefined = standard thresholds. */
  readonly rows?: number;
  /** ↑/↓ recall + esc-saves-draft. */
  readonly history?: HistoryStore;
  /** Ctrl-C: host aborts the store (single-press idle, second stage running). */
  readonly onQuit: () => void;
  /** First ctrl-c while running: host flashes "press ctrl-c again to quit". */
  readonly onQuitArm: () => void;
  /** Two-stage window override for tests. */
  readonly quitWindowMs?: number;
  readonly symbols: TuiSymbols;
  readonly screenReader?: boolean;
}

export function TaskInput({
  editor,
  onEditorChange,
  onSubmit,
  running,
  queuedCount,
  onQueueEdit,
  locked = false,
  rows,
  history,
  onQuit,
  onQuitArm,
  quitWindowMs = QUIT_WINDOW_MS,
  symbols,
  screenReader = false,
}: TaskInputProps): ReactNode {
  // Full paste text lives here; the editor only shows chips (§6e).
  const pasteChunks = useRef(new Map<string, string>());
  const quitTimer = useRef<NodeJS.Timeout | null>(null);
  const quitArmed = useRef(false);

  usePaste(
    (text) => {
      if (locked) return;
      const { chip } = pasteChip(text, rows);
      if (chip === null) {
        // Small pastes insert verbatim; typed-like content flows through the
        // editor as one state write (no per-char set storm).
        onEditorChange(editorInsert(editor, text));
        return;
      }
      let chipText = chip;
      let suffix = 2;
      while (pasteChunks.current.has(chipText)) {
        chipText = `${chip} #${suffix}`;
        suffix += 1;
      }
      pasteChunks.current.set(chipText, text);
      onEditorChange(editorInsert(editor, chipText));
    },
    { isActive: !locked },
  );

  useInput((input, key) => {
    if (locked) return;
    const event = {
      input,
      ctrl: key.ctrl,
      escape: key.escape,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
      backspace: key.backspace,
      delete: key.delete,
    };
    // ctrl-c is the only quit chord (§6a): running arms the two-stage window,
    // idle quits on the first press (§6c).
    if (matches(event, "app.quit")) {
      if (!running || quitArmed.current) {
        quitArmed.current = false;
        clearTimeout(quitTimer.current);
        // ctrl-c quits, it never submits: the host aborts the store (§6c).
        onQuit();
        return;
      }
      quitArmed.current = true;
      onEditorChange(emptyEditor());
      onQuitArm();
      clearTimeout(quitTimer.current);
      quitTimer.current = setTimeout(() => {
        quitArmed.current = false;
        quitTimer.current = null;
      }, quitWindowMs);
      return;
    }
    if (matches(event, "app.redraw")) return;
    if (key.escape) {
      // §6b: input idle with text → clear the draft INTO history; empty
      // editor → esc does nothing. While a run streams, esc interrupts
      // (app-level) and must NOT eat the draft or the queue (§6d).
      if (!running && editor.text.length > 0 && history !== undefined) {
        void history.record(editor.text);
        onEditorChange(emptyEditor());
      }
      return;
    }
    // Emacs chords.
    if (matches(event, "app.editor.home")) return onEditorChange(applyEditorAction(editor, "home"));
    if (matches(event, "app.editor.end")) return onEditorChange(applyEditorAction(editor, "end"));
    if (matches(event, "app.editor.char.back")) {
      return onEditorChange(applyEditorAction(editor, "char.back"));
    }
    if (matches(event, "app.editor.char.forward")) {
      return onEditorChange(applyEditorAction(editor, "char.forward"));
    }
    if (matches(event, "app.editor.kill.to-end")) {
      return onEditorChange(applyEditorAction(editor, "kill.to-end"));
    }
    if (matches(event, "app.editor.kill.line")) {
      return onEditorChange(applyEditorAction(editor, "kill.line"));
    }
    if (matches(event, "app.editor.kill.word")) {
      return onEditorChange(applyEditorAction(editor, "kill.word"));
    }
    if (matches(event, "app.editor.backspace")) {
      return onEditorChange(editorBackspace(editor));
    }
    // History vs queue-edit share ↑: queued rows win while a run streams.
    if (key.upArrow) {
      if (running && queuedCount > 0) return onQueueEdit();
      if (!running && history !== undefined) {
        const recalled = history.prev();
        if (recalled !== null) return onEditorChange({ text: recalled, cursor: recalled.length });
        return;
      }
      return;
    }
    if (key.downArrow) {
      if (history !== undefined && !running) {
        const recalled = history.next();
        if (recalled === null) return onEditorChange(emptyEditor());
        return onEditorChange({ text: recalled, cursor: recalled.length });
      }
      return;
    }
    // Type the chunk's printable bytes first, then submit on Enter: a PTY
    // can deliver a pasted line as ONE chunk ("task\r"); ink sets key.return
    // only for a lone CR (v0.4 lesson). The submit must see the POST-insert
    // text, so it reads the locally advanced editor, not the render-closure
    // prop (react state updates land after this handler returns).
    const bundledReturn = /[\r\n]/.test(input ?? "");
    let current = editor;
    if (input !== undefined && input.length > 0) {
      const printable = [...input].filter((char) => char !== "\r" && char !== "\n");
      if (printable.length > 0) {
        current = editorInsert(current, printable.join(""));
        onEditorChange(current);
      }
    }
    if (key.return || bundledReturn) {
      // Expand held paste text BEFORE dropping the chunk map: the submit
      // must carry the full pasted content, not the chip markers (§6e).
      const expanded = expandPasteChips(current.text, pasteChunks.current);
      pasteChunks.current.clear();
      // Append on submit (§6f); record() collapses consecutive dupes and
      // ignores whitespace-only drafts.
      void history?.record(expanded);
      history?.reset();
      onSubmit(expanded);
    }
  });

  if (screenReader) {
    return createElement(
      Box,
      { flexDirection: "column" },
      createElement(Text, { "aria-label": "task input" }, editor.text),
      createElement(
        Text,
        { dimColor: true },
        `  ${INPUT_HINT_PARTS.join(` ${symbols.hintSeparator} `)}`,
      ),
    );
  }
  const cursor = Math.min(editor.cursor, editor.text.length);
  return createElement(
    Box,
    { borderStyle: symbols.border, borderColor: "green", paddingX: 1 },
    createElement(Text, { color: "green" }, "> "),
    createElement(Text, null, editor.text.slice(0, cursor)),
    createElement(Text, { inverse: true }, editor.text.slice(cursor, cursor + 1) || " "),
    createElement(Text, null, editor.text.slice(cursor + 1)),
    createElement(
      Text,
      { dimColor: true },
      `  ${INPUT_HINT_PARTS.join(` ${symbols.hintSeparator} `)}`,
    ),
  );
}
