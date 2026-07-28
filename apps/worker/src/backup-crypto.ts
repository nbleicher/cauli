import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
  constants,
  type KeyObject,
} from "node:crypto";

/**
 * Source Audio leaves the worker already encrypted, and the key that opens it
 * leaves wrapped twice — once to a managed KMS key and once to an offline age
 * recipient. The worker holds only the public half of each, so the process that
 * writes a backup cannot read one back. Recovery is deliberately somewhere
 * else: an audited KMS decrypt, or the sealed offline identity.
 */

const DATA_KEY_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface BackupRecipients {
  /** PEM SPKI for the AWS KMS RSA-4096 key. Public half only. */
  kmsPublicKeyPem: string;
  /** The KMS key identifier recorded as evidence. Never a credential. */
  kmsKeyId: string;
  /** A standard `age1...` X25519 recipient. */
  ageRecipient: string;
  /** Which wrapping generation produced these. */
  keyVersion: number;
}

export interface WrappedDataKey {
  keyVersion: number;
  /** RSA-OAEP-SHA256 under the KMS public key, base64. */
  kmsWrappedKey: string;
  /** A complete standard age file containing the data key, base64. */
  ageWrappedKey: string;
}

export interface EncryptedSourceAudio {
  ciphertext: Buffer;
  /** Opaque manifest, itself encrypted under the same data key. */
  manifest: Buffer;
  /** SHA-256 of `ciphertext`, the checksum both backup targets verify. */
  ciphertextSha256: string;
  wrapped: WrappedDataKey;
}

/** Facts a restore needs that must not identify a Workspace, Call, or person. */
export interface BackupManifest {
  version: 1;
  iv: string;
  authTag: string;
  plaintextSha256: string;
  plaintextBytes: number;
  contentType: string;
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// age X25519 recipients, standard format
// ---------------------------------------------------------------------------

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const AGE_FILE_KEY_BYTES = 16;
const AGE_CHUNK_BYTES = 64 * 1024;

function bech32Polymod(values: number[]) {
  const generator = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) {
      if ((top >> bit) & 1) checksum ^= generator[bit]!;
    }
  }
  return checksum;
}

function bech32Verify(prefix: string, data: number[]) {
  const expanded = [
    ...[...prefix].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...prefix].map((character) => character.charCodeAt(0) & 31),
  ];
  return bech32Polymod([...expanded, ...data]) === 1;
}

/** Decodes an `age1...` recipient to its raw 32-byte X25519 public key. */
export function decodeAgeRecipient(recipient: string) {
  const separator = recipient.lastIndexOf("1");
  if (separator < 1) throw new Error("Malformed age recipient");
  const prefix = recipient.slice(0, separator);
  if (prefix !== "age") throw new Error("Malformed age recipient");

  const data = [...recipient.slice(separator + 1)].map((character) => {
    const value = BECH32_ALPHABET.indexOf(character);
    if (value < 0) throw new Error("Malformed age recipient");
    return value;
  });
  if (!bech32Verify(prefix, data)) {
    throw new Error("Malformed age recipient");
  }

  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const value of data.slice(0, -6)) {
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  if (bytes.length !== 32) throw new Error("Malformed age recipient");
  return Buffer.from(bytes);
}

function x25519PublicKey(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function base64Unpadded(value: Buffer) {
  return value.toString("base64").replaceAll("=", "");
}

function chunkNonce(counter: number, final: boolean) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(counter, 7);
  nonce[11] = final ? 1 : 0;
  return nonce;
}

/**
 * Produces a complete age file encrypted to one X25519 recipient. The payload
 * here is only a data key, so it is always a single STREAM chunk — but the
 * framing is the real one, so the official `age` binary and the sealed offline
 * identity can open it without Cauli's code.
 */
export function encryptToAgeRecipient(recipient: string, plaintext: Buffer) {
  const recipientKey = decodeAgeRecipient(recipient);
  const fileKey = randomBytes(AGE_FILE_KEY_BYTES);

  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublic = ephemeral.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(X25519_SPKI_PREFIX.length);
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: x25519PublicKey(recipientKey),
  });
  if (shared.every((byte) => byte === 0)) {
    throw new Error(
      "Refusing an age recipient with a degenerate shared secret"
    );
  }

  const wrapKey = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([ephemeralPublic, recipientKey]),
      Buffer.from("age-encryption.org/v1/X25519"),
      32
    )
  );
  const stanzaCipher = createCipheriv(
    "chacha20-poly1305",
    wrapKey,
    Buffer.alloc(12),
    {
      authTagLength: 16,
    }
  );
  const stanzaBody = Buffer.concat([
    stanzaCipher.update(fileKey),
    stanzaCipher.final(),
    stanzaCipher.getAuthTag(),
  ]);

  const headerWithoutMac =
    "age-encryption.org/v1\n" +
    `-> X25519 ${base64Unpadded(ephemeralPublic)}\n` +
    `${base64Unpadded(stanzaBody)}\n` +
    "---";
  const macKey = Buffer.from(
    hkdfSync("sha256", fileKey, Buffer.alloc(0), Buffer.from("header"), 32)
  );
  const headerMac = createHmac("sha256", macKey)
    .update(headerWithoutMac)
    .digest();

  const payloadNonce = randomBytes(16);
  const payloadKey = Buffer.from(
    hkdfSync("sha256", fileKey, payloadNonce, Buffer.from("payload"), 32)
  );
  if (plaintext.length > AGE_CHUNK_BYTES) {
    throw new Error("age wrapping is only used for single-chunk key material");
  }
  const payloadCipher = createCipheriv(
    "chacha20-poly1305",
    payloadKey,
    chunkNonce(0, true),
    { authTagLength: 16 }
  );
  const payload = Buffer.concat([
    payloadCipher.update(plaintext),
    payloadCipher.final(),
    payloadCipher.getAuthTag(),
  ]);

  return Buffer.concat([
    Buffer.from(`${headerWithoutMac} ${base64Unpadded(headerMac)}\n`),
    payloadNonce,
    payload,
  ]);
}

