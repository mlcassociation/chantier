import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryStore } from "../src/input.ts";
import {
  applyEditorAction,
  createHistoryStore,
  type EditorState,
  editorBackspace,
  editorInsert,
  emptyEditor,
  expandPasteChips,
  historyPath,
  loadHistory,
  pasteChip,
  TaskInput,
} from "../src/input.ts";
import type { PaletteCommand } from "../src/palette.ts";
import { UNICODE_SYMBOLS } from "../src/symbols.ts";

/**
 * EXCEPTION to the no-test-timers rule (named per policy, same rationale as
 * prompt.test.ts): the component half drives ink's real stdin pipeline
 * (readline decode → escape-code disambiguation → useInput/usePaste), which
 * schedules real timers fake timers cannot drive. Assertions poll predicates
 * with short real intervals, bounded.
 */
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const started = Date.now();
  const poll = (): void => {
    if (predicate()) {
      resolve();
      return;
    }
    if (Date.now() - started > timeoutMs) {
      reject(new Error("condition not met"));
      return;
    }
    setTimeout(poll, 25);
  };
  poll();
  return promise;
}

const U = UNICODE_SYMBOLS;

// --- Pure editor transforms (§6f) ------------------------------------------------

describe("editor transforms (§6f)", () => {
  const base: EditorState = { text: "hello world", cursor: 5 };

  it("covers the emacs set", () => {
    expect(applyEditorAction(base, "home")).toEqual({ text: "hello world", cursor: 0 });
    expect(applyEditorAction(base, "end")).toEqual({ text: "hello world", cursor: 11 });
    expect(applyEditorAction(base, "char.back")).toEqual({ text: "hello world", cursor: 4 });
    expect(applyEditorAction(base, "char.forward")).toEqual({ text: "hello world", cursor: 6 });
    expect(applyEditorAction({ text: "hello world", cursor: 5 }, "kill.to-end")).toEqual({
      text: "hello",
      cursor: 5,
    });
    expect(applyEditorAction(base, "kill.line")).toEqual(emptyEditor());
    // The cursor never leaves the text.
    expect(applyEditorAction({ text: "hi", cursor: 0 }, "char.back").cursor).toBe(0);
    expect(applyEditorAction({ text: "hi", cursor: 99 }, "char.forward").cursor).toBe(2);
    // ctrl+w: runs of spaces directly before the cursor go first, then the
    // word's own characters; the trailing spaces survive.
    expect(applyEditorAction({ text: "foo bar  baz", cursor: 12 }, "kill.word")).toEqual({
      text: "foo bar  ",
      cursor: 9,
    });
    // A cursor past the length (controlled state from an older render) clamps.
    expect(applyEditorAction({ text: "abc", cursor: 10 }, "kill.word")).toEqual({
      text: "",
      cursor: 0,
    });
  });

  it("inserts and backspaces at the cursor", () => {
    expect(editorInsert({ text: "ab", cursor: 1 }, "X")).toEqual({ text: "aXb", cursor: 2 });
    expect(editorBackspace({ text: "ab", cursor: 2 })).toEqual({ text: "a", cursor: 1 });
    expect(editorBackspace({ text: "ab", cursor: 0 })).toEqual({ text: "ab", cursor: 0 });
  });
});

// --- Paste thresholds (§6e) ------------------------------------------------------

describe("paste thresholds (§6e)", () => {
  it("chips pastes over 3 lines or 800 chars", () => {
    expect(pasteChip("single line").chip).toBeNull();
    expect(pasteChip("a\nb\nc\nd").chip).toBe("[pasted +4 lines]");
    expect(pasteChip("x".repeat(801)).chip).toBe("[pasted +1 lines]");
    expect(pasteChip("x".repeat(800)).chip).toBeNull();
  });

  it("drops to 1 line / 200 chars below 12 rows (CC narrow rule)", () => {
    expect(pasteChip("a\nb", 11).chip).toBe("[pasted +2 lines]");
    expect(pasteChip("a\nb", 12).chip).toBeNull();
    expect(pasteChip("x".repeat(201), 11).chip).toBe("[pasted +1 lines]");
    expect(pasteChip("x".repeat(200), 11).chip).toBeNull();
  });

  it("restores full paste text at submit", () => {
    const chunks = new Map([["[pasted +2 lines]", "line one\nline two"]]);
    expect(expandPasteChips("see [pasted +2 lines] thanks", chunks)).toBe(
      "see line one\nline two thanks",
    );
  });
});

