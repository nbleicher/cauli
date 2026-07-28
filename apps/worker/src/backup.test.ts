import { createClient } from "@supabase/supabase-js";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const localUrl = "http://127.0.0.1:54321";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";

process.env.NEXT_PUBLIC_SUPABASE_URL = localUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
process.env.OPENROUTER_API_KEY = "integration-test-key";

const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const createdCallIds: string[] = [];
const createdUserIds: string[] = [];
const createdKeyVersions: number[] = [];

const kms = generateKeyPairSync("rsa", { modulusLength: 4096 });
const kmsPublicKeyPem = kms.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const ageRecipient =
  "age18m4055pa59f7cz07xf8uzhu9e6ykyl26taccljde405xeulmpv9sym64p7";

const target = {
  baseUrl: "https://backup.example.test",
  clientCertificatePem:
    "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
  clientKeyPem:
    "-----BEGIN PRIVATE KEY-----\nworker\n-----END PRIVATE KEY-----",
  certificateAuthorityPem:
    "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
};

const sourceAudio = Buffer.from("the authoritative media for one Call");

afterEach(async () => {
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

async function registerKeyVersion() {
  const version = Math.floor(Math.random() * 1_000_000) + 5_000_000;
  const { error } = await admin.from("backup_key_versions").insert({
    version,
    kms_key_id: "arn:aws:kms:us-east-2:000000000000:key/cauli-backup",
    kms_public_key_sha256: "a".repeat(64),
    age_recipient: ageRecipient,
    age_recipient_sha256: "b".repeat(64),
  });
  if (error) throw error;
  createdKeyVersions.push(version);
  return version;
}

async function createReadyCall() {
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email: `backup-worker-${crypto.randomUUID()}@example.com`,
      password: `Test-${crypto.randomUUID()}!`,
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

  const callId = crypto.randomUUID();
  const { error } = await admin.from("calls").insert({
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
  if (error) throw error;
  createdCallIds.push(callId);
  return callId;
}

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
)("the Source Audio Backup worker", () => {
  it("carries one Call from queued to a recoverable stored copy", async () => {
    const { backUpOneSourceAudio, loadActiveBackupRecipients } =
      await import("./backup.js");
    const keyVersion = await registerKeyVersion();
    const callId = await createReadyCall();

    process.env.BACKUP_KMS_PUBLIC_KEY = kmsPublicKeyPem;
    const recipients = await loadActiveBackupRecipients();
    expect(recipients).toMatchObject({ ageRecipient, keyVersion });

    const received: {
      url: string;
      headers: Headers;
      body: Buffer;
    }[] = [];
    const worked = await backUpOneSourceAudio({
      downloadSourceAudio: async (storagePath) => {
        expect(storagePath).toContain(callId);
        return sourceAudio;
      },
      target,
      recipients: recipients!,
      fetch: async (url, init) => {
        received.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: Buffer.from(init?.body as Uint8Array),
        });
        return new Response(null, { status: 201 });
      },
    });
    expect(worked).toBe(true);
    expect(received).toHaveLength(1);

    // What crossed the wire is ciphertext, not the recording.
    const sent = received[0]!;
    expect(sent.body.includes(sourceAudio)).toBe(false);
    expect(sent.url).toMatch(/\/objects\/[0-9a-f]{64}$/);
    expect(sent.url).not.toContain(callId);
    expect(sent.url).not.toContain(workspaceId);

    const { data: stored } = await admin
      .from("source_audio_backups")
      .select(
        "state, object_name, key_version, ciphertext_sha256, ciphertext_bytes, stored_at"
      )
      .eq("call_id", callId)
      .single();
    expect(stored).toMatchObject({
      state: "stored",
      key_version: keyVersion,
      ciphertext_bytes: sourceAudio.length,
    });
    expect(sent.url).toContain(stored!.object_name);
    expect(sent.headers.get("x-cauli-checksum-sha256")).toBe(
      stored!.ciphertext_sha256
    );

    // The stored copy is genuinely recoverable: unwrap through KMS, verify,
    // and the original Source Audio comes back byte for byte.
    const { data: wrapped } = await admin
      .from("source_audio_backups")
      .select("kms_wrapped_key")
      .eq("call_id", callId)
      .single();
    const dataKey = privateDecrypt(
      {
        key: kms.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(wrapped!.kms_wrapped_key, "base64")
    );
    const { restoreSourceAudio } = await import("./backup-crypto.js");
    const restored = restoreSourceAudio({
      ciphertext: sent.body,
      manifest: Buffer.from(sent.headers.get("x-cauli-manifest")!, "base64"),
      ciphertextSha256: sent.headers.get("x-cauli-checksum-sha256")!,
      dataKey,
    });
    expect(restored.sourceAudio.equals(sourceAudio)).toBe(true);

    // Nothing is left to do, so a second pass finds no work.
    expect(
      await backUpOneSourceAudio({
        downloadSourceAudio: async () => {
          throw new Error("should not download an already stored Call");
        },
        target,
        recipients: recipients!,
        fetch: async () => new Response(null, { status: 201 }),
      })
    ).toBe(false);
  });

  it("leaves an unreachable target queued for another attempt", async () => {
    const { backUpOneSourceAudio } = await import("./backup.js");
    const keyVersion = await registerKeyVersion();
    const callId = await createReadyCall();

    const worked = await backUpOneSourceAudio({
      downloadSourceAudio: async () => sourceAudio,
      target,
      recipients: {
        kmsPublicKeyPem,
        kmsKeyId: "arn:aws:kms:us-east-2:000000000000:key/cauli-backup",
        ageRecipient,
        keyVersion,
      },
      fetch: async () => new Response(null, { status: 503 }),
    });
    expect(worked).toBe(true);

    const { data: queued } = await admin
      .from("source_audio_backups")
      .select("state, attempts, last_error")
      .eq("call_id", callId)
      .single();
    // Still owed, not lost, and the reason recorded says what failed rather
    // than anything about the Call.
    expect(queued).toMatchObject({ state: "pending", attempts: 1 });
    expect(queued!.last_error).toMatch(/receiver is unavailable \(503\)/);
    expect(queued!.last_error).not.toContain(callId);
  });
});
