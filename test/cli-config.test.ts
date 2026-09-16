import { describe, expect, it } from "vitest";
import {
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
