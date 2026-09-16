import { AgentRunner, AgentSession, RunEvent, RunResult } from "../agent/runner.js";
import { makeIncidentTools } from "../tools/incident-tools.js";
import {
  actPrompt,
  assessPrompt,
  gatherEvidencePrompt,
  investigatePrompt,
  repairPrompt,
} from "./prompts.js";
import {
  parseAssessment,
  parseFixClaim,
  parseHypothesis,
  SchemaError,
} from "./schemas.js";
import { assertTransition, isTerminalState } from "./states.js";
import {
  IncidentInput,
  IncidentRecord,
  IncidentState,
} from "./types.js";
import { defaultVerifyDeps, VerifyDeps, verifyFix } from "./verify.js";

export interface OrchestratorConfig {
  maxTokensPerIncident: number;
  preFixRef: string;
  verifyDeps?: (cwd: string) => VerifyDeps;
  onEvent?: (incidentId: string, event: RunEvent) => void;
  onStateChange?: (record: IncidentRecord) => void;
  now?: () => string;
}

export async function triageIncident(
  input: IncidentInput,
  runner: AgentRunner,
  config: OrchestratorConfig,
): Promise<IncidentRecord> {
  const record: IncidentRecord = {
    input,
    state: "received",
    totalTokens: 0,
    requestIds: [],
    events: [],
  };
  const now = config.now ?? (() => new Date().toISOString());
  const move = (to: IncidentState, detail = "") => {
    assertTransition(record.state, to);
    record.state = to;
    record.events.push({ at: now(), kind: to, detail });
    config.onStateChange?.(record);
  };

  config.onStateChange?.(record);
  let session: AgentSession | undefined;
  try {
    const activeSession = await runner.open({
      cwd: input.cwd,
      tools: makeIncidentTools(input.cwd),
      label: `incident:${input.id}`,
    });
    session = activeSession;

    const send = async (
      prompt: string,
      mode: "plan" | "agent",
    ): Promise<RunResult> => {
      const result = await activeSession.run({ prompt, mode }, (event) => {
        record.events.push({
          at: now(),
          kind: `event:${event.type}`,
          detail: JSON.stringify(event),
        });
        config.onEvent?.(input.id, event);
      });
      if (result.usage) record.totalTokens += result.usage.totalTokens;
      if (result.requestId) record.requestIds.push(result.requestId);
      if (result.status !== "finished") {
        throw new Error(
          `Agent run ${result.status}: ${result.error ?? "unknown error"}`,
        );
      }
      return result;
    };

    const parseStage = async <T>(
      prompt: string,
      mode: "plan" | "agent",
      parse: (text: string) => T,
    ): Promise<{ value: T; result: RunResult }> => {
      const result = await send(prompt, mode);
      try {
        return { value: parse(result.text), result };
      } catch (error) {
        if (!(error instanceof SchemaError)) throw error;
        const repaired = await send(
          repairPrompt(prompt, result.text, error.message),
          "plan",
        );
        try {
          return { value: parse(repaired.text), result };
        } catch (repairError) {
          if (repairError instanceof SchemaError) {
            throw new SchemaError(
              `Schema validation failed after one repair attempt: ${repairError.message}`,
            );
          }
          throw repairError;
        }
      }
    };

    const stopForBudget = (): boolean => {
      if (record.totalTokens <= config.maxTokensPerIncident) return false;
      move(
        "budget_exceeded",
        `Token ceiling exceeded at ${record.totalTokens} tokens`,
      );
      return true;
    };

    move("assessing");
    const assessment = await parseStage(
      assessPrompt(input),
      "plan",
      parseAssessment,
    );
    record.assessment = assessment.value;
    if (stopForBudget()) return record;

    if (record.assessment.autonomy === "escalate_only") {
      const evidence = await parseStage(
        gatherEvidencePrompt(input),
        "plan",
        parseFixClaim,
      );
      record.claim = evidence.value;
      if (stopForBudget()) return record;
      move("escalated", record.claim.summary);
      return record;
    }

    move("investigating");
    const hypothesis = await parseStage(
      investigatePrompt(input),
      "plan",
      parseHypothesis,
    );
    record.hypothesis = hypothesis.value;
    if (stopForBudget()) return record;

    move("acting");
    const claim = await parseStage(
      actPrompt(input, record.hypothesis),
      "agent",
      parseFixClaim,
    );
    record.claim = claim.value;
    if (!record.claim.branch && claim.result.branch) {
      record.claim.branch = claim.result.branch;
    }
    if (stopForBudget()) return record;

    if (record.claim.status !== "fixed") {
      move("escalated", `Agent did not fix incident: ${record.claim.summary}`);
      return record;
    }

    move("awaiting_verification");
    const deps = (config.verifyDeps ?? defaultVerifyDeps)(input.cwd);
    record.verification = await verifyFix(
      record.claim,
      config.preFixRef,
      deps,
    );
    if (record.verification.outcome === "verified") {
      move("verified_fixed", record.verification.detail);
    } else {
      move("needs_human", record.verification.detail);
    }
    return record;
  } catch (error) {
    if (!isTerminalState(record.state)) {
      move("failed", formatError(error));
    }
    return record;
  } finally {
    await session?.dispose();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
