import { createRequire } from "node:module";
import { Box, Static, Text } from "ink";
/**
 * Startup Mark (v0.6 §Theme 4): a brand block printed ONCE as the first
 * append-only Static region — never part of the per-frame dynamic tree.
 * Three width tiers (full/short/tiny); ASCII and screen-reader modes fall
 * back to the plain wordmark tier (symbols.markArt is null there). All text
 * must stay legible at chalk level 0 (NO_COLOR): color is an accent only.
 */
import { createElement, type ReactElement } from "react";
import type { TuiSymbols } from "./symbols.ts";

/** The TUI package version, resolved once from the manifest — never hardcoded. */
export function tuiVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest: unknown = require("../package.json");
  if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
    const { version } = manifest as { version: unknown };
    if (typeof version === "string") return version;
  }
  return "0.0.0";
}

/** Short tier for narrow terminals (48–71 columns). */
export const MARK_ART_SHORT: readonly string[] = [
  "█▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀█",
  "█  chantier · harness █",
  "█▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄█",
];

/** One-line fallback (<48 columns, ASCII mode, screen-reader visual tier). */
export const MARK_WORDMARK = "chantier — the coding harness";

/** Rotating startup tips; picked by a stable hash of the session id. */
export const MARK_TIPS: readonly string[] = [
  "type while a run streams — messages queue and drain when it settles",
  "/ lists commands and skills; /help explains them",
  "@ references a file without leaving the prompt",
  "esc interrupts a running task; queued messages still drain",
  "/compact summarizes the transcript when the context gauge climbs",
  "ctrl-c twice quits — one press just arms the exit",
  "skills live in ~/.chantier/skills/<name>/SKILL.md",
  "chantier reads .mcp.json — MCP servers drop in from Claude Code setups",
];

/** FNV-1a over the session id: stable per session, no RNG in render. */
export function pickTip(sessionId: string, pool: readonly string[] = MARK_TIPS): string {
  let hash = 0x811c9dc5;
  for (const char of sessionId) {
    hash ^= char.charCodeAt(0);
    hash = (hash * 0x01000193) >>> 0;
  }
  return pool[hash % pool.length] ?? pool[0] ?? "";
}

export interface MarkOptions {
  readonly columns: number;
  readonly symbols: TuiSymbols;
  readonly screenReader: boolean;
  readonly version: string;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly tips?: boolean | undefined;
}

function infoLine(options: MarkOptions): string {
  const parts: string[] = [];
  if (options.model !== undefined && options.model.length > 0) parts.push(`model ${options.model}`);
  if (options.sessionId !== undefined && options.sessionId.length > 0) {
    parts.push(`session ${options.sessionId.slice(-8)}`);
  }
  return parts.join(", ");
}

function hintLine(symbols: TuiSymbols): string {
  return [`/ commands`, `@ files`, `esc interrupt`].join(` ${symbols.hintSeparator} `);
}

/**
 * The startup block: full/short art by terminal width, wordmark fallback in
 * ASCII/SR, then version + info + hints + rotating tip. Rendered inside a
 * single-item Static by the app — append-once, never re-rendered.
 */
export function renderMark(options: MarkOptions): ReactElement {
  const { symbols, screenReader, columns } = options;
  const flat = screenReader;
  const art =
    symbols.markArt !== null && columns >= 72
      ? symbols.markArt
      : symbols.markArt !== null && columns >= 48
        ? MARK_ART_SHORT
        : null;
  const tip = options.tips === false ? null : pickTip(options.sessionId ?? "", MARK_TIPS);
  if (flat) {
    return createElement(
      Box,
      { flexDirection: "column", marginBottom: 1 },
      createElement(Text, null, "chantier — the coding harness"),
      createElement(
        Text,
        null,
        `version ${options.version}${options.model === undefined ? "" : `, model ${options.model}`}${
          options.sessionId === undefined ? "" : `, session ${options.sessionId.slice(-8)}`
        }`,
      ),
      createElement(Text, { dimColor: true }, `hints: ${hintLine(symbols)}`),
    );
  }
  return createElement(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    ...(art === null
      ? [createElement(Text, { key: "w", bold: true, color: "cyan" }, MARK_WORDMARK)]
      : [
          createElement(Text, { key: "a", color: "cyan" }, art.map((line) => `${line}\n`).join("")),
        ]),
    createElement(Text, { key: "v", dimColor: true }, `chantier ${options.version}`),
    ...(infoLine(options).length > 0
      ? [createElement(Text, { key: "m", dimColor: true }, infoLine(options))]
      : []),
    createElement(Text, { key: "h", dimColor: true }, hintLine(symbols)),
    ...(tip !== null && tip.length > 0 && options.tips !== false
      ? [createElement(Text, { key: "t", dimColor: true }, `tip: ${tip}`)]
      : []),
  );
}

/**
 * The append-once startup region: a single-item Static that prints the Mark
 * before the transcript begins and is never re-rendered afterwards.
 */
export function MarkStatic(options: MarkOptions): ReactElement {
  return createElement(Static, {
    items: [0],
    // biome-ignore lint/correctness/noChildrenProp: ink 7's Static API takes the render function as a children prop
    children: () => renderMark(options),
  });
}
