import { describe, expect, it } from "vitest";
import {
  dashboardConfig,
  parseArgs,
  publishingConfig,
  queueWorkerConfig,
  workspaceConfig,
} from "../src/config/cli-config.js";

describe("publishing CLI configuration", () => {
  it("is disabled by default and defaults the base branch to main", () => {
    expect(publishingConfig(parseArgs([]), {})).toEqual({
      enabled: false,
      baseBranch: "main",
      remote: "origin",
    });
  });

  it("supports explicit flags and repository overrides", () => {
    const config = publishingConfig(
      parseArgs([
        "--publish",
        "--publish-base",
        "release",
        "--github-repo",
        "octo/service",
        "--github-remote",
        "upstream",
      ]),
      {},
    );
    expect(config).toEqual({
      enabled: true,
      baseBranch: "release",
      repository: "octo/service",
      remote: "upstream",
    });
  });

  describe("dashboard CLI configuration", () => {
    it("is disabled by default and uses the default port", () => {
      expect(dashboardConfig(parseArgs([]), {})).toEqual({
        enabled: false,
        port: 4317,
      });
    });

    it("supports CLI and environment configuration", () => {
      expect(
        dashboardConfig(
          parseArgs(["--dashboard", "--dashboard-port", "4400"]),
          {},
        ),
      ).toEqual({ enabled: true, port: 4400 });
      expect(
        dashboardConfig(parseArgs([]), {
          INCIDENT_DASHBOARD: "true",
          INCIDENT_DASHBOARD_PORT: "4500",
        }),
      ).toEqual({ enabled: true, port: 4500 });
    });

    it("rejects invalid ports", () => {
      expect(() =>
        dashboardConfig(parseArgs(["--dashboard-port", "65536"]), {}),
      ).toThrow("integer from 0 to 65535");
    });
  });

  it("supports environment enablement without exposing credentials", () => {
    expect(
      publishingConfig(parseArgs([]), {
        INCIDENT_PUBLISH: "true",
        INCIDENT_GITHUB_REPOSITORY: "octo/service",
      }),
    ).toMatchObject({
      enabled: true,
      repository: "octo/service",
    });
  });

  describe("queue worker configuration", () => {
    it("uses explicit defaults and normalizes the base URL", () => {
      expect(
        queueWorkerConfig(
          parseArgs(["--queue-url", "http://127.0.0.1:3000/"]),
          {},
          "worker-default",
        ),
      ).toEqual({
        baseUrl: "http://127.0.0.1:3000",
        pollIntervalMs: 5_000,
        leaseSeconds: 120,
        heartbeatIntervalMs: 30_000,
        workerId: "worker-default",
      });
    });

    it("supports CLI and environment overrides", () => {
      expect(
        queueWorkerConfig(
          parseArgs([
            "--queue-url",
            "https://queue.example.test/incidents",
            "--poll-interval-ms",
            "250",
            "--lease-seconds",
            "60",
            "--heartbeat-interval-ms",
            "10000",
            "--worker-id",
            "worker-cli",
          ]),
          {},
        ),
      ).toEqual({
        baseUrl: "https://queue.example.test/incidents",
        pollIntervalMs: 250,
        leaseSeconds: 60,
        heartbeatIntervalMs: 10_000,
        workerId: "worker-cli",
      });

      expect(
        queueWorkerConfig(parseArgs([]), {
          INCIDENT_QUEUE_URL: "http://localhost:3000",
          INCIDENT_POLL_INTERVAL_MS: "1000",
          INCIDENT_LEASE_SECONDS: "90",
          INCIDENT_HEARTBEAT_INTERVAL_MS: "20000",
          INCIDENT_WORKER_ID: "worker-env",
        }),
      ).toMatchObject({
        pollIntervalMs: 1_000,
        leaseSeconds: 90,
        heartbeatIntervalMs: 20_000,
        workerId: "worker-env",
      });
    });

    it("rejects missing URLs and unsafe timing", () => {
      expect(() => queueWorkerConfig(parseArgs([]), {})).toThrow(
        "Missing queue URL",
      );
      expect(() =>
        queueWorkerConfig(
          parseArgs([
            "--queue-url",
            "file:///tmp/incidents",
          ]),
          {},
        ),
      ).toThrow("must use HTTP or HTTPS");
      expect(() =>
        queueWorkerConfig(
          parseArgs([
            "--queue-url",
            "http://localhost:3000",
            "--lease-seconds",
            "30",
            "--heartbeat-interval-ms",
            "30000",
          ]),
          {},
        ),
      ).toThrow("shorter than the incident lease");
    });
  });

  describe("workspace CLI configuration", () => {
    it("supports the existing fixed workspace mode", () => {
      expect(
        workspaceConfig(
          parseArgs([
            "--cwd",
            "../emerald-target",
            "--pre-fix-ref",
            "demo/incident-season",
          ]),
          {},
          "/orchestrator",
        ),
      ).toEqual({
        mode: "fixed",
        cwd: "/emerald-target",
        preFixRef: "demo/incident-season",
      });
    });

    it("configures managed worktrees with safe defaults", () => {
      expect(
        workspaceConfig(
          parseArgs(["--repo-root", "../emerald-osprey"]),
          {},
          "/orchestrator",
          "upstream/release",
        ),
      ).toEqual({
        mode: "managed",
        repoRoot: "/emerald-osprey",
        workspaceRoot: "/orchestrator/.incident-orchestrator/worktrees",
        targetRef: "upstream/release",
      });
    });

    it("supports managed workspace environment overrides", () => {
      expect(
        workspaceConfig(
          parseArgs([]),
          {
            INCIDENT_REPO_ROOT: "/repos/emerald-osprey",
            INCIDENT_WORKSPACE_ROOT: "/workspaces/incidents",
            INCIDENT_TARGET_REF: "origin/staging",
          },
          "/orchestrator",
        ),
      ).toEqual({
        mode: "managed",
        repoRoot: "/repos/emerald-osprey",
        workspaceRoot: "/workspaces/incidents",
        targetRef: "origin/staging",
      });
    });

    it("rejects ambiguous or incomplete workspace modes", () => {
      expect(() =>
        workspaceConfig(
          parseArgs([
            "--cwd",
            "/target",
            "--repo-root",
            "/repo",
            "--pre-fix-ref",
            "main",
          ]),
          {},
        ),
      ).toThrow("Use either --cwd or --repo-root");
      expect(() => workspaceConfig(parseArgs([]), {})).toThrow(
        "Missing target workspace",
      );
      expect(() =>
        workspaceConfig(parseArgs(["--cwd", "/target"]), {}),
      ).toThrow("Missing pre-fix ref");
      expect(() =>
        workspaceConfig(
          parseArgs([
            "--repo-root",
            "/repo",
            "--pre-fix-ref",
            "main",
          ]),
          {},
        ),
      ).toThrow("--pre-fix-ref is only valid with --cwd");
    });
  });
});
