import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSourceAudio, type BackupRecipients } from "./backup-crypto.js";
import {
  createBackupObject,
  RetryableBackupError,
  type BackupTargetConfig,
} from "./backup-target.js";
import { log, sanitizedError } from "./log.js";

/**
 * Copies one Call's Source Audio to the independent VPS, encrypted before it
 * leaves this process.
 *
 * This runs on its own cadence rather than inside the processing job, so a slow
 * or unreachable backup target delays only the recovery copy — never the Call
 * reaching Ready.
 */

interface BackupRow {
  call_id: string;
  workspace_id: string;
  attempts: number;
  lease_token: string;
  queued_at: string;
  /** Reserved by the claim, so the name exists before any byte is sent. */
  object_name: string;
}

export interface BackupDependencies {
  client: SupabaseClient;
  workerName: string;
  downloadSourceAudio: (storagePath: string) => Promise<Buffer>;
  target: BackupTargetConfig;
  recipients: BackupRecipients;
  fetch?: typeof fetch;
}

export async function loadActiveBackupRecipients(
  client: SupabaseClient,
  kmsPublicKeyPem: string
): Promise<BackupRecipients | null> {
  const { data, error } = await client.rpc("active_backup_recipients");
  if (error) throw error;
  const recipient = (
    data as {
      version: number;
      kms_key_id: string;
      age_recipient: string;
      kms_public_key_sha256: string;
    }[]
  )?.[0];
  if (!recipient) return null;

  // The key version says which public key it means, and the worker's
  // environment says which one it holds. If a rotation moves one before the
  // other, wrapping under the old key while labelling it the new one would
  // quietly destroy the KMS recovery path for everything backed up in the gap.
  // The digest is recorded for exactly this comparison, so make it.
  const actualDigest = createHash("sha256")
    .update(normalizePem(kmsPublicKeyPem))
    .digest("hex");
  if (actualDigest !== recipient.kms_public_key_sha256) {
    throw new Error(
      `The configured KMS public key does not match backup key version ${recipient.version}`
    );
  }

  return {
    kmsPublicKeyPem,
    kmsKeyId: recipient.kms_key_id,
    ageRecipient: recipient.age_recipient,
    keyVersion: recipient.version,
  };
}

/** Digest the key itself, so whitespace and line endings cannot change it. */
export function normalizePem(pem: string) {
  return pem.replace(/\s+/g, "");
}

async function claimBackup(
  client: SupabaseClient,
  workerName: string
): Promise<BackupRow | null> {
  const { data, error } = await client.rpc("claim_source_audio_backup", {
    worker_name: workerName,
  });
  if (error) throw error;
  const claimed = data as BackupRow | null;
  return claimed?.call_id ? claimed : null;
}

/**
 * Runs one backup if one is waiting. Returns whether it found work, so the
 * caller can back off when the queue is empty.
 */
