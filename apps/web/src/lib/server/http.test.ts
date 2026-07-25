import { describe, expect, it } from "vitest";
import { sanitizeError } from "./http.js";

describe("sanitizeError", () => {
  it("preserves safe messages from Supabase error objects", () => {
    expect(
      sanitizeError({
        message: "A retry-safe database constraint failed",
      })
    ).toBe("A retry-safe database constraint failed");
  });

  it("redacts authorization values", () => {
    expect(sanitizeError(new Error("Request used Bearer secret-token"))).toBe(
      "Request used Bearer [redacted]"
    );
  });
});
