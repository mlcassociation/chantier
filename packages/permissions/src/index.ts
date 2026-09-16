export {
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalSink,
  createPermissionEngine,
  type Decision,
  type PermissionEngine,
  type PermissionRules,
} from "./engine.ts";
export { createAllowAllSink, createDenyAllSink } from "./sinks.ts";
