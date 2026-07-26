import { describe, expect, it } from "vitest";
import { estimatedWavBytes, WAV_EXPORT_FORMAT } from "./wav.js";

describe("WAV export format", () => {
  it("keeps a three-hour Recording below the configured 512 MB object limit", () => {
    expect(WAV_EXPORT_FORMAT).toEqual({
      bitsPerSample: 16,
      channels: 1,
      codec: "pcm_s16le",
      sampleRate: 16_000,
    });
    expect(estimatedWavBytes(3 * 60 * 60)).toBe(345_600_044);
    expect(estimatedWavBytes(3 * 60 * 60)).toBeLessThanOrEqual(536_870_912);
  });
});
