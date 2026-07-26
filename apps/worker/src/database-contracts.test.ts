import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";

const localUrl = "http://127.0.0.1:54321";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";

process.env.NEXT_PUBLIC_SUPABASE_URL = localUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
process.env.OPENROUTER_API_KEY = "integration-test-key";

const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
const createdCallIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdCallIds.length) {
    await admin.from("calls").delete().in("id", createdCallIds.splice(0));
  }
  await Promise.all(
    createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id))
  );
});

async function createWorkspaceMember() {
  const password = `Test-${crypto.randomUUID()}!`;
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email: `database-contract-${crypto.randomUUID()}@example.com`,
      password,
      email_confirm: true,
    });
  if (createError) throw createError;
  createdUserIds.push(created.user.id);

  const { error: membershipError } = await admin
    .from("workspace_members")
    .insert({
      workspace_id: workspaceId,
      user_id: created.user.id,
      role: "member",
    });
  if (membershipError) throw membershipError;

  const client = createClient(localUrl, anonKey, {
    auth: { persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email: created.user.email!,
    password,
  });
  if (signInError) throw signInError;
  return { client, userId: created.user.id };
}

async function createCall(
  userId: string,
  overrides: Record<string, unknown> = {}
) {
  const callId = crypto.randomUUID();
  const chunkPrefix = `${workspaceId}/${callId}/chunks`;
  const { error } = await admin.from("calls").insert({
    id: callId,
    workspace_id: workspaceId,
    owner_id: userId,
    source_mode: "both",
    chunk_prefix: chunkPrefix,
    ...overrides,
  });
  if (error) throw error;
  createdCallIds.push(callId);
  return { callId, chunkPrefix };
}

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)("database authorization and durability contracts", () => {
  it("prevents a Workspace Member from rewriting protected Call fields directly", async () => {
    const { client, userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);

    const { data, error } = await (client as SupabaseClient)
      .from("calls")
      .update({
        status: "ready",
        source_path: `${workspaceId}/another-call/source.webm`,
      })
      .eq("id", callId)
      .select("status, source_path");

    expect(error).not.toBeNull();
    expect(data).toBeNull();
    const { data: storedCall } = await admin
      .from("calls")
      .select("status, source_path")
      .eq("id", callId)
      .single();
    expect(storedCall).toEqual({
      status: "recording",
      source_path: null,
    });
  });

  it("retains uploaded Source Audio when an Incomplete Recording ages out", async () => {
    const { userId } = await createWorkspaceMember();
    const oldTimestamp = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const { callId, chunkPrefix } = await createCall(userId, {
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });
    const chunkPath = `${chunkPrefix}/00000000.webm`;
    const { error: uploadError } = await admin.storage
      .from("recordings")
      .upload(chunkPath, Buffer.from("recoverable Source Audio"), {
        contentType: "audio/webm",
      });
    if (uploadError) throw uploadError;

    try {
      const { cleanupAbandonedCalls } = await import("./jobs.js");
      await cleanupAbandonedCalls();

      const { data: storedCall } = await admin
        .from("calls")
        .select("status")
        .eq("id", callId)
        .single();
      expect(storedCall?.status).toBe("abandoned");

      const { data: retainedAudio, error: downloadError } = await admin.storage
        .from("recordings")
        .download(chunkPath);
      expect(downloadError).toBeNull();
      await expect(retainedAudio?.text()).resolves.toBe(
        "recoverable Source Audio"
      );
    } finally {
      await admin.storage.from("recordings").remove([chunkPath]);
    }
  });

  it("reclaims a stale Transcription Job after its worker disappears", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    const staleLock = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "processing",
      idempotency_key: `reclaim:${callId}`,
      attempts: 1,
      max_attempts: 3,
      locked_at: staleLock,
      locked_by: "worker-that-disappeared",
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "replacement-worker" }
    );

    expect(claimError).toBeNull();
    expect(claimed).toHaveLength(1);
    expect(claimed?.[0]).toMatchObject({
      id: jobId,
      status: "processing",
      attempts: 2,
      locked_by: "replacement-worker",
    });
    const { data: processingCall } = await admin
      .from("calls")
      .select("status")
      .eq("id", callId)
      .single();
    expect(processingCall?.status).toBe("processing");
  });

  it("renews an active job lease only for its current token", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `heartbeat:${callId}`,
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "active-worker" }
    );
    if (claimError) throw claimError;
    const leaseToken = claimed?.[0]?.lease_token;
    expect(leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const { data: renewed, error: renewError } = await admin.rpc(
      "renew_processing_job_lease",
      {
        target_job_id: jobId,
        target_lease_token: leaseToken,
      }
    );
    expect(renewError).toBeNull();
    expect(renewed).toBe(true);

    const { data: rejected } = await admin.rpc("renew_processing_job_lease", {
      target_job_id: jobId,
      target_lease_token: crypto.randomUUID(),
    });
    expect(rejected).toBe(false);
  });

  it("commits processed recording state only for the current lease owner", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `commit:${callId}`,
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "commit-worker" }
    );
    if (claimError) throw claimError;
    const leaseToken = claimed?.[0]?.lease_token as string;
    const commitArgs = {
      target_job_id: jobId,
      target_source_path: `${workspaceId}/${callId}/artifacts/source.webm`,
      target_mp3_path: `${workspaceId}/${callId}/artifacts/recording.mp3`,
      target_source_bytes: 42,
      target_model: "test/model",
      target_language: "en",
      target_full_text: "lease fenced transcript",
      target_provider_generation_id: "generation-id",
      target_provider_cost_usd: 0.25,
      target_provider_duration_seconds: 1.5,
      target_segments: [
        {
          sequence: 0,
          start_ms: 0,
          end_ms: 1_500,
          text: "lease fenced transcript",
        },
      ],
    };

    const { data: rejected } = await admin.rpc("commit_processed_recording", {
      ...commitArgs,
      target_lease_token: crypto.randomUUID(),
    });
    expect(rejected).toBe(false);
    const { data: unchangedCall } = await admin
      .from("calls")
      .select("status, source_path")
      .eq("id", callId)
      .single();
    expect(unchangedCall).toEqual({
      status: "processing",
      source_path: null,
    });

    const { data: committed, error: commitError } = await admin.rpc(
      "commit_processed_recording",
      {
        ...commitArgs,
        target_lease_token: leaseToken,
      }
    );
    expect(commitError).toBeNull();
    expect(committed).toBe(true);

    const { data: readyCall } = await admin
      .from("calls")
      .select("status, source_path, mp3_path, source_bytes")
      .eq("id", callId)
      .single();
    expect(readyCall).toMatchObject({
      status: "ready",
      source_path: commitArgs.target_source_path,
      mp3_path: commitArgs.target_mp3_path,
      source_bytes: 42,
    });
    const { data: transcript } = await admin
      .from("transcripts")
      .select(
        "full_text, transcript_segments(sequence, start_ms, end_ms, text)"
      )
      .eq("call_id", callId)
      .single();
    expect(transcript).toMatchObject({
      full_text: "lease fenced transcript",
      transcript_segments: [
        {
          sequence: 0,
          start_ms: 0,
          end_ms: 1_500,
          text: "lease fenced transcript",
        },
      ],
    });
    const { data: completedJob } = await admin
      .from("processing_jobs")
      .select("status, lease_token, finished_at")
      .eq("id", jobId)
      .single();
    expect(completedJob).toMatchObject({
      status: "complete",
      lease_token: null,
    });
    expect(completedJob?.finished_at).not.toBeNull();
  });

  it("commits WAV export state only for the current lease owner", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const exportJobId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const { error: exportError } = await admin.from("export_jobs").insert({
      id: exportJobId,
      call_id: callId,
      requested_by: userId,
      format: "wav",
      status: "queued",
    });
    if (exportError) throw exportError;
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "generate_wav",
      status: "queued",
      idempotency_key: `wav-commit:${callId}`,
      payload: { exportJobId },
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "wav-worker" }
    );
    if (claimError) throw claimError;
    const leaseToken = claimed?.[0]?.lease_token as string;
    const wavPath = `${workspaceId}/${callId}/artifacts/recording.wav`;

    const { data: rejected } = await admin.rpc("commit_wav_export", {
      target_job_id: jobId,
      target_lease_token: crypto.randomUUID(),
      target_wav_path: wavPath,
    });
    expect(rejected).toBe(false);

    const { data: committed, error: commitError } = await admin.rpc(
      "commit_wav_export",
      {
        target_job_id: jobId,
        target_lease_token: leaseToken,
        target_wav_path: wavPath,
      }
    );
    expect(commitError).toBeNull();
    expect(committed).toBe(true);

    const [{ data: call }, { data: exportJob }, { data: completedJob }] =
      await Promise.all([
        admin.from("calls").select("wav_path").eq("id", callId).single(),
        admin
          .from("export_jobs")
          .select("status, completed_at")
          .eq("id", exportJobId)
          .single(),
        admin
          .from("processing_jobs")
          .select("status, lease_token")
          .eq("id", jobId)
          .single(),
      ]);
    expect(call?.wav_path).toBe(wavPath);
    expect(exportJob?.status).toBe("complete");
    expect(exportJob?.completed_at).not.toBeNull();
    expect(completedJob).toEqual({
      status: "complete",
      lease_token: null,
    });
  });

  it("deletes a Call only for the current deletion-job lease owner", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "delete_call",
      status: "queued",
      idempotency_key: `delete-commit:${callId}`,
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "delete-worker" }
    );
    if (claimError) throw claimError;
    const leaseToken = claimed?.[0]?.lease_token as string;

    const { data: rejected } = await admin.rpc("commit_call_deletion", {
      target_job_id: jobId,
      target_lease_token: crypto.randomUUID(),
    });
    expect(rejected).toBe(false);
    const { count: retainedCount } = await admin
      .from("calls")
      .select("id", { count: "exact", head: true })
      .eq("id", callId);
    expect(retainedCount).toBe(1);

    const { data: committed, error: commitError } = await admin.rpc(
      "commit_call_deletion",
      {
        target_job_id: jobId,
        target_lease_token: leaseToken,
      }
    );
    expect(commitError).toBeNull();
    expect(committed).toBe(true);

    const [{ count: callCount }, { data: completedJob }] = await Promise.all([
      admin
        .from("calls")
        .select("id", { count: "exact", head: true })
        .eq("id", callId),
      admin
        .from("processing_jobs")
        .select("status, call_id, lease_token")
        .eq("id", jobId)
        .single(),
    ]);
    expect(callCount).toBe(0);
    expect(completedJob).toEqual({
      status: "complete",
      call_id: null,
      lease_token: null,
    });
  });
});
