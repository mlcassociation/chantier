import {
  Box,
  render,
  Static,
  Text,
  useApp,
  useInput,
  useIsScreenReaderEnabled,
  useWindowSize,
} from "ink";
import {
  createElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createHistoryStore,
  type EditorState,
  emptyEditor,
  type HistoryStore,
  historyPath,
  loadHistory,
  QUIT_WINDOW_MS,
  TaskInput,
} from "./input.ts";
import type { TuiItem } from "./items.ts";
import { keypressToDecision } from "./keys.ts";
import { renderMark, tuiVersion } from "./mark.ts";
import { markdownToElements } from "./markdown.ts";
import { resolveScreenReader } from "./screen-reader.ts";
import type { TuiStore } from "./store.ts";
import { isAsciiEnv, resolveSymbols, type TuiSymbols } from "./symbols.ts";
import {
  ApprovalCardV2,
  Divider,
  FooterBar,
  QueuePreview,
  StatusWidget,
  TodoItem,
  TodoTrail,
  ToolRow,
} from "./widgets.ts";

/** Footer data computed by the caller per render (context estimate + compact gate). */
export interface FooterData {
  readonly ctxFraction?: number;
  readonly compactSoon?: boolean;
}

export function TuiApp({
  store,
  footer,
  tips,
}: {
  store: TuiStore;
  tips?: boolean;
  footer?: {
    readonly model: string;
    readonly sessionId: string;
    readonly contextWindow?: number;
    readonly data?: () => FooterData;
  };
}) {
  const state = useSyncExternalStore(store.subscribe, () => store.state);
  const screenReader = useIsScreenReaderEnabled();
  const ascii = isAsciiEnv(process.env.CHANTIER_ASCII);
  const symbols = resolveSymbols(screenReader || ascii);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  const [quitArmed, setQuitArmed] = useState(false);
  // The armed hint must clear with the SAME window TaskInput disarms on;
  // otherwise the hint lingers after the quit window expires.
  const quitHintTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const armQuitHint = (): void => {
    setQuitArmed(true);
    clearTimeout(quitHintTimer.current);
    quitHintTimer.current = setTimeout(() => {
      setQuitArmed(false);
      quitHintTimer.current = undefined;
    }, QUIT_WINDOW_MS);
  };
  // History loads async (file read); TaskInput guards on undefined until the
  // first read resolves, so a missing/broken history file degrades to no recall.
  const [history, setHistory] = useState<HistoryStore | undefined>(undefined);
  useEffect(() => {
    void loadHistory(historyPath()).then((entries) => {
      setHistory(createHistoryStore({ entries, file: historyPath() }));
    });
  }, []);

  // Global keys only: approval decisions and esc-interrupt. The editor, quit
  // two-stage, history, and paste live in TaskInput's own useInput (mounted
  // whenever the composer is on screen), so no key is handled twice.
  useInput((input, key) => {
    // Read state live at event time: the render closure can be a render or two
    // behind (ink batches renders), and a stale prompt pair swallows keys.
    const { prompt, running } = store.state;
    if (prompt !== null) {
      // A PTY can deliver the key plus its Enter in one chunk ("y\r"): strip
      // line-break bytes before matching the decision key.
      const decision = keypressToDecision((input ?? "").replace(/[\r\n]/g, ""));
      if (decision !== null) {
        store.decide(decision);
        return;
      }
      // The card's own abort chord: esc denies the pending ask and notifies.
      if (key.escape) {
        store.abort("escape");
        return;
      }
      // ctrl-c during an approval: TaskInput is locked and never sees it, so
      // the app-level handler keeps the v0.4 abort contract. Outside the
      // prompt, TaskInput's mounted quit handler owns ctrl-c (two-stage).
      if (key.ctrl) {
        store.abort("ctrl-c");
      }
      return;
    }
    if (key.escape && running !== null) {
      store.abort("escape");
    }
  });

  // Unmount after the farewell frame exists; resolves waitUntilExit. The
  // effect is unconditional (hooks rules); the guard lives in its body.
  useEffect(() => {
    if (!store.state.finished) return;
    const timer = setTimeout(exit, 50);
    return () => clearTimeout(timer);
  });

  // ink 7.1.1 holds exactly ONE static node per tree (root.staticNode), so
  // the Mark ships as the FIRST item of the transcript's own Static —
  // append-once semantics preserved, no second Static slot to fight over.
  const MARK_ITEM = Symbol.for("chantier.mark");
  const markOptions = {
    columns,
    symbols,
    screenReader,
    version: tuiVersion(),
    ...(footer?.model === undefined ? {} : { model: footer.model }),
    ...(footer?.sessionId === undefined ? {} : { sessionId: footer.sessionId }),
    ...(tips === undefined ? {} : { tips }),
  };
  const children: Array<ReactNode> = [
    createElement(Static, {
      items: [MARK_ITEM, ...state.items],
      // biome-ignore lint/correctness/noChildrenProp: ink 7's Static API takes the render function as a children prop
      children: (item: unknown, index: number) =>
        createElement(
          Box,
          { key: `t-${index}` },
          item === MARK_ITEM
            ? renderMark(markOptions)
            : itemNode(item as TuiItem, index, symbols, screenReader, ascii),
        ),
    }),
  ];
  if (state.streamText.length > 0) {
    // The live stream region mutates on every delta, which a screen reader
    // would re-announce per chunk (codex #11823); hide it under SR mode so
    // only finalized Static lines are announced.
    children.push(
      createElement(Text, { color: "cyan", "aria-hidden": screenReader }, state.streamText),
    );
  }
  if (state.running !== null && state.prompt === null) {
    children.push(
      createElement(StatusWidget, {
        running: state.running,
        status: state.statusFlash.length > 0 ? state.statusFlash : state.status,
        items: state.items,
        queuedCount: state.queued.length,
        symbols,
        screenReader,
      }),
    );
  }
  if (state.running !== null && state.prompt === null && state.todos.length > 0) {
    children.push(createElement(TodoTrail, { todos: state.todos, symbols }));
  }
  if (state.prompt !== null) {
    const detail = state.promptDetail;
    children.push(
      createElement(ApprovalCardV2, {
        request: state.prompt,
        detail: detail === null ? null : { diff: detail.diff },
        symbols,
        screenReader,
      }),
    );
  }
  if (!state.finished) {
    if (quitArmed) {
      children.push(createElement(Text, { dimColor: true }, "press ctrl-c again to quit"));
    }
    children.push(
      createElement(TaskInput, {
        editor,
        onEditorChange: (next) => setEditor(next),
        onSubmit: (text) => {
          setEditor(emptyEditor());
          if (store.state.running !== null) {
            store.pushQueued(text);
            return;
          }
          store.submitTask(text);
        },
        running: state.running !== null,
        queuedCount: state.queued.length,
        onQueueEdit: () => {
          const last = store.state.queued.at(-1);
          if (last === undefined) return;
          store.dropQueued();
          setEditor({ text: last, cursor: last.length });
        },
        locked: state.prompt !== null,
        rows,
        history,
        onQuit: () => store.abort("ctrl-c"),
        onQuitArm: armQuitHint,
        symbols,
        screenReader,
      }),
    );
  }
  children.push(createElement(QueuePreview, { queued: state.queued, symbols }));
  const footerData = footer?.data?.();
  children.push(
    createElement(FooterBar, {
      model: footer?.model ?? "chantier",
      ctxFraction: footerData?.ctxFraction,
      compactSoon: footerData?.compactSoon === true ? true : undefined,
      usage: state.usage,
      sessionId: footer?.sessionId ?? "",
      columns,
      symbols,
      hidden: state.prompt !== null,
    }),
  );

  return createElement(Box, { flexDirection: "column" }, ...children);
}

