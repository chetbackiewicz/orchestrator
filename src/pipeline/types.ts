export type Trigger = "manual" | "automated";
export type AutonomyCeiling = "auto_fix" | "escalate_only";

export type IncidentState =
  | "received"
  | "assessing"
  | "investigating"
  | "acting"
  | "awaiting_verification"
  | "verified_fixed"
  | "escalated"
  | "needs_human"
  | "failed"
  | "budget_exceeded";

export interface Assessment {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  autonomy: AutonomyCeiling;
  rationale: string;
}

export interface Hypothesis {
  rootCause: string;
  offendingCommit?: string;
  suspectFiles: string[];
  proposedFix: string;
}

export interface FixClaim {
  status: "fixed" | "not_fixed" | "declined";
  branch?: string;
  testPath?: string;
  summary: string;
  recommendedMitigation?: string;
}

export interface VerificationResult {
  outcome: "verified" | "rejected";
  reproFailedBeforeFix: boolean;
  reproPassedAfterFix: boolean;
  fullSuitePassed: boolean;
  detail: string;
}

export interface IncidentInput {
  id: string;
  trigger: Trigger;
  report: string;
  cwd: string;
}

export interface IncidentEvent {
  at: string;
  kind: string;
  detail: string;
}

export interface IncidentRecord {
  input: IncidentInput;
  state: IncidentState;
  totalTokens: number;
  requestIds: string[];
  events: IncidentEvent[];
  assessment?: Assessment;
  hypothesis?: Hypothesis;
  claim?: FixClaim;
  verification?: VerificationResult;
}
