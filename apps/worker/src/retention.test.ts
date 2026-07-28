import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const localUrl = "http://127.0.0.1:54321";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const jwtSecret = process.env.SUPABASE_JWT_SECRET ?? "";
const workspaceId = "00000000-0000-0000-0000-000000000001";

process.env.NEXT_PUBLIC_SUPABASE_URL = localUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
process.env.OPENROUTER_API_KEY = "integration-test-key";

const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const target = {
  baseUrl: "https://backup.example.test",
  clientCertificatePem:
    "-----BEGIN CERTIFICATE-----\nretention\n-----END CERTIFICATE-----",
  clientKeyPem:
    "-----BEGIN PRIVATE KEY-----\nretention\n-----END PRIVATE KEY-----",
  certificateAuthorityPem:
    "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
};

const createdCallIds: string[] = [];
const createdUserIds: string[] = [];
const createdKeyVersions: number[] = [];
const createdObjectNames: string[] = [];

function base64Url(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** A credential that really is the retention principal, not a stand-in. */
function retentionCredential() {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      role: "cauli_retention",
      iss: "supabase-demo",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    })
  );
  const signature = base64Url(
    createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

afterEach(async () => {
  if (createdObjectNames.length) {
    await admin
      .from("backup_deletion_requests")
      .delete()
      .in("object_name", createdObjectNames.splice(0));
  }
  if (createdCallIds.length) {
    await admin.from("calls").delete().in("id", createdCallIds.splice(0));
  }
  if (createdKeyVersions.length) {
    await admin
      .from("backup_key_versions")
      .delete()
      .in("version", createdKeyVersions.splice(0));
  }
  const userIds = createdUserIds.splice(0);
  if (userIds.length) {
    await admin.from("workspace_members").delete().in("user_id", userIds);
    for (const userId of userIds) await admin.auth.admin.deleteUser(userId);
  }
});

async function createDeletedCallWithBackup() {
  const version = Math.floor(Math.random() * 1_000_000) + 8_000_000;
  const { error: keyError } = await admin.from("backup_key_versions").insert({
    version,
    kms_key_id: "arn:aws:kms:us-east-2:000000000000:key/cauli-backup",
    kms_public_key_sha256: "a".repeat(64),
    age_recipient:
      "age18m4055pa59f7cz07xf8uzhu9e6ykyl26taccljde405xeulmpv9sym64p7",
    age_recipient_sha256: "b".repeat(64),
  });
  if (keyError) throw keyError;
  createdKeyVersions.push(version);

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email: `retention-${crypto.randomUUID()}@example.com`,
      password: `Test-${crypto.randomUUID()}!`,
      email_confirm: true,
    });
  if (createError) throw createError;
  createdUserIds.push(created.user.id);
  await admin.from("workspace_members").insert({
    workspace_id: workspaceId,
    user_id: created.user.id,
    role: "member",
  });

  const callId = crypto.randomUUID();
  const { error: callError } = await admin.from("calls").insert({
    id: callId,
    workspace_id: workspaceId,
    owner_id: created.user.id,
    source_mode: "both",
    chunk_prefix: `${workspaceId}/${callId}/chunks`,
    recording_attested_by: created.user.id,
    recording_attested_at: new Date().toISOString(),
    status: "ready",
    source_path: `${workspaceId}/${callId}/artifacts/source.webm`,
  });
  if (callError) throw callError;
  createdCallIds.push(callId);

  const { data: claimed } = await admin.rpc("claim_source_audio_backup", {
    worker_name: "retention-fixture",
  });
  const objectName = crypto
    .randomUUID()
    .replaceAll("-", "")
    .concat(crypto.randomUUID().replaceAll("-", ""));
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
  createdObjectNames.push(objectName);

  await admin.rpc("begin_call_deletion", {
    target_call_id: callId,
    target_actor_id: created.user.id,
    target_reason: "manual",
    target_actor_role: "member",
  });
  return { callId, objectName };
}