// ---------------------------------------------------------------------------
// Envelope encryption
// ---------------------------------------------------------------------------

/**
 * Wraps one data key to both recipients. Every wrap is a public-key operation,
 * so nothing here can undo it.
 */
export function wrapDataKey(
  dataKey: Buffer,
  recipients: BackupRecipients
): WrappedDataKey {
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new Error("A Source Audio Backup data key must be 256 bits");
  }
  if (/PRIVATE KEY/.test(recipients.kmsPublicKeyPem)) {
    throw new Error("The worker must hold only public wrapping material");
  }

  const kmsWrappedKey = publicEncrypt(
    {
      key: recipients.kmsPublicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    dataKey
  ).toString("base64");

  return {
    keyVersion: recipients.keyVersion,
    kmsWrappedKey,
    ageWrappedKey: encryptToAgeRecipient(
      recipients.ageRecipient,
      dataKey
    ).toString("base64"),
  };
}

/**
 * Encrypts one Call's Source Audio under a data key generated for it alone.
 * The manifest travels encrypted under the same key, so neither backup target
 * learns anything about the recording it is holding.
 */
export function encryptSourceAudio(
  sourceAudio: Buffer,
  recipients: BackupRecipients,
  contentType = "audio/webm"
): EncryptedSourceAudio {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(sourceAudio),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const manifest: BackupManifest = {
    version: 1,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    plaintextSha256: sha256(sourceAudio),
    plaintextBytes: sourceAudio.length,
    contentType,
  };
  const manifestIv = randomBytes(GCM_IV_BYTES);
  const manifestCipher = createCipheriv("aes-256-gcm", dataKey, manifestIv, {
    authTagLength: GCM_TAG_BYTES,
  });
  const manifestBody = Buffer.concat([
    manifestCipher.update(Buffer.from(JSON.stringify(manifest), "utf8")),
    manifestCipher.final(),
  ]);

  return {
    ciphertext,
    manifest: Buffer.concat([
      manifestIv,
      manifestCipher.getAuthTag(),
      manifestBody,
    ]),
    ciphertextSha256: sha256(ciphertext),
    wrapped: wrapDataKey(dataKey, recipients),
  };
}

/**
 * An opaque backup object name. It is drawn at random rather than derived from
 * the Call, so neither backup target's directory listing reveals which
 * Workspace or Call it holds, or even how many either has.
 */
export function opaqueObjectName() {
  return randomBytes(32).toString("hex");
}

export interface RestoreInput {
  ciphertext: Buffer;
  manifest: Buffer;
  ciphertextSha256: string;
  /** Recovered out of band through KMS or the offline age identity. */
  dataKey: Buffer;
}

/**
 * Verifies a backup before anything is allowed to use it. The checksum, the
 * manifest's own authentication tag, and the payload's authentication tag must
 * all hold; any one of them failing rejects the whole restore rather than
 * returning partially trusted bytes.
 */
export function restoreSourceAudio(input: RestoreInput) {
  const actualChecksum = sha256(input.ciphertext);
  const expected = Buffer.from(input.ciphertextSha256, "hex");
  const actual = Buffer.from(actualChecksum, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Source Audio Backup checksum does not match");
  }

  let manifest: BackupManifest;
  try {
    const manifestIv = input.manifest.subarray(0, GCM_IV_BYTES);
    const manifestTag = input.manifest.subarray(
      GCM_IV_BYTES,
      GCM_IV_BYTES + GCM_TAG_BYTES
    );
    const manifestBody = input.manifest.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
    const manifestDecipher = createDecipheriv(
      "aes-256-gcm",
      input.dataKey,
      manifestIv,
      { authTagLength: GCM_TAG_BYTES }
    );
    manifestDecipher.setAuthTag(manifestTag);
    manifest = JSON.parse(
      Buffer.concat([
        manifestDecipher.update(manifestBody),
        manifestDecipher.final(),
      ]).toString("utf8")
    ) as BackupManifest;
  } catch {
    throw new Error("Source Audio Backup manifest failed authentication");
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      input.dataKey,
      Buffer.from(manifest.iv, "base64"),
      { authTagLength: GCM_TAG_BYTES }
    );
    decipher.setAuthTag(Buffer.from(manifest.authTag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(input.ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new Error("Source Audio Backup failed authentication");
  }

  if (sha256(plaintext) !== manifest.plaintextSha256) {
    throw new Error("Restored Source Audio does not match its manifest");
  }
  return { sourceAudio: plaintext, manifest };
}
