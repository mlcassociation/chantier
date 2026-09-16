import type { ApprovalDecision } from "@chantier/permissions";
import { Box, render, Static, Text, useApp, useInput } from "ink";
import { createElement, useEffect, type ReactNode, useSyncExternalStore } from "react";
import type { TuiState, TuiStore } from "./store.ts";

const PROMPT_HINT = "y allow · a always · n deny · esc abort";
const INPUT_HINT = "type a task · enter run · q quit";

export function TuiApp({ store }: { store: TuiStore }) {
  const state = useSyncExternalStore(store.subscribe, () => store.state);
  const { exit } = useApp();

  useInput((input, key) => {
    if (process.env.CHANTIER_DEBUG_INPUT !== undefined) {
      process.stderr.write(
        `[key] input=${JSON.stringify(input)} return=${key.return} esc=${key.escape} ctrl=${key.ctrl}\n`,
      );
    }
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
      if (key.return) {
        store.submitTask(store.state.inputText);
        return;
      }
      if (key.backspace || key.delete) {
        store.backspaceInput();
        return;
      }
      if (input !== undefined && input.length > 0) {
        for (const char of input) {
          if (char !== "\r" && char !== "\n") store.typeInput(char);
        }
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
    // biome-ignore lint/correctness/noChildrenProp: ink 7's Static API takes the render function as a children prop
    createElement(Static, {
      items: [...state.lines],
      children: (item: unknown, index: number) =>
        createElement(Text, { key: index, dimColor: index < state.lines.length }, String(item)),
    }),
  ];
  if (state.streamText.length > 0) {
    children.push(createElement(Text, { color: "cyan" }, state.streamText));
  }
  if (state.status.length > 0) {
    children.push(createElement(Text, { dimColor: true }, state.status));
  }
  if (state.prompt !== null) {
    children.push(
      createElement(
        Box,
        { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1 },
        createElement(Text, { bold: true, color: "yellow" }, `approve ${state.prompt.tool}?`),
        createElement(Text, { dimColor: true }, summarizeInput(state.prompt.input)),
        createElement(Text, null, PROMPT_HINT),
      ),
    );
  }
  if (state.mode === "input" && !state.finished) {
    children.push(
      createElement(
        Box,
        { borderStyle: "round", borderColor: "green", paddingX: 1 },
        createElement(Text, { color: "green" }, "> "),
        createElement(Text, null, state.inputText),
        createElement(Text, { dimColor: true }, `  ${INPUT_HINT}`),
      ),
    );
  }

  return createElement(Box, { flexDirection: "column" }, ...children);
}

function summarizeInput(input: unknown): string {
  const json = JSON.stringify(input);
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}

/** Maps a prompt keypress to a decision; null = key not handled by the prompt. */
export function keypressToDecision(key: string): ApprovalDecision | null {
  if (key === "y") return { approved: true };
  if (key === "a") return { approved: true, remember: true };
  if (key === "n") return { approved: false, reason: "user denied" };
  return null;
}

export interface TuiInstance {
  waitUntilExit(): Promise<void>;
}

/** Mounts the TUI. The store drives everything; the caller drives the agent. */
export function startTui(store: TuiStore): TuiInstance {
  const instance = render(createElement(TuiApp, { store }), { exitOnCtrlC: false });
  return { waitUntilExit: () => instance.waitUntilExit().then(() => undefined) };
}
