import type { ApprovalDecision } from "@chantier/permissions";
import { Box, render, Static, Text, useApp, useInput, useIsScreenReaderEnabled } from "ink";
import { createElement, type ReactNode, useEffect, useSyncExternalStore } from "react";
import { classifyUnifiedDiffLine, type DiffLineKind, summarizeUnifiedDiff } from "./diff.ts";
import { resolveScreenReader } from "./screen-reader.ts";
import type { TuiPromptDetail, TuiStore } from "./store.ts";
import { isAsciiEnv, resolveSymbols, type TuiSymbols } from "./symbols.ts";

const PROMPT_HINT_PARTS = ["y allow", "a always", "n deny", "esc abort"] as const;
const INPUT_HINT_PARTS = ["type a task", "enter run", "q quit"] as const;

export function TuiApp({ store }: { store: TuiStore }) {
  const state = useSyncExternalStore(store.subscribe, () => store.state);
  const screenReader = useIsScreenReaderEnabled();
  const symbols = resolveSymbols(screenReader || isAsciiEnv(process.env.CHANTIER_ASCII));
  const { exit } = useApp();

  useInput((input, key) => {
    // Read state live at event time: the render closure can be a render or two
    // behind (ink batches renders), and a stale mode/prompt pair swallows keys.
    const { mode, prompt } = store.state;
    if (key.ctrl) {
      store.abort("ctrl-c");
      return;
    }
    if (key.escape) {
      store.abort("escape");
      return;
    }
    if (mode === "input" && prompt === null) {
      if (key.backspace || key.delete) {
        store.backspaceInput();
        return;
      }
      // Type the chunk's printable bytes first, then submit on Enter: a PTY
      // can deliver a pasted line as ONE chunk ("task\r"). ink sets key.return
      // only for a lone CR, so a bundled line is detected from the raw chunk
      // containing a line break; handling key.return before the chars would
      // submit an empty box.
      const bundledReturn = /[\r\n]/.test(input ?? "");
      if (input !== undefined && input.length > 0) {
        for (const char of input) {
          if (char !== "\r" && char !== "\n") store.typeInput(char);
        }
      }
      if (key.return || bundledReturn) {
        store.submitTask(store.state.inputText);
      }
      return;
    }
    if (prompt !== null) {
      // A PTY can deliver the key plus its Enter in one chunk ("y\r"): strip
      // line-break bytes before matching the decision key.
      const decision = keypressToDecision(input.replace(/[\r\n]/g, ""));
      if (decision !== null) store.decide(decision);
    }
  });

  // Unmount after the farewell frame exists; resolves waitUntilExit. The
  // effect is unconditional (hooks rules); the guard lives in its body.
  useEffect(() => {
    if (!store.state.finished) return;
    const timer = setTimeout(exit, 50);
    return () => clearTimeout(timer);
  });

  const children: Array<ReactNode> = [
    createElement(Static, {
      items: [...state.lines],
      // biome-ignore lint/correctness/noChildrenProp: ink 7's Static API takes the render function as a children prop
      children: (item: unknown, index: number) => createElement(Text, { key: index }, String(item)),
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
  if (state.status.length > 0) {
    children.push(createElement(Text, { dimColor: true }, state.status));
  }
  if (state.prompt !== null) {
    const { tool, input } = state.prompt;
    children.push(
      createElement(
        Box,
        {
          flexDirection: "column",
          borderStyle: symbols.border,
          borderColor: "yellow",
          paddingX: 1,
          "aria-role": "button",
        },
        createElement(
          Text,
          { bold: true, color: "yellow", "aria-label": approvalLabel(tool, input) },
          `approve ${tool}?`,
        ),
        createElement(Text, { dimColor: true }, summarizeInput(input, symbols.ellipsis)),
        diffCard(state.promptDetail, symbols),
        createElement(Text, null, PROMPT_HINT_PARTS.join(` ${symbols.hintSeparator} `)),
      ),
    );
  }
  if (state.mode === "input" && !state.finished) {
    children.push(
      createElement(
        Box,
        { borderStyle: symbols.border, borderColor: "green", paddingX: 1 },
        createElement(Text, { color: "green" }, "> "),
        createElement(Text, null, state.inputText),
        createElement(
          Text,
          { dimColor: true },
          `  ${INPUT_HINT_PARTS.join(` ${symbols.hintSeparator} `)}`,
        ),
      ),
    );
  }

  return createElement(Box, { flexDirection: "column" }, ...children);
}

/** The unified-diff attachment card, or null when the ask carries no diff. */
function diffCard(detail: TuiPromptDetail | null, symbols: TuiSymbols): ReactNode {
  if (detail === null) return null;
  if (typeof detail.diff !== "string" || detail.diff.length === 0) return null;
  const preview = summarizeUnifiedDiff(detail.diff);
  return createElement(
    Box,
    {
      flexDirection: "column",
      borderStyle: symbols.border,
      borderColor: "cyan",
      paddingX: 1,
      "aria-label": `proposed change: ${preview.additions} ${preview.additions === 1 ? "addition" : "additions"}, ${preview.deletions} ${preview.deletions === 1 ? "deletion" : "deletions"}`,
    },
    createElement(Text, { dimColor: true }, "proposed change"),
    ...preview.lines.map((line, index) =>
      createElement(Text, { key: index, ...diffTextStyle(classifyUnifiedDiffLine(line)) }, line),
    ),
    preview.hiddenLines > 0
      ? createElement(Text, { dimColor: true }, `+${preview.hiddenLines} more lines`)
      : null,
  );
}

function diffTextStyle(kind: DiffLineKind): { color?: string; dimColor?: boolean } {
  if (kind === "add") return { color: "green" };
  if (kind === "del") return { color: "red" };
  if (kind === "meta") return { dimColor: true };
  return {};
}

function summarizeInput(input: unknown, ellipsis: string): string {
  const json = JSON.stringify(input);
  return json.length > 160 ? `${json.slice(0, 160)}${ellipsis}` : json;
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

/** Maps a prompt keypress to a decision; null = key not handled by the prompt. */
export function keypressToDecision(key: string): ApprovalDecision | null {
  // PTYs can bundle the key with its Enter ("y\r") in one chunk: strip
  // line-break bytes before matching.
  const clean = key.replace(/[\r\n]/g, "");
  if (clean === "y") return { approved: true };
  if (clean === "a") return { approved: true, remember: true };
  if (clean === "n") return { approved: false, reason: "user denied" };
  return null;
}

export interface TuiOptions {
  /** Opt-in screen-reader rendering (also honored: CHANTIER_SCREEN_READER=1). */
  readonly screenReader?: boolean;
}

export interface TuiInstance {
  waitUntilExit(): Promise<void>;
}

/** Mounts the TUI. The store drives everything; the caller drives the agent. */
export function startTui(store: TuiStore, options: TuiOptions = {}): TuiInstance {
  const screenReader = resolveScreenReader(
    options.screenReader,
    process.env.CHANTIER_SCREEN_READER,
  );
  const instance = render(createElement(TuiApp, { store }), {
    exitOnCtrlC: false,
    ...(screenReader ? { isScreenReaderEnabled: true } : {}),
  });
  return { waitUntilExit: () => instance.waitUntilExit().then(() => undefined) };
}
