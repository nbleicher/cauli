import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";

const localUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const localServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";

process.env.NEXT_PUBLIC_SUPABASE_URL = localUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = localServiceRoleKey;
process.env.SUPABASE_WORKER_KEY = localServiceRoleKey;
process.env.OPENROUTER_API_KEY = "integration-test-key";

const supabase = createClient(localUrl, localServiceRoleKey, {
  auth: { persistSession: false },
});
const createdUsers: string[] = [];
const createdCalls: string[] = [];

afterEach(async () => {
  if (createdCalls.length) {
    const { error } = await supabase
      .from("calls")
      .delete()
      .in("id", createdCalls.splice(0));
    if (error) throw error;
  }
  for (const id of createdUsers.splice(0)) {
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) throw error;
  }
});

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
)("Supabase transcription checkpoint store", () => {
  it("round-trips a completed chunk and keeps the provider metadata", async () => {
    const { data: user, error: userError } =
      await supabase.auth.admin.createUser({
        email: `checkpoint-${crypto.randomUUID()}@example.com`,
        email_confirm: true,
      });
    if (userError) throw userError;
    createdUsers.push(user.user.id);

    const workspaceId = "00000000-0000-0000-0000-000000000001";
    const { error: membershipError } = await supabase
      .from("workspace_members")
      .insert({
        workspace_id: workspaceId,
        user_id: user.user.id,
        role: "member",
      });
    if (membershipError) throw membershipError;

    const { data: call, error: callError } = await supabase
      .from("calls")
      .insert({
        workspace_id: workspaceId,
        owner_id: user.user.id,
        source_mode: "both",
        chunk_prefix: `${workspaceId}/checkpoint-test/chunks`,
        recording_attested_by: user.user.id,
        recording_attested_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (callError) throw callError;
    createdCalls.push(call.id);

    const { createSupabaseCheckpointStore } =
      await import("./checkpoint-store.js");
    const store = createSupabaseCheckpointStore(call.id);
    await store.save({
      index: 2,
      text: "Persisted chunk",
      segments: [
        {
          sequence: 0,
          startMs: 1_196_000,
          endMs: 1_201_000,
          text: "Persisted chunk",
        },
      ],
      language: "en",
      durationSeconds: 5,
      costUsd: 0.0001,
      generationId: "generation-2",
      model: "openai/whisper-large-v3",
    });

    await expect(store.load(2)).resolves.toMatchObject({
      index: 2,
      text: "Persisted chunk",
      generationId: "generation-2",
      model: "openai/whisper-large-v3",
    });
  });
});
