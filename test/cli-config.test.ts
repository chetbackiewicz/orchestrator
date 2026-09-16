import { describe, expect, it } from "vitest";
import {
  dashboardConfig,
  parseArgs,
  publishingConfig,
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
});
