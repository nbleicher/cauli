import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const { emitCallEnded, rpcMock } = vi.hoisted(() => ({
  emitCallEnded: vi.fn(),
  rpcMock: vi.fn(),
}));

const workspaceId = "00000000-0000-0000-0000-000000000001";
const callId = "11111111-1111-1111-1111-111111111111";
const ownerId = "22222222-2222-2222-2222-222222222222";
const jobId = "33333333-3333-3333-3333-333333333333";
const stoppedAt = "2026-08-03T18:05:00.000Z";

const callRow = {
  id: callId,
  workspace_id: workspaceId,
  owner_id: ownerId,
  duration_ms: 125_000,
  expected_final_chunk: null,
  chunk_prefix: `${workspaceId}/${callId}/chunks`,
  source_path: `${workspaceId}/${callId}/artifacts/source.webm`,
  mp3_path: null,
  mime_type: "audio/webm",
  stopped_at: stoppedAt,
};

vi.mock("@calllog/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calllog/shared")>();
  return {
    ...actual,
    emitCallEnded: (...args: unknown[]) => emitCallEnded(...args),
    metricsConfigFromEnv: () => ({
      apiUrl: "https://metrics.example",
      secret: "secret",
    }),
  };
});

vi.mock("./config.js", () => ({
  config: {
    workerName: "jobs-test-worker",
    concurrency: 1,
    transcriptionModel: "openai/whisper-large-v3-turbo",
    transcriptionFallbackModel: "openai/whisper-large-v3",
  },
}));

vi.mock("./supabase.js", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (table: string) => {
      if (table === "calls") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { ...callRow }, error: null }),
            }),
          }),
          update: () => ({ eq: async () => ({ data: null, error: null }) }),
        };
      }
      if (table === "processing_jobs") {
        const query = {
          update: () => query,
          eq: () => query,
          select: () => query,
          maybeSingle: async () => ({ data: { id: jobId }, error: null }),
        };
        return query;
      }
      throw new Error(`Unexpected table in jobs test: ${table}`);
    },
  },
}));

vi.mock("./storage.js", () => ({
  // The recording bytes themselves are irrelevant to this contract; the mock
  // only has to leave a file where the pipeline expects the download.
  downloadStorageFile: vi.fn(async (_path: string, destination: string) => {
    await writeFile(destination, "downloaded-audio");
  }),
  downloadChunkSequence: vi.fn(),
  listStorageFiles: vi.fn(async () => []),
  removeStorageFiles: vi.fn(async () => undefined),
  uploadStorageFile: vi.fn(async () => undefined),
}));

vi.mock("./process.js", () => ({
  concatenateFiles: vi.fn(),
  fileSize: vi.fn(async () => 1_024),
  removeDirectory: vi.fn(async (directory: string) => {
    await rm(directory, { recursive: true, force: true });
  }),
  runFfmpeg: vi.fn(async (args: string[]) => {
    await writeFile(args[args.length - 1]!, "encoded-audio");
  }),
  splitAudioForTranscription: vi.fn(),
}));

vi.mock("./transcribe.js", () => ({
  OpenRouterTranscriptionError: class OpenRouterTranscriptionError extends Error {},
  transcribeAudioSegments: vi.fn(),
}));

vi.mock("./checkpoint-store.js", () => ({
  createSupabaseCheckpointStore: vi.fn(() => ({})),
}));

vi.mock("./telemetry.js", () => ({
  captureWorkerError: vi.fn(),
}));

afterEach(() => {
  emitCallEnded.mockReset();
  rpcMock.mockReset();
});

function processRecordingJob() {
  return {
    id: jobId,
    workspace_id: workspaceId,
    call_id: callId,
    kind: "process_recording" as const,
    attempts: 1,
    max_attempts: 3,
    payload: { skipTranscription: true },
    lease_token: "lease-token-1",
  };
}

describe("process_recording metrics backstop", () => {
  it("re-emits call.ended after commit_processed_recording succeeds", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "renew_processing_job_lease")
        return { data: true, error: null };
      if (fn === "commit_processed_recording")
        return { data: true, error: null };
      throw new Error(`Unexpected rpc in jobs test: ${fn}`);
    });
    const { runJob } = await import("./jobs.js");

    await runJob(processRecordingJob());

    const commitCallIndex = rpcMock.mock.calls.findIndex(
      (call) => call[0] === "commit_processed_recording"
    );
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);
    expect(emitCallEnded).toHaveBeenCalledTimes(1);
    expect(emitCallEnded).toHaveBeenCalledWith(
      {
        callId,
        profileId: ownerId,
        durationMs: 125_000,
        recordingRef: `${workspaceId}/${callId}/artifacts/recording.mp3`,
        occurredAt: stoppedAt,
      },
      expect.objectContaining({
        apiUrl: "https://metrics.example",
        secret: "secret",
      })
    );
    // The backstop is a delivery duplicate of finalize's emission, not new
    // telemetry: it fires only after the Recording durably committed.
    expect(emitCallEnded.mock.invocationCallOrder[0]!).toBeGreaterThan(
      rpcMock.mock.invocationCallOrder[commitCallIndex]!
    );

    // Same dedup key as finalize's call.ended, so the backend acknowledges
    // this as a duplicate whenever the finalize emission already arrived.
    const { buildCallEndedEvent, callEndedDedupKey } =
      await import("@calllog/shared");
    const input = emitCallEnded.mock.calls[0]![0] as Parameters<
      typeof buildCallEndedEvent
    >[0];
    expect(buildCallEndedEvent(input, () => "evt").dedup_key).toBe(
      callEndedDedupKey(callId)
    );
  });

  it("does not emit call.ended when the recording commit is rejected", async () => {
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "renew_processing_job_lease")
        return { data: true, error: null };
      if (fn === "commit_processed_recording")
        return { data: false, error: null };
      throw new Error(`Unexpected rpc in jobs test: ${fn}`);
    });
    const { runJob } = await import("./jobs.js");

    await runJob(processRecordingJob());

    expect(
      rpcMock.mock.calls.some(
        (call) => call[0] === "commit_processed_recording"
      )
    ).toBe(true);
    expect(emitCallEnded).not.toHaveBeenCalled();
  });
});
