export {
  approvalLabel,
  keypressToDecision,
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
export { resolveScreenReader } from "./screen-reader.ts";
export {
  type AbortKind,
  createTuiStore,
  type TuiPromptDetail,
  type TuiState,
  type TuiStore,
} from "./store.ts";
export { isAsciiEnv, resolveSymbols, type TuiSymbols } from "./symbols.ts";
// v0.5 additions (Worker B) — appended at the file tail so parallel edits
// elsewhere in this file merge cleanly (integration contract, spec §11).
export {
  type ActionId,
  ACTION_CHORDS,
  APPROVAL_HINT_PARTS,
  type Keychord,
  keypressToDecision,
  matches,
} from "./keys.ts";
export type {
  RunningState,
  TuiItem,
  TuiStoreV5,
  UsageTotals,
} from "./items.ts";
export {
  approvalCardSpec,
  approvalSrLabel,
  ApprovalCardV2,
  type ApprovalCardV2Props,
  ctxBar,
  Divider,
  dividerLine,
  type DividerProps,
  footerSegments,
  FooterBar,
  type FooterBarProps,
  formatDuration,
  formatElapsed,
  formatTokenCount,
  formatTokens,
  humanizeApproval,
  previewLine,
  QueuePreview,
  queuePreviewLines,
  type QueuePreviewProps,
  STATUS_VERB_WIDTH,
  statusLines,
  StatusWidget,
  type StatusWidgetProps,
  SUBAGENT_SUMMARY_MAX_LINES,
  subagentLines,
  SubagentCard,
  type SubagentCardProps,
  ToolRow,
  toolRowLines,
  toolRowSrText,
  type ToolItem,
  type ToolRowProps,
  withErrorBackstop,
} from "./widgets.ts";
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
  pasteChip,
  type PasteResult,
  QUIT_HINT,
  TaskInput,
  type TaskInputProps,
} from "./input.ts";