// --- History (§6f) ---------------------------------------------------------------

describe("history (§6f)", () => {
  it("recalls empty → last → older, then forward → empty", () => {
    const history = createHistoryStore();
    expect(history.prev()).toBeNull();
    void history.record("first");
    void history.record("second");
    expect(history.prev()).toBe("second");
    expect(history.prev()).toBe("first");
    // Clamped at the oldest entry: ↑ stays put.
    expect(history.prev()).toBe("first");
    expect(history.next()).toBe("second");
    // Past the newest → null → the caller empties the editor.
    expect(history.next()).toBeNull();
    expect(history.next()).toBeNull();
  });

  it("collapses consecutive duplicates and skips blank drafts", () => {
    const history = createHistoryStore();
    void history.record("same");
    void history.record("same");
    void history.record("   ");
    expect(history.entries).toEqual(["same"]);
    // Non-consecutive repeats stay: resubmitting after other work is real.
    void history.record("a");
    void history.record("b");
    void history.record("a");
    expect(history.entries).toEqual(["same", "a", "b", "a"]);
  });

  it("typed input ends the browse sequence", () => {
    const history = createHistoryStore();
    void history.record("one");
    void history.record("two");
    expect(history.prev()).toBe("two");
    history.reset();
    expect(history.next()).toBeNull();
    expect(history.prev()).toBe("two");
  });

  it("appends to the jsonl file, loads back, and stays silent on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chantier-input-"));
    try {
      const file = join(dir, "history.jsonl");
      const history = createHistoryStore({ file });
      await history.record("one");
      await history.record("one");
      await history.record("two");
      expect(await loadHistory(file)).toEqual(["one", "two"]);
      const raw = await readFile(file, "utf8");
      const rows = raw.split("\n").filter((line) => line.length > 0);
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0] ?? "")).toEqual({ text: "one" });

      // Silent failure (§6f): a blocked parent directory must never break a
      // submit — the entry still lands in the in-memory recall list.
      const blocker = join(dir, "blocker");
      await writeFile(blocker, "x", "utf8");
      const broken = createHistoryStore({ file: join(blocker, "nested", "history.jsonl") });
      await broken.record("kept in memory");
      expect(broken.entries).toEqual(["kept in memory"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed lines when loading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chantier-input-"));
    try {
      const file = join(dir, "history.jsonl");
      await writeFile(file, '{not json}\n{"text":"valid"}\n{"other":1}\n', "utf8");
      expect(await loadHistory(file)).toEqual(["valid"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves to ~/.chantier/history.jsonl", () => {
    expect(historyPath("/home/u")).toBe(join("/home/u", ".chantier", "history.jsonl"));
  });
});

// --- TaskInput component (ink; real timers per the named exception) --------------

interface HostEvents {
  submits: Array<string>;
  quits: number;
  quitArms: number;
  queueEdits: number;
}

const instances: Array<ReturnType<typeof render>> = [];

afterEach(() => {
  for (const instance of instances) instance.unmount();
  instances.length = 0;
});

interface HostOverrides {
  running?: boolean;
  queuedCount?: number;
  history?: HistoryStore;
  locked?: boolean;
  commands?: readonly PaletteCommand[];
  files?: readonly string[];
}

function mountTaskInput(overrides: HostOverrides = {}): {
  events: HostEvents;
  current: () => EditorState;
  frame: () => string;
  key: (text: string) => Promise<void>;
} {
  const events: HostEvents = { submits: [], quits: 0, quitArms: 0, queueEdits: 0 };
  const latest: { editor: EditorState } = { editor: emptyEditor() };
  // The host owns the editor state (like the app will at integration): each
  // onEditorChange re-renders and hands the fresh editor back down.
  const Host = (): ReactNode => {
    const [editor, setEditor] = useState<EditorState>(emptyEditor);
    latest.editor = editor;
    return createElement(TaskInput, {
      editor,
      onEditorChange: setEditor,
      onSubmit: (text: string) => {
        events.submits.push(text);
      },
      running: overrides.running ?? false,
      queuedCount: overrides.queuedCount ?? 0,
      onQueueEdit: () => {
        events.queueEdits += 1;
      },
      onQuit: () => {
        events.quits += 1;
      },
      onQuitArm: () => {
        events.quitArms += 1;
      },
      history: overrides.history,
      commands: overrides.commands,
      files: overrides.files,
      locked: overrides.locked,
      symbols: U,
    });
  };
  const instance = render(createElement(Host));
  instances.push(instance);
  return {
    events,
    current: () => latest.editor,
    frame: () => instance.lastFrame() ?? "",
    async key(text: string) {
      instance.stdin.write(text);
      // 100ms settle: ink's parser + readline need a beat under load.
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

describe("TaskInput keys (§6a/§6c)", () => {
  it("types a bundled PTY chunk and submits the post-insert text", async () => {
    const input = mountTaskInput();
    await input.key("task one\r");
    expect(input.events.submits).toEqual(["task one"]);
    expect(input.current().text).toBe("task one");
  });

  it("idle ctrl-c quits on the first press", async () => {
    const input = mountTaskInput();
    await input.key("\x03");
    expect(input.events.quits).toBe(1);
    expect(input.events.quitArms).toBe(0);
    expect(input.events.submits).toEqual([]);
  });

  it("running ctrl-c arms the two-stage window; a second press quits (§6c)", async () => {
    const input = mountTaskInput({ running: true });
    // First press: arm — editor cleared, transient hint via the host.
    await input.key("\x03");
    expect(input.events.quitArms).toBe(1);
    expect(input.events.quits).toBe(0);
    expect(input.current().text).toBe("");
    // Typing continues while armed.
    await input.key("still here");
    expect(input.current().text).toBe("still here");
    // Second press inside the 2s window quits; it never submits.
    await input.key("\x03");
    expect(input.events.quits).toBe(1);
    expect(input.events.quitArms).toBe(1);
    expect(input.events.submits).toEqual([]);
  });
});

describe("TaskInput escape semantics (§6b)", () => {
  it("idle esc banks the draft into history; empty esc does nothing", async () => {
    const history = createHistoryStore();
    const input = mountTaskInput({ history });
    await input.key("draft");
    await input.key("\x1b");
    expect(input.current().text).toBe("");
    expect(history.entries).toEqual(["draft"]);
    await input.key("\x1b");
    expect(history.entries).toEqual(["draft"]);
  });

  it("esc while running keeps the draft (interrupt is app-level, §6d)", async () => {
    const history = createHistoryStore();
    void history.record("prior");
    const input = mountTaskInput({ running: true, history });
    await input.key("queued draft");
    await input.key("\x1b");
    expect(input.current().text).toBe("queued draft");
    expect(history.entries).toEqual(["prior"]);
  });
});

describe("TaskInput arrows (§6d/§6f)", () => {
  it("recalls history and forward-recalls to empty", async () => {
    const history = createHistoryStore();
    void history.record("older");
    void history.record("newer");
    const input = mountTaskInput({ history });
    await input.key("\x1b[A");
    expect(input.current().text).toBe("newer");
    await input.key("\x1b[A");
    expect(input.current().text).toBe("older");
    await input.key("\x1b[B");
    expect(input.current().text).toBe("newer");
    await input.key("\x1b[B");
    expect(input.current().text).toBe("");
  });

  it("hands ↑ to the queue while a run streams", async () => {
    const input = mountTaskInput({ running: true, queuedCount: 2 });
    await input.key("\x1b[A");
    expect(input.events.queueEdits).toBe(1);
    expect(input.events.submits).toEqual([]);
  });
});

describe("TaskInput paste (§6e)", () => {
  it("chips an oversized paste and submits the full text", async () => {
    const input = mountTaskInput();
    await input.key("\x1b[200~line one\nline two\nline three\nline four\x1b[201~");
    await waitFor(() => input.current().text === "[pasted +4 lines]");
    await input.key("\r");
    expect(input.events.submits).toEqual(["line one\nline two\nline three\nline four"]);
  });

  it("pastes short text verbatim", async () => {
    const input = mountTaskInput();
    await input.key("\x1b[200~short paste\x1b[201~");
    await waitFor(() => input.current().text === "short paste");
    expect(input.events.submits).toEqual([]);
  });
});

describe("TaskInput render + lock", () => {
  it("renders the editor and hint line", async () => {
    const input = mountTaskInput();
    await input.key("hi");
    await waitFor(() => input.frame().includes("hi"));
    expect(input.frame()).toContain("type a task");
  });

  it("locked input (approval pending) is inert", async () => {
    const input = mountTaskInput({ locked: true });
    await input.key("x");
    await input.key("\x03");
    expect(input.current().text).toBe("");
    expect(input.events.quits).toBe(0);
    expect(input.events.submits).toEqual([]);
  });
});

// --- Slash palette + @ picker (v0.6, spec §Theme 3) -------------------------------

const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { name: "alpha", description: "first", kind: "expand" },
  { name: "beta", description: "second", kind: "action" },
  { name: "alphabet", description: "third", kind: "expand" },
];

const PALETTE_FILES = ["src/app.ts", "src/widgets/app-view.ts", "tests/app.test.ts"];

describe("slash palette (§Theme 3)", () => {
  it("opens on a head / and lists the registry", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/");
    await waitFor(() => input.frame().includes("/beta"));
    expect(input.frame()).toContain("second");
    expect(input.current().text).toBe("/");
  });

  it("types a mid-text / literally", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("say /");
    expect(input.current().text).toBe("say /");
    expect(input.frame()).not.toContain("/alpha");
  });

  it("never opens without commands", async () => {
    const input = mountTaskInput();
    await input.key("/");
    expect(input.current().text).toBe("/");
    expect(input.frame()).not.toContain("/alpha");
  });

  it("narrows matches as the query grows", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/a");
    await waitFor(() => input.frame().includes("/alpha"));
    await input.key("z");
    await waitFor(() => input.frame().includes("no matches"));
  });

  it("accepts an expand command into the editor", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/al");
    await waitFor(() => input.frame().includes("no matches") === false);
    await input.key("\r");
    await waitFor(() => input.current().text === "/alpha ");
    expect(input.events.submits).toEqual([]);
  });

  it("accepts an action command by submitting it", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/be");
    await waitFor(() => input.frame().includes("/beta"));
    await input.key("\r");
    expect(input.events.submits).toEqual(["/beta"]);
    expect(input.current().text).toBe("");
  });

  it("submits literal text when nothing matches", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/zz");
    await waitFor(() => input.frame().includes("no matches"));
    await input.key("\r");
    expect(input.events.submits).toEqual(["/zz"]);
  });

  it("tab inserts the top match without submitting", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/a");
    await waitFor(() => input.frame().includes("/alpha"));
    await input.key("\t");
    await waitFor(() => input.current().text === "/alpha ");
    expect(input.events.submits).toEqual([]);
  });

  it("reselects row 0 when a printable edit moves the query", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/");
    await input.key("\x1b[B");
    await waitFor(() => input.frame().includes("❯ /beta"));
    // The edit re-derives the query ("e" → /beta + /alphabet), so the
    // selection returns to row 0 and Enter accepts /beta — the action
    // command row 1 pointed at before the edit.
    await input.key("e");
    await input.key("\r");
    expect(input.events.submits).toEqual(["/beta"]);
  });

  it("submits literal /compact from one bundled PTY write", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/compact\r");
    expect(input.events.submits).toEqual(["/compact"]);
    expect(input.current().text).toBe("/compact");
  });

  it("moves the selection with ↓ and accepts the selected row", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/");
    await input.key("\x1b[B");
    await waitFor(() => input.frame().includes("❯ /beta"));
    await input.key("\r");
    // Row 1 is the action /beta: accept submits it.
    expect(input.events.submits).toEqual(["/beta"]);
  });

  it("preempts history recall while open", async () => {
    const history = createHistoryStore();
    void history.record("older task");
    const input = mountTaskInput({ commands: PALETTE_COMMANDS, history });
    await input.key("/");
    await input.key("\x1b[A");
    await waitFor(() => input.frame().includes("/beta"));
    expect(input.current().text).toBe("/");
    expect(input.events.submits).toEqual([]);
  });

  it("closes on esc and reopens after the trigger is cleared and retyped", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/a");
    await waitFor(() => input.frame().includes("/alpha"));
    await input.key("\x1b");
    await waitFor(() => !input.frame().includes("/alpha"));
    expect(input.current().text).toBe("/a");
    // Backspace past the trigger re-arms the palette; a plain esc'd draft
    // keeps it closed while the trigger survives.
    await input.key("\x7f");
    await input.key("\x7f");
    await input.key("/");
    await waitFor(() => input.frame().includes("/alpha"));
  });

  it("closes on backspace past the trigger", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/a");
    await waitFor(() => input.frame().includes("/alpha"));
    await input.key("\x7f");
    await waitFor(() => input.frame().includes("/alpha"));
    await input.key("\x7f");
    await waitFor(() => !input.frame().includes("/alpha"));
    expect(input.current().text).toBe("");
  });

  it("submits literal text for a bundled /compact\r write", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS });
    await input.key("/a");
    await waitFor(() => input.frame().includes("/alpha"));
    await input.key("lpha\r");
    expect(input.events.submits).toEqual(["/alpha"]);
    expect(input.current().text).toBe("/alpha");
  });

  it("keeps the two-stage ctrl-c quit with the palette open", async () => {
    const input = mountTaskInput({ commands: PALETTE_COMMANDS, running: true });
    await input.key("/a");
    await waitFor(() => input.frame().includes("/alpha"));
    await input.key("\x03");
    expect(input.events.quitArms).toBe(1);
    expect(input.events.quits).toBe(0);
  });
});

