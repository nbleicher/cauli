import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  MEASURED_PILOT_CAPACITY,
  meetsServiceLevel,
  PILOT_BURST_CALLS,
  PILOT_SERVICE_LEVEL_TARGET_MS,
  PILOT_WORKER_CONCURRENCY,
  projectedServiceLevelMs,
  sizeWorkerConcurrency,
} from "./capacity.js";

describe("worker concurrency sizing", () => {
  it("keeps the promise for the last Call in the burst, not just the first", () => {
    // A Call that takes two minutes: one worker makes the fifth Call wait ten.
    const measurement = {
      callsInBurst: PILOT_BURST_CALLS,
      processingMsPerCall: 120_000,
      queueOverheadMs: 5_000,
      serviceLevelTargetMs: PILOT_SERVICE_LEVEL_TARGET_MS,
    };
    expect(projectedServiceLevelMs(measurement, 1)).toBe(605_000);
    expect(meetsServiceLevel(measurement, 1)).toBe(false);
    expect(sizeWorkerConcurrency(measurement)).toBe(3);
    expect(meetsServiceLevel(measurement, 3)).toBe(true);
  });

  it("counts whole rounds, because a leftover Call waits a whole round", () => {
    const measurement = {
      callsInBurst: 5,
      processingMsPerCall: 100_000,
      queueOverheadMs: 0,
      serviceLevelTargetMs: PILOT_SERVICE_LEVEL_TARGET_MS,
    };
    // Four workers still leave a fifth Call for a second round.
    expect(projectedServiceLevelMs(measurement, 4)).toBe(200_000);
    expect(projectedServiceLevelMs(measurement, 5)).toBe(100_000);
  });

  it("reports the shortfall instead of inventing capacity it cannot have", () => {
    const tooSlow = {
      callsInBurst: 5,
      processingMsPerCall: 400_000,
      queueOverheadMs: 0,
      serviceLevelTargetMs: PILOT_SERVICE_LEVEL_TARGET_MS,
    };
    expect(sizeWorkerConcurrency(tooSlow)).toBe(5);
    expect(meetsServiceLevel(tooSlow, 5)).toBe(false);
  });

  it("ships the concurrency the recorded burst produced, and no less", () => {
    // docs/operations/processing-capacity.md holds the measurement behind
    // this. Lowering it without re-recording the burst breaks this test.
    expect(PILOT_WORKER_CONCURRENCY).toBe(3);
    expect(meetsServiceLevel(MEASURED_PILOT_CAPACITY, 3)).toBe(true);
    expect(meetsServiceLevel(MEASURED_PILOT_CAPACITY, 2)).toBe(false);
  });
});

const localUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const workspaceId = "00000000-0000-0000-0000-000000000001";

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
)("representative pilot load", () => {
  const admin = createClient(
    localUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key",
    { auth: { persistSession: false } }
  );

  it("absorbs five simultaneous Calls and measures each stage separately", async () => {
    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email: `capacity-${crypto.randomUUID()}@example.com`,
      password: `Test-${crypto.randomUUID()}!`,
      email_confirm: true,
    });
    if (userError) throw userError;
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert({
        workspace_id: workspaceId,
        user_id: user.user.id,
        role: "member",
      });
    if (membershipError) throw membershipError;

    const callIds: string[] = [];
    const jobIds: string[] = [];
    const stoppedAt = new Date();
    try {
      for (let index = 0; index < PILOT_BURST_CALLS; index += 1) {
        const callId = crypto.randomUUID();
        const jobId = crypto.randomUUID();
        callIds.push(callId);
        jobIds.push(jobId);
        // An hour of audio: the longest Call the five-minute target covers.
        const { error: callError } = await admin.from("calls").insert({
          id: callId,
          workspace_id: workspaceId,
          owner_id: user.user.id,
          source_mode: "mic",
          status: "queued",
          duration_ms: 3_600_000,
          stopped_at: stoppedAt.toISOString(),
          chunk_prefix: `${workspaceId}/${callId}/chunks`,
          recording_attested_by: user.user.id,
          recording_attested_at: stoppedAt.toISOString(),
        });
        if (callError) throw callError;
        const { error: jobError } = await admin.from("processing_jobs").insert({
          id: jobId,
          workspace_id: workspaceId,
          call_id: callId,
          kind: "process_recording",
          status: "queued",
          idempotency_key: `capacity-${index}:${callId}`,
        });
        if (jobError) throw jobError;
      }

      // Five workers claim at once, the way a burst actually arrives.
      const claims = await Promise.all(
        Array.from({ length: PILOT_BURST_CALLS }, (_unused, index) =>
          admin.rpc("claim_processing_job", { worker_name: `load-${index}` })
        )
      );
      const claimed = claims.flatMap((claim) => {
        if (claim.error) throw claim.error;
        return (claim.data ?? []) as Array<{ id: string; lease_token: string }>;
      });
      expect(claimed).toHaveLength(PILOT_BURST_CALLS);
      // No job was handed to two workers.
      expect(new Set(claimed.map((job) => job.id)).size).toBe(
        PILOT_BURST_CALLS
      );

      for (const job of claimed) {
        const { error: commitError } = await admin.rpc(
          "commit_processed_recording",
          {
            target_job_id: job.id,
            target_lease_token: job.lease_token,
            target_source_path: `${workspaceId}/source.webm`,
            target_mp3_path: `${workspaceId}/recording.mp3`,
            target_source_bytes: 1_024,
            target_model: "openai/whisper-large-v3-turbo",
            target_language: "en",
            target_full_text: "load test",
            target_provider_generation_id: null,
            target_provider_cost_usd: 0.01,
            target_provider_duration_seconds: 3_600,
            target_segments: [],
          }
        );
        if (commitError) throw commitError;
      }

      const { data: runs, error: runsError } = await admin
        .from("processing_runs")
        .select(
          "queue_ms, processing_ms, service_level_ms, counts_toward_target, met_target"
        )
        .in("job_id", jobIds);
      if (runsError) throw runsError;
      expect(runs).toHaveLength(PILOT_BURST_CALLS);
      for (const run of runs ?? []) {
        // Queue time and processing time are recorded apart...
        expect(run.queue_ms).toBeGreaterThanOrEqual(0);
        expect(run.processing_ms).toBeGreaterThanOrEqual(0);
        // ...while the promise is measured on the clock the user experiences.
        expect(run.service_level_ms).toBeGreaterThanOrEqual(0);
        expect(run.counts_toward_target).toBe(true);
        expect(run.met_target).toBe(true);
      }

      const { data: level, error: levelError } = await admin.rpc(
        "processing_service_level",
        { window_hours: 1 }
      );
      if (levelError) throw levelError;
      expect(level).toMatchObject({
        eligibleCalls: PILOT_BURST_CALLS,
        callsWithinTarget: PILOT_BURST_CALLS,
        ratioWithinTarget: 1,
      });
    } finally {
      await admin.from("processing_runs").delete().in("job_id", jobIds);
      await admin.from("processing_jobs").delete().in("id", jobIds);
      await admin.from("calls").delete().in("id", callIds);
      await admin
        .from("processing_spend")
        .delete()
        .eq("workspace_id", workspaceId);
      await admin
        .from("workspace_members")
        .delete()
        .eq("user_id", user.user.id);
      await admin.auth.admin.deleteUser(user.user.id);
    }
  });

  it("keeps a Call longer than an hour supported but out of the target", async () => {
    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email: `capacity-long-${crypto.randomUUID()}@example.com`,
      password: `Test-${crypto.randomUUID()}!`,
      email_confirm: true,
    });
    if (userError) throw userError;
    await admin.from("workspace_members").insert({
      workspace_id: workspaceId,
      user_id: user.user.id,
      role: "member",
    });
    const callId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    try {
      await admin.from("calls").insert({
        id: callId,
        workspace_id: workspaceId,
        owner_id: user.user.id,
        source_mode: "mic",
        status: "queued",
        // Three hours: still supported, deliberately not counted.
        duration_ms: 10_800_000,
        stopped_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        chunk_prefix: `${workspaceId}/${callId}/chunks`,
        recording_attested_by: user.user.id,
        recording_attested_at: new Date().toISOString(),
      });
      await admin.from("processing_jobs").insert({
        id: jobId,
        workspace_id: workspaceId,
        call_id: callId,
        kind: "process_recording",
        status: "queued",
        idempotency_key: `capacity-long:${callId}`,
      });
      const { data: claimed } = await admin.rpc("claim_processing_job", {
        worker_name: "load-long",
      });
      const job = (claimed as Array<{ id: string; lease_token: string }>)[0]!;
      await admin.rpc("commit_processed_recording", {
        target_job_id: job.id,
        target_lease_token: job.lease_token,
        target_source_path: `${workspaceId}/source.webm`,
        target_mp3_path: `${workspaceId}/recording.mp3`,
        target_source_bytes: 1_024,
        target_model: "openai/whisper-large-v3-turbo",
        target_language: "en",
        target_full_text: "long call",
        target_provider_generation_id: null,
        target_provider_cost_usd: 0.02,
        target_provider_duration_seconds: 10_800,
        target_segments: [],
      });

      const { data: run } = await admin
        .from("processing_runs")
        .select("counts_toward_target, met_target, service_level_ms")
        .eq("job_id", jobId)
        .single();
      expect(run?.counts_toward_target).toBe(false);
      expect(run?.met_target).toBeNull();
      // Measured anyway: excluded from the target is not excluded from sight.
      expect(Number(run?.service_level_ms)).toBeGreaterThan(0);

      const { data: level } = await admin.rpc("processing_service_level", {
        window_hours: 1,
      });
      expect(level).toMatchObject({ longCallsExcluded: 1, eligibleCalls: 0 });
    } finally {
      await admin.from("processing_runs").delete().eq("job_id", jobId);
      await admin.from("processing_jobs").delete().eq("id", jobId);
      await admin.from("calls").delete().eq("id", callId);
      await admin
        .from("processing_spend")
        .delete()
        .eq("workspace_id", workspaceId);
      await admin
        .from("workspace_members")
        .delete()
        .eq("user_id", user.user.id);
      await admin.auth.admin.deleteUser(user.user.id);
    }
  });
});
