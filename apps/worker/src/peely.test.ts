import { createClient } from "@supabase/supabase-js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const target = {
  baseUrl: "https://backup.example.test",
  clientCertificatePem:
    "-----BEGIN CERTIFICATE-----\npeely\n-----END CERTIFICATE-----",
  clientKeyPem: "-----BEGIN PRIVATE KEY-----\npeely\n-----END PRIVATE KEY-----",
  certificateAuthorityPem:
    "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
};

const directories: string[] = [];
const createdCallIds: string[] = [];
const createdUserIds: string[] = [];
const createdKeyVersions: number[] = [];
const createdObjectNames: string[] = [];
const createdRunIds: number[] = [];

const kms = generateKeyPairSync("rsa", { modulusLength: 4096 });
const kmsPublicKeyPem = kms.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const ageRecipient =
  "age18m4055pa59f7cz07xf8uzhu9e6ykyl26taccljde405xeulmpv9sym64p7";

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function workspaceDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "cauli-peely-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
  if (createdRunIds.length) {
    await admin
      .from("peely_sync_runs")
      .delete()
      .in("id", createdRunIds.splice(0));
  }
  await admin.from("peely_sync_runs").delete().neq("id", 0);
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

/** A real encrypted backup, produced the way the worker produces one. */
async function storeBackup(sourceAudio: Buffer) {
  const { encryptSourceAudio } = await import("./backup-crypto.js");
  const version = Math.floor(Math.random() * 1_000_000) + 6_000_000;
  const { error: keyError } = await admin.from("backup_key_versions").insert({
    version,
    kms_key_id: "arn:aws:kms:us-east-2:000000000000:key/cauli-backup",
    kms_public_key_sha256: "a".repeat(64),
    age_recipient: ageRecipient,
    age_recipient_sha256: "b".repeat(64),
  });
  if (keyError) throw keyError;
  createdKeyVersions.push(version);

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email: `peely-${crypto.randomUUID()}@example.com`,
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

  const encrypted = encryptSourceAudio(sourceAudio, {
    kmsPublicKeyPem,
    kmsKeyId: "arn:aws:kms:us-east-2:000000000000:key/cauli-backup",
    ageRecipient,
    keyVersion: version,
  });
  const objectName = crypto
    .randomUUID()
    .replaceAll("-", "")
    .concat(crypto.randomUUID().replaceAll("-", ""));

  const { data: claimed } = await admin.rpc("claim_source_audio_backup", {
    worker_name: "peely-fixture",
  });
  await admin.rpc("commit_source_audio_backup", {
    target_call_id: claimed.call_id,
    target_lease_token: claimed.lease_token,
    target_object_name: objectName,
    target_key_version: version,
    target_kms_wrapped_key: encrypted.wrapped.kmsWrappedKey,
    target_age_wrapped_key: encrypted.wrapped.ageWrappedKey,
    target_ciphertext_sha256: encrypted.ciphertextSha256,
    target_ciphertext_bytes: encrypted.ciphertext.length,
  });
  createdObjectNames.push(objectName);
  return { callId, objectName, encrypted };
}

/** A VPS that serves exactly the objects it was given. */
function fakeVps(
  objects: Map<
    string,
    { ciphertext: Buffer; manifest: Buffer; checksum: string }
  >
) {
  return async (url: string | URL | Request) => {
    const objectName = String(url).split("/").pop()!;
    const stored = objects.get(objectName);
    if (!stored) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(stored.ciphertext), {
      status: 200,
      headers: {
        "x-cauli-checksum-sha256": stored.checksum,
        "x-cauli-manifest": stored.manifest.toString("base64"),
        "x-cauli-key-version": "1",
      },
    });
  };
}