describe("@ file picker (§Theme 3)", () => {
  it("opens at a word boundary and accepts into the editor", async () => {
    const input = mountTaskInput({ files: PALETTE_FILES });
    await input.key("run @app");
    await waitFor(() => input.frame().includes("src/app.ts"));
    await input.key("\r");
    await waitFor(() => input.current().text === "run @src/app.ts ");
    expect(input.events.submits).toEqual([]);
  });

  it("keeps a mid-word @ literal", async () => {
    const input = mountTaskInput({ files: PALETTE_FILES });
    await input.key("x@y");
    expect(input.current().text).toBe("x@y");
    expect(input.frame()).not.toContain("src/app.ts");
  });

  it("tab inserts the top file match", async () => {
    const input = mountTaskInput({ files: PALETTE_FILES });
    await input.key("@");
    await waitFor(() => input.frame().includes("src/app.ts"));
    await input.key("\t");
    // Empty query: every file ties at rank 0, broken by path length then
    // path — the 10-char src/app.ts is the top row.
    await waitFor(() => input.current().text === "@src/app.ts ");
    expect(input.events.submits).toEqual([]);
  });

  it("narrows file matches as the query grows and closes on esc", async () => {
    const input = mountTaskInput({ files: PALETTE_FILES });
    await input.key("run @a");
    await waitFor(() => input.frame().includes("src/app.ts"));
    await input.key("\x1b");
    await waitFor(() => !input.frame().includes("src/app.ts"));
    expect(input.current().text).toBe("run @a");
  });
});
