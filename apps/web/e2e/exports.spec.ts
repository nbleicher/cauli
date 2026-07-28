import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";

const localUrl = "http://127.0.0.1:54321";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
const localServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";

const admin = createClient(localUrl, localServiceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires the local Supabase stack"
);

test("a Workspace Member exports a Transcript as TXT and SRT, audited", async ({
  page,
}) => {
  const email = `export-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}!`;
  const callId = crypto.randomUUID();
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createError) throw createError;

  try {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .insert({
        workspace_id: workspaceId,
        user_id: created.user.id,
        role: "member",
      });
    if (membershipError) throw membershipError;

    const { error: callError } = await admin.from("calls").insert({
      id: callId,
      workspace_id: workspaceId,
      owner_id: created.user.id,
      title: "Renewal with Acme",
      source_mode: "mic",
      status: "ready",
      duration_ms: 12_000,
      chunk_prefix: `${workspaceId}/${callId}/chunks`,
      recording_attested_by: created.user.id,
      recording_attested_at: new Date().toISOString(),
    });
    if (callError) throw callError;

    const { data: transcript, error: transcriptError } = await admin
      .from("transcripts")
      .insert({
        call_id: callId,
        model: "openai/whisper-large-v3-turbo",
        language: "en",
        full_text: "Thanks for joining. We agreed to renew.",
      })
      .select("id")
      .single();
    if (transcriptError) throw transcriptError;
    const { error: segmentError } = await admin
      .from("transcript_segments")
      .insert([
        {
          transcript_id: transcript.id,
          sequence: 0,
          start_ms: 0,
          end_ms: 2_500,
          text: "Thanks for joining.",
        },
        {
          transcript_id: transcript.id,
          sequence: 1,
          start_ms: 2_500,
          end_ms: 6_000,
          text: "We agreed to renew.",
        },
      ]);
    if (segmentError) throw segmentError;

    await signInAsWorkspaceMember(page, email, password);
    await page.goto(`/calls/${callId}`);

    // The export is fetched through the app, then delivered by signed URL.
    async function exportTranscript(format: "txt" | "srt") {
      const response = await page.request.post(
        `/api/calls/${callId}/transcript?format=${format}`
      );
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as {
        url: string;
        expiresIn: number;
      };
      expect(body.expiresIn).toBe(600);
      expect(body.url).toContain("token=");
      const delivered = await page.request.get(body.url);
      expect(delivered.ok()).toBe(true);
      return delivered.text();
    }

    const txt = await exportTranscript("txt");
    expect(txt).toBe(
      "[00:00:00] Thanks for joining.\n[00:00:02] We agreed to renew.\n"
    );

    const srt = await exportTranscript("srt");
    expect(srt).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:02,500",
        "Thanks for joining.",
        "",
        "2",
        "00:00:02,500 --> 00:00:06,000",
        "We agreed to renew.",
        "",
      ].join("\n")
    );

    // The buttons that produce them are on the Call.
    await expect(
      page.getByRole("button", { name: "Export TXT" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Export SRT" })
    ).toBeVisible();

    const { data: events } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("entity_id", callId)
      .eq("action", "call.download.created")
      .order("id");
    expect(
      events?.map((event) => event.metadata as { artifact_type: string })
    ).toEqual([
      { artifact_type: "transcript_txt" },
      { artifact_type: "transcript_srt" },
    ]);

    // An unsupported format is refused rather than guessed at.
    const badFormat = await page.request.post(
      `/api/calls/${callId}/transcript?format=docx`
    );
    expect(badFormat.status()).toBe(400);

    // The generated exports are real artifacts under the prefix the deletion
    // job sweeps, which is what makes retention remove them.
    const { data: artifacts } = await admin.storage
      .from("recordings")
      .list(`${workspaceId}/${callId}/artifacts`);
    expect(artifacts?.map((file) => file.name).sort()).toEqual([
      "transcript.srt",
      "transcript.txt",
    ]);

    // Delivery is short-lived: once a signed link is past its window it stops
    // working, whoever holds it.
    const { data: expiring, error: expiringError } = await admin.storage
      .from("recordings")
      .createSignedUrl(`${workspaceId}/${callId}/artifacts/transcript.txt`, 1);
    if (expiringError) throw expiringError;
    expect((await page.request.get(expiring.signedUrl)).ok()).toBe(true);
    await page.waitForTimeout(1_500);
    const expired = await page.request.get(expiring.signedUrl);
    expect(expired.ok()).toBe(false);
    expect(expired.status()).toBe(400);

    // A tampered token is refused rather than partially trusted.
    const tampered = await page.request.get(
      expiring.signedUrl.replace(/token=.{4}/, "token=aaaa")
    );
    expect(tampered.ok()).toBe(false);
  } finally {
    await admin.storage
      .from("recordings")
      .remove([
        `${workspaceId}/${callId}/artifacts/transcript.txt`,
        `${workspaceId}/${callId}/artifacts/transcript.srt`,
      ]);
    await admin.from("calls").delete().eq("id", callId);
    await admin
      .from("workspace_members")
      .delete()
      .eq("user_id", created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
