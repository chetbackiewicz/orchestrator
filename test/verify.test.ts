import { describe, expect, it, vi } from "vitest";
import { verifyFix, VerifyDeps } from "../src/pipeline/verify.js";

describe("verifyFix", () => {
  it("accepts only a failing-before, passing-after, green-suite fix", async () => {
    const runTestsAtRef = vi
      .fn<VerifyDeps["runTestsAtRef"]>()
      .mockResolvedValueOnce({ passed: false, detail: "reproduced" })
      .mockResolvedValueOnce({ passed: true, detail: "fixed" })
      .mockResolvedValueOnce({ passed: true, detail: "green" });

    const result = await verifyFix(
      {
        status: "fixed",
        branch: "fix/incident",
        testPath: "test/incident.test.ts",
        summary: "fixed",
      },
      "before",
      {
        runTestsAtRef,
        async validateChangedFiles() {
          return {
            passed: true,
            detail: "controlled",
            changedFiles: ["src/incident.ts", "test/incident.test.ts"],
          };
        },
      },
    );

    expect(result.outcome).toBe("verified");
    expect(result.verifiedPaths).toEqual([
      "src/incident.ts",
      "test/incident.test.ts",
    ]);
    expect(runTestsAtRef.mock.calls).toEqual([
      ["before", "test/incident.test.ts"],
      [
        "fix/incident",
        "test/incident.test.ts",
        { includeWorkingTree: true },
      ],
      [
        "fix/incident",
        undefined,
        { includeWorkingTree: true },
      ],
    ]);
  });

  it("rejects a test that already passes before the fix", async () => {
    const deps: VerifyDeps = {
      async runTestsAtRef() {
        return { passed: true, detail: "passed" };
      },
    };
    const result = await verifyFix(
      {
        status: "fixed",
        testPath: "test/incident.test.ts",
        summary: "fixed",
      },
      "before",
      deps,
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reproFailedBeforeFix).toBe(false);
  });

  it("rejects claims without a reproduction test", async () => {
    const result = await verifyFix(
      { status: "fixed", summary: "fixed" },
      "before",
      {
        async runTestsAtRef() {
          throw new Error("should not run");
        },
      },
    );
    expect(result.outcome).toBe("rejected");
  });
});
