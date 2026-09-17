import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultVerifyDeps,
  verifyFix,
  VerifyDeps,
} from "../src/pipeline/verify.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

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

  it("does not treat an empty committed diff as a changed path", async () => {
    const root = await mkdtemp(join(tmpdir(), "incident-verify-test-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "season.ts"),
      "export const open = false;\n",
    );
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");

    await writeFile(
      join(root, "src", "season.ts"),
      "export const open = true;\n",
    );
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, "test", "season.test.ts"), "export {};\n");

    const result = await defaultVerifyDeps(root).validateChangedFiles!(
      "HEAD",
      "HEAD",
      "test/season.test.ts",
    );

    expect(result).toEqual({
      passed: true,
      detail:
        "only verified source changes and one new reproduction test changed",
      changedFiles: ["src/season.ts", "test/season.test.ts"],
    });
  });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
