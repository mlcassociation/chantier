export {
  approvalLabel,
  startTui,
  TuiApp,
  type TuiInstance,
  type TuiOptions,
} from "./app.ts";
export {
  classifyUnifiedDiffLine,
  type DiffLineKind,
  type DiffPreview,
  summarizeUnifiedDiff,
} from "./diff.ts";
export {
  applyEditorAction,
  createHistoryStore,
  type EditorAction,
  type EditorState,
  editorBackspace,
  editorInsert,
  emptyEditor,
  expandPasteChips,
  type HistoryStore,
  historyPath,
  loadHistory,
  type PasteResult,
  pasteChip,
  QUIT_HINT,
  TaskInput,
  type TaskInputProps,
} from "./input.ts";
export type {
  RunningState,
  TuiItem,
  TuiStoreV5,
  UsageTotals,
} from "./items.ts";
// v0.5 additions (Worker B) — appended at the file tail so parallel edits
// elsewhere in this file merge cleanly (integration contract, spec §11).
export {
  ACTION_CHORDS,
  type ActionId,
  APPROVAL_HINT_PARTS,
  type Keychord,
  keypressToDecision,
  matches,
} from "./keys.ts";
export { resolveScreenReader } from "./screen-reader.ts";
export {
  type AbortKind,
  createTuiStore,
  type TuiPromptDetail,
  type TuiState,
  type TuiStore,
} from "./store.ts";
export { isAsciiEnv, resolveSymbols, type TuiSymbols } from "./symbols.ts";
export {
  ApprovalCardV2,
  type ApprovalCardV2Props,
  approvalCardSpec,
  approvalSrLabel,
  ctxBar,
  Divider,
  type DividerProps,
  dividerLine,
  FooterBar,
  type FooterBarProps,
  footerSegments,
  formatDuration,
  formatElapsed,
  formatTokenCount,
  formatTokens,
  humanizeApproval,
  previewLine,
  QueuePreview,
  type QueuePreviewProps,
  queuePreviewLines,
  STATUS_VERB_WIDTH,
  StatusWidget,
  type StatusWidgetProps,
  SUBAGENT_SUMMARY_MAX_LINES,
  SubagentCard,
  type SubagentCardProps,
  statusLines,
  subagentLines,
  type ToolItem,
  ToolRow,
  type ToolRowProps,
  toolRowLines,
  toolRowSrText,
  withErrorBackstop,
} from "./widgets.ts";
