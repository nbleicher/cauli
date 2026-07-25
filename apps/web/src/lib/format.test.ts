import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./format";

describe("formatDuration", () => {
  it("formats short and long calls", () => {
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(3_665_000)).toBe("01:01:05");
  });
});

describe("formatBytes", () => {
  it("uses readable binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
  });
});
