import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { AgentTool, JsonValue } from "../agent/runner.js";

const MAX_OUTPUT = 100_000;

export function makeIncidentTools(cwd: string): Record<string, AgentTool> {
  const root = resolve(cwd);
  return {
    read_incident: {
      description:
        "Read an incident alert bundle from a repository-relative path. For manual incidents, use the report text from the prompt.",
      inputSchema: objectSchema({
        path: { type: "string" },
      }),
      readOnly: true,
      async execute(args) {
        const path = optionalString(args, "path");
        if (!path) {
          return "No bundle path supplied. Use the incident report in the prompt.";
        }
        return readTextFile(root, path);
      },
    },
    recent_commits: {
      description:
        "Show recent commits, optionally limited to a repository-relative path.",
      inputSchema: objectSchema({
        path: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 100 },
      }),
      readOnly: true,
      async execute(args) {
        const count = optionalInteger(args, "count") ?? 15;
        const path = optionalString(args, "path");
        const commandArgs = [
          "--no-pager",
          "log",
          `-${Math.min(count, 100)}`,
          "--date=iso-strict",
          "--format=%h %ad %s",
        ];
        if (path) {
          safePath(root, path);
          commandArgs.push("--", path);
        }
        return runCommand("git", commandArgs, root, 20_000);
      },
    },
    show_commit: {
      description: "Show the patch and stat for a commit or ref.",
      inputSchema: objectSchema(
        { hash: { type: "string", minLength: 1 } },
        ["hash"],
      ),
      readOnly: true,
      async execute(args) {
        const hash = requiredString(args, "hash");
        if (hash.startsWith("-") || /[\u0000-\u001f\u007f\s]/.test(hash)) {
          throw new Error("Invalid commit or ref");
        }
        const resolved = await runCommand(
          "git",
          ["rev-parse", "--verify", `${hash}^{commit}`],
          root,
          10_000,
        );
        if (!resolved.startsWith("exit=0\n")) {
          throw new Error(`Unknown commit or ref: ${hash}\n${resolved}`);
        }
        const commit = resolved.slice("exit=0\n".length).trim();
        return runCommand(
          "git",
          ["--no-pager", "show", "--stat", "--patch", commit],
          root,
          20_000,
        );
      },
    },
    read_file: {
      description:
        "Read a UTF-8 repository file, optionally selecting inclusive line numbers.",
      inputSchema: objectSchema(
        {
          path: { type: "string", minLength: 1 },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        ["path"],
      ),
      readOnly: true,
      async execute(args) {
        const path = requiredString(args, "path");
        const startLine = optionalInteger(args, "startLine");
        const endLine = optionalInteger(args, "endLine");
        const text = await readTextFile(root, path);
        if (startLine === undefined && endLine === undefined) return text;
        const start = startLine ?? 1;
        const end = endLine ?? Number.MAX_SAFE_INTEGER;
        if (end < start) throw new Error("endLine must be >= startLine");
        return text
          .split("\n")
          .slice(start - 1, end)
          .map((line, index) => `${start + index}: ${line}`)
          .join("\n");
      },
    },
    run_tests: {
      description:
        "Run the target repository's Vitest suite or one repository-relative test path. Returns output even when tests fail.",
      inputSchema: objectSchema({
        path: { type: "string" },
      }),
      readOnly: true,
      async execute(args) {
        const path = optionalString(args, "path");
        if (path) safePath(root, path);
        return runCommand(
          process.platform === "win32" ? "npx.cmd" : "npx",
          ["--no-install", "vitest", "run", ...(path ? [path] : [])],
          root,
          60_000,
        );
      },
    },
    db_pool_status: {
      description:
        "Fetch the target application's read-only connection-pool status endpoint.",
      inputSchema: objectSchema({
        url: { type: "string", format: "uri" },
      }),
      readOnly: true,
      async execute(args) {
        const url =
          optionalString(args, "url") ?? "http://127.0.0.1:3000/_pool";
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("db_pool_status only supports HTTP(S) URLs");
        }
        if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
          throw new Error("db_pool_status only permits loopback hosts");
        }
        const response = await fetch(parsed, {
          signal: AbortSignal.timeout(10_000),
        });
        const body = await response.text();
        if (!response.ok) {
          throw new Error(`Pool endpoint returned ${response.status}: ${body}`);
        }
        return body.slice(0, MAX_OUTPUT);
      },
    },
  };
}

async function readTextFile(root: string, path: string): Promise<string> {
  return (await readFile(safePath(root, path), "utf8")).slice(0, MAX_OUTPUT);
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Expected a relative path: ${path}`);
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes repository: ${path}`);
  }
  return resolved;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      resolveOutput(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectOnce(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const detail = output.slice(0, MAX_OUTPUT).trim();
      if (timedOut) {
        resolveOnce(`Timed out after ${timeoutMs}ms\n${detail}`);
      } else {
        resolveOnce(`exit=${code ?? "unknown"}\n${detail}`);
      }
    });
  });
}

function objectSchema(
  properties: Record<string, JsonValue>,
  required: string[] = [],
): Record<string, JsonValue> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function requiredString(args: Record<string, JsonValue>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected non-empty string argument: ${key}`);
  }
  return value;
}

function optionalString(
  args: Record<string, JsonValue>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected non-empty string argument: ${key}`);
  }
  return value;
}

function optionalInteger(
  args: Record<string, JsonValue>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Expected integer argument: ${key}`);
  }
  return value;
}
