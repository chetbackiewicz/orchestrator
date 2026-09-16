import {
  Assessment,
  FixClaim,
  Hypothesis,
} from "./types.js";

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export function parseAssessment(text: string): Assessment {
  const value = parseObject(text);
  return {
    type: requiredString(value, "type"),
    severity: requiredEnum(value, "severity", [
      "low",
      "medium",
      "high",
      "critical",
    ]),
    autonomy: requiredEnum(value, "autonomy", [
      "auto_fix",
      "escalate_only",
    ]),
    rationale: requiredString(value, "rationale"),
  };
}

export function parseHypothesis(text: string): Hypothesis {
  const value = parseObject(text);
  const offendingCommit = optionalString(value, "offendingCommit");
  return {
    rootCause: requiredString(value, "rootCause"),
    ...(offendingCommit ? { offendingCommit } : {}),
    suspectFiles: requiredStringArray(value, "suspectFiles"),
    proposedFix: requiredString(value, "proposedFix"),
  };
}

export function parseFixClaim(text: string): FixClaim {
  const value = parseObject(text);
  const branch = optionalString(value, "branch");
  const testPath = optionalString(value, "testPath");
  const recommendedMitigation = optionalString(
    value,
    "recommendedMitigation",
  );
  return {
    status: requiredEnum(value, "status", [
      "fixed",
      "not_fixed",
      "declined",
    ]),
    ...(branch ? { branch } : {}),
    ...(testPath ? { testPath } : {}),
    summary: requiredString(value, "summary"),
    ...(recommendedMitigation ? { recommendedMitigation } : {}),
  };
}

function parseObject(text: string): Record<string, unknown> {
  const source = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SchemaError(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SchemaError("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new SchemaError("No JSON object found");
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new SchemaError(`Expected non-empty string at ${key}`);
  }
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.trim() === "") {
    throw new SchemaError(`Expected non-empty string at ${key}`);
  }
  return field;
}

function requiredEnum<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const field = value[key];
  if (typeof field !== "string" || !allowed.includes(field)) {
    throw new SchemaError(
      `Expected ${key} to be one of: ${allowed.join(", ")}`,
    );
  }
  return field as T[number];
}

function requiredStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const field = value[key];
  if (
    !Array.isArray(field) ||
    field.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new SchemaError(`Expected ${key} to be an array of strings`);
  }
  return field;
}
