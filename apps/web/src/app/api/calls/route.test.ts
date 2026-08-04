import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireApiAuth = vi.fn();
const isAuthError = vi.fn(
  (value: unknown) =>
    value !== null &&
    typeof value === "object" &&
    "status" in (value as object)
);
const parseJson = vi.fn();
const sanitizeError = vi.fn((error: unknown) =>
  error instanceof Error ? error.message : "error"
);
const createServerSupabaseClient = vi.fn();
const emitCallStartedMetric = vi.fn();
const after = vi.fn((fn: () => void) => fn());

vi.mock("@/lib/server/auth", () => ({
  requireApiAuth: () => requireApiAuth(),
  isAuthError: (value: unknown) => isAuthError(value),
}));

vi.mock("@/lib/server/http", () => ({
  parseJson: (request: Request, schema: unknown) => parseJson(request, schema),
  sanitizeError: (error: unknown) => sanitizeError(error),
  rateLimitResponse: async () => null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: () => createServerSupabaseClient(),
}));

vi.mock("@/lib/server/metrics", () => ({
  emitCallStartedMetric: (input: unknown) => emitCallStartedMetric(input),
  emitCallEndedMetric: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => void) => after(fn),
  };
});

describe("POST /api/calls", () => {
  beforeEach(() => {
    requireApiAuth.mockResolvedValue({
      user: { id: "profile-1", email: "a@example.com" },
      member: {
        workspaceId: "workspace-1",
        userId: "profile-1",
        role: "member",
      },
    });
    parseJson.mockResolvedValue({
      data: {
        sourceMode: "both",
        recordingAttested: true,
      },
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits call.started after a successful create RPC and does not invent contact identity", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        id: "call-1",
        workspace_id: "workspace-1",
        owner_id: "profile-1",
        status: "recording",
        started_at: "2026-08-03T18:00:00.000Z",
        chunk_prefix: "workspace-1/call-1/chunks",
      },
      error: null,
    });
    createServerSupabaseClient.mockResolvedValue({ rpc });

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://cauli.test/api/calls", { method: "POST" })
    );

    expect(response.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith(
      "create_attested_call_for_current_user",
      expect.objectContaining({
        target_source_mode: "both",
        target_recording_attested: true,
      })
    );
    expect(after).toHaveBeenCalled();
    expect(emitCallStartedMetric).toHaveBeenCalledWith({
      callId: "call-1",
      profileId: "profile-1",
      occurredAt: "2026-08-03T18:00:00.000Z",
    });
    expect(emitCallStartedMetric.mock.calls[0]?.[0]).not.toHaveProperty(
      "contact"
    );
  });

  it("does not emit metrics when create RPC fails", async () => {
    createServerSupabaseClient.mockResolvedValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "db down" },
      }),
    });

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://cauli.test/api/calls", { method: "POST" })
    );

    expect(response.status).toBe(500);
    expect(emitCallStartedMetric).not.toHaveBeenCalled();
  });
});
