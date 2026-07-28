import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { signInAsWorkspaceMember } from "./helpers/auth";
import { enrollVerifiedTotp } from "./helpers/totp";

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

async function createMember(role: "member" | "manager" | "admin") {
  const email = `deletion-${role}-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}!`;
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError) throw createError;
  const { error: membershipError } = await admin
    .from("workspace_members")
    .insert({ workspace_id: workspaceId, user_id: created.user.id, role });
  if (membershipError) throw membershipError;
  return { email, password, userId: created.user.id };
}

async function createBackedUpCall(ownerId: string) {
  const version = Math.floor(Math.random() * 1_000_000) + 9_000_000;
  const { error: keyError } = await admin.from("backup_key_versions").insert({
    version,
    kms_key_id: "arn:aws:kms:us-east-2:000000000000:key/cauli-backup",
    kms_public_key_sha256: "a".repeat(64),
    age_recipient:
      "age18m4055pa59f7cz07xf8uzhu9e6ykyl26taccljde405xeulmpv9sym64p7",
    age_recipient_sha256: "b".repeat(64),
  });
  if (keyError) throw keyError;

  const callId = crypto.randomUUID();
  const { error: callError } = await admin.from("calls").insert({
    id: callId,
    workspace_id: workspaceId,
    owner_id: ownerId,
    title: "A Call that will be deleted",
    source_mode: "both",
    status: "ready",
    chunk_prefix: `${workspaceId}/${callId}/chunks`,
    source_path: `${workspaceId}/${callId}/artifacts/source.webm`,
    recording_attested_by: ownerId,
    recording_attested_at: new Date().toISOString(),
  });
  if (callError) throw callError;

  const { data: claimed } = await admin.rpc("claim_source_audio_backup", {
    worker_name: "deletion-journey",
  });
  const objectName = claimed.object_name as string;
  await admin.rpc("commit_source_audio_backup", {
    target_call_id: claimed.call_id,
    target_lease_token: claimed.lease_token,
    target_object_name: objectName,
    target_key_version: version,
    target_kms_wrapped_key: "kms-wrapped",
    target_age_wrapped_key: "age-wrapped",
    target_ciphertext_sha256: "d".repeat(64),
    target_ciphertext_bytes: 1_024,
  });
  return { callId, objectName, version };
}

test("deleting a Call reaches its backup and refuses a Manager on someone else's", async ({
  page,
}) => {
  const owner = await createMember("member");
  const manager = await createMember("manager");
  const created = await createBackedUpCall(owner.userId);

  try {
    // A Manager may review every Call but may not delete another person's.
    const managerClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: managerSignInError } =
      await managerClient.auth.signInWithPassword({
        email: manager.email,
        password: manager.password,
      });
    if (managerSignInError) throw managerSignInError;
    const { secret } = await enrollVerifiedTotp(managerClient);

    await signInAsWorkspaceMember(
      page,
      manager.email,
      manager.password,
      2,
      secret
    );
    await page.goto(`/calls/${created.callId}`);
    await expect(
      page.getByRole("heading", { name: "A Call that will be deleted" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    const refused = await page.request.delete(`/api/calls/${created.callId}`);
    expect(refused.status()).toBe(404);
    const { data: survived } = await admin
      .from("calls")
      .select("deleted_at")
      .eq("id", created.callId)
      .single();
    expect(survived?.deleted_at).toBeNull();

    // The Call owner may, and doing so reaches every copy.
    await page.request.post("/api/auth/signout");
    await page.context().clearCookies();
    await signInAsWorkspaceMember(page, owner.email, owner.password);
    await page.goto(`/calls/${created.callId}`);

    page.once("dialog", (dialog) => void dialog.accept());
    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === `/api/calls/${created.callId}`
    );
    await page.getByRole("button", { name: "Delete" }).click();
    expect((await deleteResponse).status()).toBe(204);

    await expect(page).toHaveURL(/\/calls$/);
    await expect(page.getByText("A Call that will be deleted")).toHaveCount(0);

    const [{ data: deletedCall }, { data: job }, { data: authorization }] =
      await Promise.all([
        admin
          .from("calls")
          .select("deleted_at")
          .eq("id", created.callId)
          .single(),
        admin
          .from("processing_jobs")
          .select("kind")
          .eq("call_id", created.callId)
          .eq("kind", "delete_call")
          .single(),
        admin
          .from("backup_deletion_requests")
          .select("reason, deleted_at")
          .eq("object_name", created.objectName)
          .single(),
      ]);
    expect(deletedCall?.deleted_at).not.toBeNull();
    expect(job?.kind).toBe("delete_call");
    // The browser action produced the authorization the retention principal
    // needs, so the copy on the VPS is owed a deletion too.
    expect(authorization).toEqual({ reason: "manual", deleted_at: null });

    const { data: auditEvent } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("entity_id", created.callId)
      .eq("action", "call.deletion.requested")
      .single();
    expect(auditEvent?.metadata).toMatchObject({
      actor_role: "member",
      reason: "manual",
      backup_deletion_requested: true,
    });
  } finally {
    await admin
      .from("backup_deletion_requests")
      .delete()
      .eq("object_name", created.objectName);
    await admin.from("calls").delete().eq("id", created.callId);
    await admin
      .from("backup_key_versions")
      .delete()
      .eq("version", created.version);
    for (const { userId } of [owner, manager]) {
      await admin.from("workspace_members").delete().eq("user_id", userId);
      await admin.auth.admin.deleteUser(userId);
    }
  }
});