describe("the Peely sync agent", () => {
  it("cannot decrypt, create, or delete a VPS backup", async () => {
    const peely = await import("./peely.js");
    expect(
      Object.keys(peely).filter((name) =>
        /decrypt|unwrap|restore|createBackup|deleteBackupObject/i.test(name)
      )
    ).toEqual([]);

    // The module never pulls in the encryption code, so there is nothing for a
    // compromised Peely to reach for.
    const source = await readFile(
      new URL("./peely.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/from "\.\/backup-crypto\.js"/);
    expect(source).not.toMatch(/createBackupObject/);
  });
});

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
)("Peely synchronization", () => {
  it("copies and verifies encrypted objects without any key", async () => {
    const { synchronizePeely, listPeelyContents } = await import("./peely.js");
    const sourceAudio = Buffer.from("the authoritative media for one Call");
    const { callId, objectName, encrypted } = await storeBackup(sourceAudio);
    const directory = await workspaceDirectory();

    const vps = new Map([
      [
        objectName,
        {
          ciphertext: encrypted.ciphertext,
          manifest: encrypted.manifest,
          checksum: encrypted.ciphertextSha256,
        },
      ],
    ]);

    const first = await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: fakeVps(vps),
    });
    expect(first).toMatchObject({ copied: 1, verified: 0, failures: [] });

    // What landed is the ciphertext, under an opaque name, with the encrypted
    // manifest beside it — and nothing that says whose Call it was.
    const contents = await listPeelyContents(directory);
    expect(contents.sort()).toEqual(
      [`${objectName}.backup`, `${objectName}.manifest`].sort()
    );
    const stored = await readFile(join(directory, `${objectName}.backup`));
    expect(sha256(stored)).toBe(encrypted.ciphertextSha256);
    expect(stored.includes(sourceAudio)).toBe(false);
    expect(contents.join(" ")).not.toContain(callId);
    expect(contents.join(" ")).not.toContain(workspaceId);

    // A second run verifies rather than re-downloading.
    const second = await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: async () => {
        throw new Error("should not re-fetch an already verified object");
      },
    });
    expect(second).toMatchObject({ verified: 1, copied: 0, failures: [] });

    const { data: runs } = await admin
      .from("peely_sync_runs")
      .select("objects_verified, objects_copied, failure_reason")
      .order("id");
    expect(runs).toEqual([
      { objects_verified: 0, objects_copied: 1, failure_reason: null },
      { objects_verified: 1, objects_copied: 0, failure_reason: null },
    ]);
  });

  it("refuses an object the VPS returns with the wrong bytes", async () => {
    const { synchronizePeely, listPeelyContents } = await import("./peely.js");
    const { objectName, encrypted } = await storeBackup(
      Buffer.from("original media")
    );
    const directory = await workspaceDirectory();

    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    const result = await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: fakeVps(
        new Map([
          [
            objectName,
            {
              ciphertext: tampered,
              manifest: encrypted.manifest,
              // The VPS even agrees with itself; the database does not.
              checksum: encrypted.ciphertextSha256,
            },
          ],
        ])
      ),
    });

    expect(result.copied).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/does not match its recorded checksum/);
    // Nothing untrusted was written next to the good copies.
    expect(await listPeelyContents(directory)).toEqual([]);

    const { data: runs } = await admin
      .from("peely_sync_runs")
      .select("failure_reason");
    expect(runs?.[0]?.failure_reason).toMatch(/1 object\(s\) failed/);
  });

  it("removes its copy only when a deletion was authorized", async () => {
    const { synchronizePeely, listPeelyContents } = await import("./peely.js");
    const { callId, objectName, encrypted } = await storeBackup(
      Buffer.from("media that will be deleted")
    );
    const directory = await workspaceDirectory();
    const vps = new Map([
      [
        objectName,
        {
          ciphertext: encrypted.ciphertext,
          manifest: encrypted.manifest,
          checksum: encrypted.ciphertextSha256,
        },
      ],
    ]);

    await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: fakeVps(vps),
    });
    expect(await listPeelyContents(directory)).toHaveLength(2);

    // The object vanishes from the VPS with no authorization behind it — a
    // host-root compromise, or an accident. Peely must not follow.
    vps.delete(objectName);
    const unauthorized = await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: fakeVps(vps),
    });
    expect(unauthorized.removed).toBe(0);
    expect(await listPeelyContents(directory)).toHaveLength(2);

    // Now the application authorizes the deletion, and only now does the
    // offline copy go.
    await admin.rpc("begin_call_deletion", {
      target_call_id: callId,
      target_actor_id: null,
      target_reason: "retention",
    });
    const authorized = await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: fakeVps(vps),
    });
    expect(authorized.removed).toBe(1);
    expect(await listPeelyContents(directory)).toEqual([]);

    // The authorization outlives the copy it removed, so it is still listed on
    // the next run. That must not be counted as removing anything again.
    const settled = await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: fakeVps(vps),
    });
    expect(settled.removed).toBe(0);
  });

  it("emails the operator after 48 hours without a successful sync", async () => {
    const { alertOnStalePeelySync } = await import("./peely.js");
    const alerts: { subject: string; body: string }[] = [];
    const sendOperatorEmail = async (alert: {
      subject: string;
      body: string;
    }) => {
      alerts.push(alert);
    };

    // Never having synchronized is the same problem as having stopped.
    expect(
      await alertOnStalePeelySync({ client: admin, sendOperatorEmail })
    ).toBe(true);
    expect(alerts[0]?.body).toMatch(/never completed a successful/);

    const { data: staleRun } = await admin
      .from("peely_sync_runs")
      .insert({
        completed_at: new Date(Date.now() - 60 * 3_600_000).toISOString(),
        objects_verified: 1,
      })
      .select("id")
      .single();
    createdRunIds.push(staleRun!.id);
    alerts.length = 0;
    expect(
      await alertOnStalePeelySync({ client: admin, sendOperatorEmail })
    ).toBe(true);
    expect(alerts[0]?.body).toMatch(/60 hours ago, past the 48-hour threshold/);
    // The alert says how stale, never what is missing or whose it was.
    expect(JSON.stringify(alerts[0])).not.toMatch(/call|workspace|owner/i);

    // A failed run is not a sync, so it does not reset the clock.
    const { data: failedRun } = await admin
      .from("peely_sync_runs")
      .insert({
        completed_at: new Date().toISOString(),
        failure_reason: "1 object(s) failed",
      })
      .select("id")
      .single();
    createdRunIds.push(failedRun!.id);
    alerts.length = 0;
    expect(
      await alertOnStalePeelySync({ client: admin, sendOperatorEmail })
    ).toBe(true);

    const { data: freshRun } = await admin
      .from("peely_sync_runs")
      .insert({ completed_at: new Date().toISOString(), objects_verified: 1 })
      .select("id")
      .single();
    createdRunIds.push(freshRun!.id);
    alerts.length = 0;
    expect(
      await alertOnStalePeelySync({ client: admin, sendOperatorEmail })
    ).toBe(false);
    expect(alerts).toEqual([]);
  });

  it("confines the Peely principal to names and digests", async () => {
    const { data: privileges, error } = await admin.rpc(
      "peely_principal_privileges"
    );
    if (error) throw error;
    const granted = new Map(
      (privileges as { object_name: string; granted: boolean }[]).map(
        (privilege) => [privilege.object_name, privilege.granted]
      )
    );

    for (const forbidden of [
      "public.calls",
      "public.transcripts",
      "public.source_audio_backups",
      "public.backup_deletion_requests",
      "public.commit_source_audio_backup",
      "public.commit_backup_deletion",
      "public.begin_call_deletion",
    ]) {
      expect(granted.get(forbidden), forbidden).toBe(false);
    }
    for (const allowed of [
      "public.list_backup_objects_for_sync",
      "public.list_authorized_backup_deletions",
      "public.record_peely_sync",
    ]) {
      expect(granted.get(allowed), allowed).toBe(true);
    }

    // What it may read carries no wrapped key and no way back to a Call.
    const { objectName } = await storeBackup(Buffer.from("media"));
    const { data: listed } = await admin.rpc("list_backup_objects_for_sync");
    const entry = (listed as Record<string, unknown>[]).find(
      (row) => row.object_name === objectName
    );
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "ciphertext_sha256",
      "object_name",
    ]);
  });

  it("restores Source Audio from the Peely copy only after it verifies", async () => {
    const { synchronizePeely } = await import("./peely.js");
    const { restoreSourceAudio } = await import("./backup-crypto.js");
    const { privateDecrypt, constants } = await import("node:crypto");

    const sourceAudio = Buffer.from(
      "the authoritative media a four-hour recovery has to produce"
    );
    const { objectName, encrypted } = await storeBackup(sourceAudio);
    const directory = await workspaceDirectory();
    await synchronizePeely({
      directory,
      target,
      client: admin,
      fetch: fakeVps(
        new Map([
          [
            objectName,
            {
              ciphertext: encrypted.ciphertext,
              manifest: encrypted.manifest,
              checksum: encrypted.ciphertextSha256,
            },
          ],
        ])
      ),
    });

    // Recovery reads the offline copy and the key comes from KMS, which Peely
    // has no access to — the two failure domains meeting only at restore time.
    const { data: wrapped } = await admin
      .from("source_audio_backups")
      .select("kms_wrapped_key, ciphertext_sha256")
      .eq("object_name", objectName)
      .single();
    const dataKey = privateDecrypt(
      {
        key: kms.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(wrapped!.kms_wrapped_key, "base64")
    );

    const ciphertext = await readFile(join(directory, `${objectName}.backup`));
    const manifest = await readFile(join(directory, `${objectName}.manifest`));
    const restored = restoreSourceAudio({
      ciphertext,
      manifest,
      ciphertextSha256: wrapped!.ciphertext_sha256,
      dataKey,
    });
    expect(restored.sourceAudio.equals(sourceAudio)).toBe(true);
    expect(restored.manifest.plaintextBytes).toBe(sourceAudio.length);

    // A copy that has rotted on the drive is rejected rather than accepted as
    // the authoritative media.
    await writeFile(
      join(directory, `${objectName}.backup`),
      Buffer.concat([ciphertext.subarray(0, 1), ciphertext.subarray(1)]).fill(
        0,
        0,
        1
      )
    );
    const rotted = await readFile(join(directory, `${objectName}.backup`));
    expect(() =>
      restoreSourceAudio({
        ciphertext: rotted,
        manifest,
        ciphertextSha256: wrapped!.ciphertext_sha256,
        dataKey,
      })
    ).toThrow(/checksum does not match/);
  });
});