export async function backUpOneSourceAudio(
  dependencies: BackupDependencies
): Promise<boolean> {
  const { client } = dependencies;
  const claimed = await claimBackup(client, dependencies.workerName);
  if (!claimed) return false;

  try {
    const { data: sourceRows, error: callError } = await client.rpc(
      "claimed_source_audio_backup_source",
      {
        target_call_id: claimed.call_id,
        target_lease_token: claimed.lease_token,
      }
    );
    if (callError) throw callError;
    const call = (
      sourceRows as { source_path: string; mime_type: string }[]
    )?.[0];
    if (!call?.source_path) {
      throw new RetryableBackupError(
        "Source Audio is not available for backup yet"
      );
    }

    const sourceAudio = await dependencies.downloadSourceAudio(
      call.source_path
    );
    const encrypted = encryptSourceAudio(
      sourceAudio,
      dependencies.recipients,
      call.mime_type
    );
    const objectName = claimed.object_name;

    const { data: authorizedUntil, error: authorizationError } =
      await client.rpc("authorize_source_audio_backup_upload", {
        target_call_id: claimed.call_id,
        target_lease_token: claimed.lease_token,
        target_object_name: objectName,
      });
    if (authorizationError) throw authorizationError;
    const remainingUploadMilliseconds =
      new Date(String(authorizedUntil ?? "")).getTime() - Date.now();
    if (
      !authorizedUntil ||
      !Number.isFinite(remainingUploadMilliseconds) ||
      remainingUploadMilliseconds <= 0
    ) {
      log.info("source_audio_backup_cancelled_by_deletion", {});
      return true;
    }
    // The database lets retention proceed after this bounded window. Start the
    // clock at authorization so a paused process cannot wake after a 404
    // deletion and begin a fresh, late PUT.
    const uploadSignal = AbortSignal.timeout(remainingUploadMilliseconds);

    try {
      await createBackupObject(
        dependencies.target,
        {
          objectName,
          ciphertext: encrypted.ciphertext,
          manifest: encrypted.manifest,
          kmsWrappedKey: encrypted.wrapped.kmsWrappedKey,
          ageWrappedKey: encrypted.wrapped.ageWrappedKey,
          keyVersion: encrypted.wrapped.keyVersion,
          ciphertextSha256: encrypted.ciphertextSha256,
        },
        { fetch: dependencies.fetch, signal: uploadSignal }
      );
    } finally {
      const { error: finishError } = await client.rpc(
        "finish_source_audio_backup_upload",
        {
          target_call_id: claimed.call_id,
          target_lease_token: claimed.lease_token,
          target_object_name: objectName,
        }
      );
      if (finishError) throw finishError;
    }

    const { data: committed, error: commitError } = await client.rpc(
      "commit_source_audio_backup",
      {
        target_call_id: claimed.call_id,
        target_lease_token: claimed.lease_token,
        target_object_name: objectName,
        target_key_version: encrypted.wrapped.keyVersion,
        target_kms_wrapped_key: encrypted.wrapped.kmsWrappedKey,
        target_age_wrapped_key: encrypted.wrapped.ageWrappedKey,
        target_ciphertext_sha256: encrypted.ciphertextSha256,
        target_ciphertext_bytes: encrypted.ciphertext.length,
      }
    );
    if (commitError) throw commitError;
    if (!committed) {
      throw new Error("The Source Audio Backup lease was lost before commit");
    }

    log.info("source_audio_backup_stored", {
      lagSeconds: Math.round(
        (Date.now() - new Date(claimed.queued_at).getTime()) / 1_000
      ),
      keyVersion: encrypted.wrapped.keyVersion,
    });
    return true;
  } catch (error) {
    // Backup retries until it succeeds or the Call is deleted. Only a refusal
    // that retrying cannot fix stops the attempts.
    const retryable =
      error instanceof RetryableBackupError ||
      !(error instanceof Error) ||
      !/refused the copy|already occupies|only public wrapping/.test(
        error.message
      );
    const { error: failError } = await client.rpc("fail_source_audio_backup", {
      target_call_id: claimed.call_id,
      target_lease_token: claimed.lease_token,
      target_reason: sanitizedError(error),
      target_retryable: retryable,
    });
    if (failError) throw failError;
    log.error("source_audio_backup_failed", {
      retryable,
      error: sanitizedError(error),
    });
    return true;
  }
}

/** Content-free lag evidence for the operator alert. */
export async function reportBackupLag(client: SupabaseClient) {
  const { data, error } = await client.rpc("source_audio_backup_lag_alert");
  if (error) throw error;
  const summary = (
    data as { lagging: number; worst_lag_seconds: number }[]
  )?.[0];
  if (summary && summary.lagging > 0) {
    log.error("source_audio_backup_lagging", {
      lagging: summary.lagging,
      worstLagSeconds: summary.worst_lag_seconds,
    });
  }
  return summary ?? { lagging: 0, worst_lag_seconds: 0 };
}