/**
 * Renders one finalized transcript item (spec §1). `ascii` gates the BUG-6
 * echo's flat "you:" form (same grouping as screen-reader parity); visual
 * mode renders the accent prompt glyph + plain wrapped text.
 */
function itemNode(
  item: TuiItem,
  index: number,
  symbols: TuiSymbols,
  screenReader: boolean,
  ascii: boolean,
): ReactNode {
  switch (item.kind) {
    case "markdown":
      return createElement(
        Box,
        { key: index, flexDirection: "column" },
        ...markdownToElements(item.text, symbols, screenReader),
      );
    case "divider":
      return createElement(Divider, { key: index, text: item.text, symbols, screenReader });
    case "tool":
      return createElement(ToolRow, { key: index, item, symbols, screenReader });
    case "info":
      return createElement(Text, { key: index }, item.text);
    case "error":
      return createElement(Text, { key: index, color: "red" }, item.text);
    case "prompt":
      if (screenReader || ascii) return createElement(Text, { key: index }, `you: ${item.text}`);
      return createElement(
        Box,
        { key: index },
        createElement(Text, { key: "glyph", dimColor: true, color: "cyan" }, symbols.promptGlyph),
        createElement(Text, { key: "text" }, ` ${item.text}`),
      );
    case "todo":
      return createElement(TodoItem, { key: index, text: item.text, symbols, screenReader });
  }
}

/** Screen-reader label for the approval card (ink serializes it as the button name). */
export function approvalLabel(tool: string, input: unknown): string {
  const subject = inputSubject(input);
  return subject.length > 0 ? `approve ${tool} of ${subject}` : `approve ${tool}`;
}

function inputSubject(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "file"]) {
    const value: unknown = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** Maps a prompt keypress to a decision; null = key not handled by the prompt.
 * Re-exported from keys.ts (the pure action-map dispatch); kept at the app
 * surface for the existing test/import surface. */
export { keypressToDecision } from "./keys.ts";

export interface TuiOptions {
  /** Opt-in screen-reader rendering (also honored: CHANTIER_SCREEN_READER=1). */
  readonly screenReader?: boolean;
  /** Rotating startup tip under the Mark; default on. */
  readonly tips?: boolean;
  /** Footer segments; session id + model come from the CLI, contextWindow gates the ctx segment. */
  readonly footer?: {
    readonly model: string;
    readonly sessionId: string;
    readonly contextWindow?: number;
    readonly data?: () => FooterData;
  };
}

export interface TuiInstance {
  waitUntilExit(): Promise<void>;
}
export function startTui(store: TuiStore, options: TuiOptions = {}): TuiInstance {
  const screenReader = resolveScreenReader(
    options.screenReader,
    process.env.CHANTIER_SCREEN_READER,
  );
  const instance = render(
    createElement(TuiApp, {
      store,
      ...(options.footer === undefined ? {} : { footer: options.footer }),
      ...(options.tips === undefined ? {} : { tips: options.tips }),
    }),
    {
      exitOnCtrlC: false,
      ...(screenReader ? { isScreenReaderEnabled: true } : {}),
    },
  );
  return { waitUntilExit: () => instance.waitUntilExit().then(() => undefined) };
}
