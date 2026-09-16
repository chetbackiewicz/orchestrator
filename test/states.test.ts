import { describe, expect, it } from "vitest";
import {
  assertTransition,
  isTerminalState,
} from "../src/pipeline/states.js";

describe("incident state machine", () => {
  it("allows declared transitions", () => {
    expect(() => assertTransition("received", "assessing")).not.toThrow();
    expect(() =>
      assertTransition("awaiting_verification", "verified_fixed"),
    ).not.toThrow();
  });

  it("rejects skipped and terminal transitions", () => {
    expect(() => assertTransition("received", "acting")).toThrow(
      "Illegal incident transition",
    );
    expect(isTerminalState("verified_fixed")).toBe(true);
    expect(isTerminalState("acting")).toBe(false);
  });
});
