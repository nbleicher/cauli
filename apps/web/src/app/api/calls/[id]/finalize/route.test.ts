import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireApiAuth = vi.fn();
const isAuthError = vi.fn(
  (value: unknown) =>
    value !== null &&
    typeof value === "object" &&
    "status" in (value as object)
);
const authorizeCall = vi.fn();
const parseJson = vi.fn();
const sanitizeError = vi.fn((error: unknown) =>
  error instanceof Error ? error.message : "error"
);
const createServerSupabaseClient = vi.fn();
const emitCallEndedMetric = vi.fn();
const after = vi.fn((fn: () => void) => fn());

vi.mock("@/lib/server/auth", () => ({
  requireApiAuth: () => requireApiAuth(),
  isAuthError: (value: unknown) => isAuthError(value),
}));

vi.mock("@/lib/server/calls", () => ({
  authorizeCall: (
    auth: unknown,
    callId: string,
    action: "view" | "delete" | "review" | "own"
  ) => authorizeCall(auth, callId, action),
}));

vi.mock("@/lib/server/http", () => ({
  parseJson: (request: Request, schema: unknown) => parseJson(request, schema),
  sanitizeError: (error: unknown) => sanitizeError(error),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: () => createServerSupabaseClient(),
}));

vi.mock("@/lib/server/metrics", () => ({
  emitCallStartedMetric: vi.fn(),
  emitCallEndedMetric: (input: unknown) => emitCallEndedMetric(input),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => void) => after(fn),
  };
});

describe("POST /api/calls/:id/finalize", () => {
  beforeEach(() => {
    requireApiAuth.mockResolvedValue({
      user: { id: "profile-1", email: "a@example.com" },
      member: {
        workspaceId: "workspace-1",
        userId: "profile-1",
        role: "member",
      },
    });
    authorizeCall.mockResolvedValue({
      access: {
        id: "call-1",
        workspaceId: "workspace-1",
        ownerId: "profile-1",
      },
      row: {},
    });
    parseJson.mockResolvedValue({
      data: {
        finalChunkSequence: 2,
        durationMs: 12_500,
        mimeType: "audio/webm",
        sourceMode: "both",
        degradedIntervals: [],
      },
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits call.ended with duration_ms after a successful finalize RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        id: "call-1",
        owner_id: "profile-1",
        duration_ms: 12_500,
        stopped_at: "2026-08-03T18:05:00.000Z",
      },
      error: null,
    });
    createServerSupabaseClient.mockResolvedValue({ rpc });

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://cauli.test/api/calls/call-1/finalize", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "call-1" }) }
    );

    expect(response.status).toBe(200);
    expect(emitCallEndedMetric).toHaveBeenCalledWith({
      callId: "call-1",
      profileId: "profile-1",
      durationMs: 12_500,
      recordingRef: "call-1",
      occurredAt: "2026-08-03T18:05:00.000Z",
    });
    expect(emitCallEndedMetric.mock.calls[0]?.[0]).not.toHaveProperty(
      "contact"
    );
  });

  it("does not emit metrics when finalize RPC fails", async () => {
    createServerSupabaseClient.mockResolvedValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "finalize failed" },
      }),
    });

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://cauli.test/api/calls/call-1/finalize", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "call-1" }) }
    );

    expect(response.status).toBe(500);
    expect(emitCallEndedMetric).not.toHaveBeenCalled();
  });
});
