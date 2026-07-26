export const WAV_EXPORT_FORMAT = {
  bitsPerSample: 16,
  channels: 1,
  codec: "pcm_s16le",
  sampleRate: 16_000,
} as const;

const WAV_HEADER_BYTES = 44;

export function estimatedWavBytes(durationSeconds: number) {
  return (
    WAV_HEADER_BYTES +
    Math.ceil(durationSeconds) *
      WAV_EXPORT_FORMAT.sampleRate *
      WAV_EXPORT_FORMAT.channels *
      (WAV_EXPORT_FORMAT.bitsPerSample / 8)
  );
}
