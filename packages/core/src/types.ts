import type { ApprovalDetail, PermissionEngine } from "@chantier/permissions";

// --- Messages -----------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool-call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: Array<TextBlock>;
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextBlock | ToolCallBlock>;
  usage?: Usage;
}

export interface ToolResultMessage {
  role: "tool-result";
  toolCallId: string;
  toolName: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// --- Model events (the provider seam payload) ---------------------------------

export type StopReason = "end_turn" | "max_turns" | "error";

export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "finish"; stopReason: StopReason; usage?: Usage };

// --- Tools --------------------------------------------------------------------

export interface ToolContext {
  cwd: string;
  session: SessionStore;
  permission: PermissionEngine;
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  readOnly: boolean;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  /** How to extract the permission specifier (e.g. path, command) from input. */
  specifier?: (input: Record<string, unknown>) => string | undefined;
  /**
   * Optional approval-UI metadata (e.g. a unified diff preview of the pending
   * mutation), passed to the sink via ApprovalRequest.detail. Shape: ApprovalDetail
   * from @chantier/permissions. Called with the same input the handler will
   * receive; a returned undefined simply omits the metadata. May be async
   * (e.g. reading the file to build a diff). Sinks that ignore detail are unaffected.
   */
  askDetail?: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => ApprovalDetail | undefined | Promise<ApprovalDetail | undefined>;
}

// --- Session (JSONL) ----------------------------------------------------------

export type SessionHeader = {
  type: "session";
  id: string;
  cwd: string;
  provider: string;
  model: string;
  createdAt: string;
};

export type SessionEntry = SessionHeader | { type: "message"; message: Message };

export interface SessionStore {
  id: string;
  dir: string;
  append(entry: SessionEntry): Promise<void>;
  load(id: string): Promise<SessionEntry[]>;
}
