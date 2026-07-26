import { describe, expect, it } from "vitest";
import { secondFactorRequirement } from "./mfa-policy";

describe("secondFactorRequirement", () => {
  it("fails closed when assurance cannot be verified", () => {
    expect(
      secondFactorRequirement({
        data: null,
        error: new Error("Auth service unavailable"),
      })
    ).toBe("unavailable");
    expect(secondFactorRequirement({ data: null, error: null })).toBe(
      "unavailable"
    );
  });

  it("requires an enrolled second factor until the session reaches AAL2", () => {
    expect(
      secondFactorRequirement({
        data: { currentLevel: "aal1", nextLevel: "aal2" },
        error: null,
      })
    ).toBe("required");
    expect(
      secondFactorRequirement({
        data: { currentLevel: "aal2", nextLevel: "aal2" },
        error: null,
      })
    ).toBe("satisfied");
  });

  it("allows AAL1 when the account has no verified second factor", () => {
    expect(
      secondFactorRequirement({
        data: { currentLevel: "aal1", nextLevel: "aal1" },
        error: null,
      })
    ).toBe("satisfied");
  });
});
