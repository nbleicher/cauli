import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

const localUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";

process.env.NEXT_PUBLIC_SUPABASE_URL = localUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
process.env.OPENROUTER_API_KEY = "integration-test-key";

const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
)("deletion removes generated export artifacts", () => {
  it("sweeps Transcript exports along with the media they came from", async () => {
    const { claimJob, runJob } = await import("./jobs.js");

    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email: `export-cleanup-${crypto.randomUUID()}@example.com`,
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

    const callId = crypto.randomUUID();
    const prefix = `${workspaceId}/${callId}/artifacts`;
    try {
      const { error: callError } = await admin.from("calls").insert({
        id: callId,
        workspace_id: workspaceId,
        owner_id: user.user.id,
        source_mode: "mic",
        status: "ready",
        chunk_prefix: `${workspaceId}/${callId}/chunks`,
        source_path: `${prefix}/source.webm`,
        mp3_path: `${prefix}/recording.mp3`,
        recording_attested_by: user.user.id,
        recording_attested_at: new Date().toISOString(),
      });
      if (callError) throw callError;

      // Everything a Call can accumulate: the media the worker produced and
      // the Transcript exports a Workspace Member asked for.
      for (const [name, body, type] of [
        ["source.webm", "source audio fixture", "audio/webm"],
        ["recording.mp3", "mp3 fixture", "audio/mpeg"],
        ["transcript.txt", "[00:00:00] hello\n", "text/plain"],
        [
          "transcript.srt",
          "1\n00:00:00,000 --> 00:00:01,000\nhello\n",
          "text/plain",
        ],
      ] as const) {
        const { error } = await admin.storage
          .from("recordings")
          .upload(`${prefix}/${name}`, new Blob([body], { type }), {
            contentType: type,
            upsert: true,
          });
        if (error) throw error;
      }

      const { data: before } = await admin.storage
        .from("recordings")
        .list(prefix);
      expect(before?.map((file) => file.name).sort()).toEqual([
        "recording.mp3",
        "source.webm",
        "transcript.srt",
        "transcript.txt",
      ]);

      const jobId = crypto.randomUUID();
      const { error: jobError } = await admin.from("processing_jobs").insert({
        id: jobId,
        workspace_id: workspaceId,
        call_id: callId,
        kind: "delete_call",
        status: "queued",
        idempotency_key: `export-cleanup:${callId}`,
      });
      if (jobError) throw jobError;

      const job = await claimJob();
      expect(job?.id).toBe(jobId);
      await runJob(job!);

      const { data: after } = await admin.storage
        .from("recordings")
        .list(prefix);
      // No artifact of any kind survives the Call it belonged to.
      expect(after ?? []).toEqual([]);
      const { count } = await admin
        .from("calls")
        .select("id", { count: "exact", head: true })
        .eq("id", callId);
      expect(count).toBe(0);
    } finally {
      await admin.storage
        .from("recordings")
        .remove([
          `${prefix}/source.webm`,
          `${prefix}/recording.mp3`,
          `${prefix}/transcript.txt`,
          `${prefix}/transcript.srt`,
        ]);
      await admin.from("calls").delete().eq("id", callId);
      await admin
        .from("workspace_members")
        .delete()
        .eq("user_id", user.user.id);
      await admin.auth.admin.deleteUser(user.user.id);
    }
  });
});