describe("the retention principal", () => {
  it("has no way to create or overwrite a backup", async () => {
    const retention = await import("./retention.js");
    // Deleting is all it does. The module carries no encryption and no create.
    expect(
      Object.keys(retention).filter((name) =>
        /create|encrypt|wrap|upload|store/i.test(name)
      )
    ).toEqual([]);
    expect(Object.keys(retention)).toContain("deleteBackupObject");
  });

  it("uses its own certificate rather than the worker's", async () => {
    const retention = await import("./retention.js");
    expect(
      retention.retentionTargetFromEnvironment({
        BACKUP_VPS_URL: target.baseUrl,
        BACKUP_VPS_CA_CERT: target.certificateAuthorityPem,
        // The credential that creates backups is present and still not enough.
        BACKUP_VPS_CLIENT_CERT: "worker-cert",
        BACKUP_VPS_CLIENT_KEY: "worker-key",
      })
    ).toBeNull();

    expect(
      retention.retentionTargetFromEnvironment({
        BACKUP_VPS_URL: target.baseUrl,
        BACKUP_VPS_CA_CERT: target.certificateAuthorityPem,
        RETENTION_VPS_CLIENT_CERT: target.clientCertificatePem,
        RETENTION_VPS_CLIENT_KEY: target.clientKeyPem,
      })
    ).toEqual(target);
  });

  it("treats an already absent copy as deleted", async () => {
    const retention = await import("./retention.js");
    const objectName = "a".repeat(64);
    for (const status of [204, 404]) {
      await expect(
        retention.deleteBackupObject(target, objectName, {
          fetch: async (url, init) => {
            expect(init?.method).toBe("DELETE");
            expect(String(url)).toBe(
              `https://backup.example.test/objects/${objectName}`
            );
            return new Response(null, { status });
          },
        })
      ).resolves.toBeUndefined();
    }

    await expect(
      retention.deleteBackupObject(target, objectName, {
        fetch: async () => new Response(null, { status: 503 }),
      })
    ).rejects.toThrow(/could not be deleted \(503\)/);
  });
});

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
)("the retention deletion worker", () => {
  it("removes the backup an application deletion authorized", async () => {
    const { deleteOneAuthorizedBackup } = await import("./retention.js");
    const { callId, objectName } = await createDeletedCallWithBackup();

    const requests: string[] = [];
    const worked = await deleteOneAuthorizedBackup({
      target,
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(null, { status: 204 });
      },
    });
    expect(worked).toBe(true);

    // The instruction it acted on names an object and nothing else.
    expect(requests).toEqual([
      `https://backup.example.test/objects/${objectName}`,
    ]);
    expect(requests[0]).not.toContain(callId);
    expect(requests[0]).not.toContain(workspaceId);

    const { data: settled } = await admin
      .from("backup_deletion_requests")
      .select("deleted_at")
      .eq("object_name", objectName)
      .single();
    expect(settled?.deleted_at).not.toBeNull();

    // Nothing owed, so a second pass finds no work rather than deleting twice.
    expect(
      await deleteOneAuthorizedBackup({
        target,
        fetch: async () => {
          throw new Error("should not delete an already removed copy");
        },
      })
    ).toBe(false);
  });

  it("keeps the copy owed when the target refuses", async () => {
    const { deleteOneAuthorizedBackup } = await import("./retention.js");
    const { objectName } = await createDeletedCallWithBackup();

    const worked = await deleteOneAuthorizedBackup({
      target,
      fetch: async () => new Response(null, { status: 503 }),
    });
    expect(worked).toBe(true);

    const { data: owed } = await admin
      .from("backup_deletion_requests")
      .select("deleted_at, attempts, last_error")
      .eq("object_name", objectName)
      .single();
    expect(owed).toMatchObject({ deleted_at: null, attempts: 1 });
    expect(owed!.last_error).toMatch(/could not be deleted \(503\)/);
  });

  it.skipIf(!jwtSecret)(
    "cannot read a Call, a Transcript, or a wrapped key with its own credential",
    async () => {
      const { objectName } = await createDeletedCallWithBackup();
      const principal = createClient(localUrl, retentionCredential(), {
        auth: { persistSession: false },
      });

      // Everything that would tell it what it is deleting, or let it decrypt
      // what it deleted, is closed to it.
      for (const table of [
        "calls",
        "transcripts",
        "call_reviews",
        "source_audio_backups",
        "backup_deletion_requests",
      ]) {
        const { data, error } = await principal.from(table).select("*");
        expect(data ?? [], table).toEqual([]);
        if (error) expect(error.code, table).toMatch(/42501|PGRST/);
      }

      // It cannot start a deletion or claim a backup was stored either.
      for (const command of [
        "request_call_deletion",
        "begin_call_deletion",
        "commit_source_audio_backup",
        "expire_calls_for_retention",
      ]) {
        const { error } = await principal.rpc(command, {});
        expect(error, command).toBeTruthy();
      }

      // What it can do is carry out the one instruction it was handed.
      const { data: claimed, error: claimError } = await principal.rpc(
        "claim_backup_deletion",
        { worker_name: "retention-principal" }
      );
      expect(claimError).toBeNull();
      expect(claimed).toBe(objectName);

      const { data: committed, error: commitError } = await principal.rpc(
        "commit_backup_deletion",
        { target_object_name: objectName }
      );
      expect(commitError).toBeNull();
      expect(committed).toBe(true);

      // And nothing beyond it.
      const { error: unauthorizedError } = await principal.rpc(
        "commit_backup_deletion",
        { target_object_name: "9".repeat(64) }
      );
      expect(unauthorizedError?.message).toMatch(/never authorized/);
    }
  );
});
