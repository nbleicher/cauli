import { describe, expect, it } from "vitest";
import { secondFactorRequirement } from "./mfa-policy";

describe("secondFactorRequirement", () => {
  it("fails closed when assurance cannot be verified", () => {
    expect(
      secondFactorRequirement("admin", {
        data: null,
        error: new Error("Auth service unavailable"),
      })
    ).toBe("unavailable");
    expect(secondFactorRequirement("member", { data: null, error: null })).toBe(
      "unavailable"
    );
  });

  it("requires an enrolled second factor until the session reaches AAL2", () => {
    expect(
      secondFactorRequirement("manager", {
        data: { currentLevel: "aal1", nextLevel: "aal2" },
        error: null,
      })
    ).toBe("verification_required");
    expect(
      secondFactorRequirement("admin", {
        data: { currentLevel: "aal2", nextLevel: "aal2" },
        error: null,
      })
    ).toBe("satisfied");
  });

  it("allows AAL1 when the account has no verified second factor", () => {
    expect(
      secondFactorRequirement("member", {
        data: { currentLevel: "aal1", nextLevel: "aal1" },
        error: null,
      })
    ).toBe("satisfied");
  });

  it("requires enrollment for a privileged role without a factor", () => {
    for (const role of ["manager", "admin"] as const) {
      expect(
        secondFactorRequirement(role, {
          data: { currentLevel: "aal1", nextLevel: "aal1" },
          error: null,
        })
      ).toBe("enrollment_required");
    }
  });

  it("requires a replacement factor after a Recovery Code is redeemed", () => {
    expect(
      secondFactorRequirement(
        "member",
        { data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null },
        true
      )
    ).toBe("enrollment_required");
  });

  it("does not offer a challenge for the factor recovery deleted", () => {
    // The session was minted before redemption, so it still advertises aal2.
    expect(
      secondFactorRequirement(
        "admin",
        { data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null },
        true
      )
    ).toBe("enrollment_required");
  });

  it("stops requiring replacement once the new factor is verified", () => {
    expect(
      secondFactorRequirement(
        "member",
        { data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null },
        true
      )
    ).toBe("satisfied");
  });
});
