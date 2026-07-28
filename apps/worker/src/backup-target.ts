/**
 * The narrow mTLS receiver on the shared Netcup VPS. The credential this module
 * carries can create an object and read one back for verification. It cannot
 * overwrite and cannot delete — those verbs are not expressed here at all, and
 * the receiver refuses them for this client certificate besides. Deletion
 * belongs to the separate retention principal.
 */

import { mutualTlsFetch } from "./mutual-tls.js";

export interface BackupTargetConfig {
  /** `https://…` receiver endpoint. Plain HTTP is refused. */
  baseUrl: string;
  clientCertificatePem: string;
  clientKeyPem: string;
  /** The receiver's own CA, so the worker will not talk to an impostor. */
  certificateAuthorityPem: string;
}

export interface BackupObject {
  objectName: string;
  ciphertext: Buffer;
  manifest: Buffer;
  kmsWrappedKey: string;
  ageWrappedKey: string;
  keyVersion: number;
  ciphertextSha256: string;
}

export interface BackupTargetOptions {
  fetch?: typeof fetch;
}

/** Raised when the copy has not landed but retrying later can still succeed. */
export class RetryableBackupError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "RetryableBackupError";
  }
}

export function backupTargetFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): BackupTargetConfig | null {
  const baseUrl = environment.BACKUP_VPS_URL?.trim();
  const clientCertificatePem = environment.BACKUP_VPS_CLIENT_CERT?.trim();
  const clientKeyPem = environment.BACKUP_VPS_CLIENT_KEY?.trim();
  const certificateAuthorityPem = environment.BACKUP_VPS_CA_CERT?.trim();
  if (
    !baseUrl ||
    !clientCertificatePem ||
    !clientKeyPem ||
    !certificateAuthorityPem
  ) {
    return null;
  }
  return {
    baseUrl,
    clientCertificatePem,
    clientKeyPem,
    certificateAuthorityPem,
  };
}

function assertMutualTls(config: BackupTargetConfig) {
  if (!config.baseUrl.startsWith("https://")) {
    throw new Error("The Source Audio Backup receiver requires HTTPS");
  }
  if (!config.clientCertificatePem || !config.clientKeyPem) {
    throw new Error(
      "The Source Audio Backup receiver requires a client certificate"
    );
  }
  if (!config.certificateAuthorityPem) {
    throw new Error("The Source Audio Backup receiver requires a pinned CA");
  }
}

function objectUrl(config: BackupTargetConfig, objectName: string) {
  if (!/^[0-9a-f]{64}$/.test(objectName)) {
    throw new Error("Backup object names must be opaque 256-bit identifiers");
  }
  return `${config.baseUrl.replace(/\/$/, "")}/objects/${objectName}`;
}

/**
 * Every request presents the client certificate and pins the receiver's CA. The
 * transport is `node:https` rather than the global `fetch`, which silently
 * ignores TLS material it is not given as an undici dispatcher.
 */
function transport(config: BackupTargetConfig, options: BackupTargetOptions) {
  return options.fetch ?? mutualTlsFetch(config);
}

/**
 * Create-only intake. `If-None-Match: *` makes the receiver's immutability the
 * transport's contract too: a second create for a name that already exists is
 * refused rather than silently replacing a good copy with a bad one.
 */
export async function createBackupObject(
  config: BackupTargetConfig,
  object: BackupObject,
  options: BackupTargetOptions = {}
) {
  assertMutualTls(config);
  const response = await transport(config, options)(
    objectUrl(config, object.objectName),
    {
      method: "PUT",
      headers: {
        "if-none-match": "*",
        "content-type": "application/octet-stream",
        "content-length": String(object.ciphertext.length),
        "x-cauli-checksum-sha256": object.ciphertextSha256,
        "x-cauli-key-version": String(object.keyVersion),
        "x-cauli-manifest": object.manifest.toString("base64"),
        "x-cauli-wrapped-kms": object.kmsWrappedKey,
        "x-cauli-wrapped-age": object.ageWrappedKey,
      },
      body: new Uint8Array(object.ciphertext),
    }
  );

  if (response.status === 201) return { created: true as const };

  // The copy is already there. If it is the same bytes this attempt would have
  // written, the retry has converged and must not be treated as a failure.
  if (response.status === 412 || response.status === 409) {
    const existing = response.headers.get("x-cauli-checksum-sha256");
    if (existing === object.ciphertextSha256) {
      return { created: false as const };
    }
    throw new Error(
      "A different Source Audio Backup already occupies this object name"
    );
  }

  if (response.status === 507) {
    throw new RetryableBackupError(
      "The Source Audio Backup target is at its capacity ceiling"
    );
  }
  if (response.status >= 500 || response.status === 429) {
    throw new RetryableBackupError(
      `The Source Audio Backup receiver is unavailable (${response.status})`
    );
  }
  throw new Error(
    `The Source Audio Backup receiver refused the copy (${response.status})`
  );
}

/** Reads a stored copy back so a restore can verify it before trusting it. */
export async function readBackupObject(
  config: BackupTargetConfig,
  objectName: string,
  options: BackupTargetOptions = {}
) {
  assertMutualTls(config);
  const response = await transport(config, options)(
    objectUrl(config, objectName),
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    throw new Error(
      `The Source Audio Backup could not be read back (${response.status})`
    );
  }
  const manifest = response.headers.get("x-cauli-manifest");
  const ciphertextSha256 = response.headers.get("x-cauli-checksum-sha256");
  if (!manifest || !ciphertextSha256) {
    throw new Error("The Source Audio Backup is missing its manifest");
  }
  return {
    ciphertext: Buffer.from(await response.arrayBuffer()),
    manifest: Buffer.from(manifest, "base64"),
    ciphertextSha256,
    kmsWrappedKey: response.headers.get("x-cauli-wrapped-kms") ?? "",
    ageWrappedKey: response.headers.get("x-cauli-wrapped-age") ?? "",
    keyVersion: Number(response.headers.get("x-cauli-key-version") ?? 0),
  };
}
