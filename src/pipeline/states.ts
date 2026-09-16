import { IncidentState } from "./types.js";

const transitions: Record<IncidentState, readonly IncidentState[]> = {
  received: ["assessing", "failed"],
  assessing: [
    "investigating",
    "escalated",
    "failed",
    "budget_exceeded",
  ],
  investigating: ["acting", "escalated", "failed", "budget_exceeded"],
  acting: [
    "awaiting_verification",
    "escalated",
    "failed",
    "budget_exceeded",
  ],
  awaiting_verification: ["verified_fixed", "needs_human", "failed"],
  verified_fixed: [],
  escalated: [],
  needs_human: [],
  failed: [],
  budget_exceeded: [],
};

export function assertTransition(
  from: IncidentState,
  to: IncidentState,
): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`Illegal incident transition: ${from} -> ${to}`);
  }
}

export function isTerminalState(state: IncidentState): boolean {
  return transitions[state].length === 0;
}
