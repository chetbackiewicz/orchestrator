import { describe, expect, it } from "vitest";
import {
  parseAssessment,
  parseFixClaim,
  parseHypothesis,
  SchemaError,
} from "../src/pipeline/schemas.js";

describe("pipeline schemas", () => {
  it("parses fenced structured output", () => {
    expect(
      parseAssessment(
        '```json\n{"type":"logic","severity":"high","autonomy":"auto_fix","rationale":"bounded"}\n```',
      ),
    ).toEqual({
      type: "logic",
      severity: "high",
      autonomy: "auto_fix",
      rationale: "bounded",
    });
  });

  it("rejects invalid enum values", () => {
    expect(() =>
      parseAssessment(
        '{"type":"logic","severity":"urgent","autonomy":"auto_fix","rationale":"bounded"}',
      ),
    ).toThrow(SchemaError);
  });

  it("parses optional hypothesis and claim fields", () => {
    expect(
      parseHypothesis(
        '{"rootCause":"leak","suspectFiles":["src/a.ts"],"proposedFix":"finally"}',
      ),
    ).toEqual({
      rootCause: "leak",
      suspectFiles: ["src/a.ts"],
      proposedFix: "finally",
    });
    expect(
      parseFixClaim('{"status":"declined","summary":"needs review"}'),
    ).toEqual({ status: "declined", summary: "needs review" });
  });
});
