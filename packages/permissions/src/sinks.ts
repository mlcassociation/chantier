import type { ApprovalDecision, ApprovalRequest, ApprovalSink } from "./engine.ts";

const HEADLESS_DENIAL_REASON =
  "mutation blocked in headless mode; rerun with --yolo or add an allow rule to .chantier/settings.json";

/** Headless default: every approval request is refused with an actionable reason. */
export function createDenyAllSink(): ApprovalSink {
  return {
    ask(req: ApprovalRequest): Promise<ApprovalDecision> {
      void req;
      return Promise.resolve({ approved: false, reason: HEADLESS_DENIAL_REASON });
    },
  };
}

/** `--yolo`: every approval request is granted. No permission rules are bypassed —
 * explicit deny rules are still enforced by the engine before the sink is reached. */
export function createAllowAllSink(): ApprovalSink {
  return {
    ask(_req: ApprovalRequest): Promise<ApprovalDecision> {
      return Promise.resolve({ approved: true });
    },
  };
}
