import { describe, expect, it } from "vitest";
import * as backupTarget from "./backup-target.js";
import {
  backupTargetFromEnvironment,
  createBackupObject,
  readBackupObject,
  RetryableBackupError,
  type BackupObject,
  type BackupTargetConfig,
} from "./backup-target.js";

const config: BackupTargetConfig = {
  baseUrl: "https://backup.example.test",
  clientCertificatePem:
    "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
  clientKeyPem:
    "-----BEGIN PRIVATE KEY-----\nworker\n-----END PRIVATE KEY-----",
  certificateAuthorityPem:
    "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
};

const objectName = "a".repeat(64);
const ciphertext = Buffer.from("encrypted Source Audio");

const object: BackupObject = {
  objectName,
  ciphertext,
  manifest: Buffer.from("encrypted manifest"),
  kmsWrappedKey: "kms-wrapped",
  ageWrappedKey: "age-wrapped",
  keyVersion: 2,
  ciphertextSha256: "b".repeat(64),
};

describe("the Source Audio Backup receiver", () => {
  it("creates an opaque object without ever offering to replace one", async () => {
    let request: { url: string; init?: RequestInit } | null = null;
    const result = await createBackupObject(config, object, {
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return new Response(null, { status: 201 });
      },
    });

    expect(result.created).toBe(true);
    expect(request!.url).toBe(
      `https://backup.example.test/objects/${objectName}`
    );
    expect(request!.init?.method).toBe("PUT");

    const headers = new Headers(request!.init?.headers);
    // Create-only intake is asserted by the request itself, not just trusted
    // of the receiver.
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("x-cauli-checksum-sha256")).toBe(
      object.ciphertextSha256
    );
    expect(headers.get("x-cauli-key-version")).toBe("2");
    expect(headers.get("x-cauli-manifest")).toBe(
      object.manifest.toString("base64")
    );

    // Nothing about the Workspace, the Call, or the recording is in the path
    // or the headers.
    expect(JSON.stringify([request!.url, [...headers]])).not.toMatch(
      /workspace|call|title|owner|audio/i
    );
  });

  it("gives the application credential no way to overwrite or delete", () => {
    // The verbs simply do not exist on this module, so a compromised worker
    // cannot erase the recovery copy even by calling everything it has.
    expect(
      Object.keys(backupTarget).filter((name) =>
        /delete|remove|overwrite|replace|purge/i.test(name)
      )
    ).toEqual([]);
  });

  it("converges when a retry finds its own copy already stored", async () => {
    const result = await createBackupObject(config, object, {
      fetch: async () =>
        new Response(null, {
          status: 412,
          headers: { "x-cauli-checksum-sha256": object.ciphertextSha256 },
        }),
    });
    // Already stored, same bytes: the work is done, not failed.
    expect(result.created).toBe(false);
  });

  it("refuses to accept a name already holding different bytes", async () => {
    await expect(
      createBackupObject(config, object, {
        fetch: async () =>
          new Response(null, {
            status: 412,
            headers: { "x-cauli-checksum-sha256": "c".repeat(64) },
          }),
      })
    ).rejects.toThrow(/already occupies this object name/);
  });

  it("keeps a full target or an unavailable receiver retryable", async () => {
    for (const status of [507, 429, 500, 503]) {
      await expect(
        createBackupObject(config, object, {
          fetch: async () => new Response(null, { status }),
        })
      ).rejects.toBeInstanceOf(RetryableBackupError);
    }

    // A refusal that retrying cannot fix must not be retried forever.
    await expect(
      createBackupObject(config, object, {
        fetch: async () => new Response(null, { status: 403 }),
      })
    ).rejects.toThrow(/refused the copy \(403\)/);
  });

  it("insists on mutual TLS and opaque names", async () => {
    const send = (overrides: Partial<BackupTargetConfig>) =>
      createBackupObject({ ...config, ...overrides }, object, {
        fetch: async () => new Response(null, { status: 201 }),
      });

    await expect(
      send({ baseUrl: "http://backup.example.test" })
    ).rejects.toThrow(/requires HTTPS/);
    await expect(send({ clientCertificatePem: "" })).rejects.toThrow(
      /client certificate/
    );
    await expect(send({ certificateAuthorityPem: "" })).rejects.toThrow(
      /pinned CA/
    );

    await expect(
      createBackupObject(
        config,
        { ...object, objectName: `${"00000000-0000-0000-0000-000000000001"}` },
        { fetch: async () => new Response(null, { status: 201 }) }
      )
    ).rejects.toThrow(/opaque 256-bit identifiers/);
  });

  it("reads a stored copy back with the material a restore has to verify", async () => {
    const restored = await readBackupObject(config, objectName, {
      fetch: async () =>
        new Response(new Uint8Array(ciphertext), {
          status: 200,
          headers: {
            "x-cauli-checksum-sha256": object.ciphertextSha256,
            "x-cauli-manifest": object.manifest.toString("base64"),
            "x-cauli-wrapped-kms": object.kmsWrappedKey,
            "x-cauli-wrapped-age": object.ageWrappedKey,
            "x-cauli-key-version": "2",
          },
        }),
    });

    expect(restored.ciphertext.equals(ciphertext)).toBe(true);
    expect(restored.manifest.equals(object.manifest)).toBe(true);
    expect(restored.keyVersion).toBe(2);

    await expect(
      readBackupObject(config, objectName, {
        fetch: async () =>
          new Response(new Uint8Array(ciphertext), { status: 200 }),
      })
    ).rejects.toThrow(/missing its manifest/);
  });

  it("treats an incompletely configured target as absent rather than partial", () => {
    expect(backupTargetFromEnvironment({})).toBeNull();
    expect(
      backupTargetFromEnvironment({
        BACKUP_VPS_URL: config.baseUrl,
        BACKUP_VPS_CLIENT_CERT: config.clientCertificatePem,
      })
    ).toBeNull();
    expect(
      backupTargetFromEnvironment({
        BACKUP_VPS_URL: config.baseUrl,
        BACKUP_VPS_CLIENT_CERT: config.clientCertificatePem,
        BACKUP_VPS_CLIENT_KEY: config.clientKeyPem,
        BACKUP_VPS_CA_CERT: config.certificateAuthorityPem,
      })
    ).toEqual(config);
  });
});
