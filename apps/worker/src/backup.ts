import {
  encryptSourceAudio,
  opaqueObjectName,
  type BackupRecipients,
} from "./backup-crypto.js";
import {
  createBackupObject,
  RetryableBackupError,
  type BackupTargetConfig,
} from "./backup-target.js";
import { config } from "./config.js";
import { log, sanitizedError } from "./log.js";
import { supabase } from "./supabase.js";

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
}

export interface BackupDependencies {
  downloadSourceAudio: (storagePath: string) => Promise<Buffer>;
  target: BackupTargetConfig;
  recipients: BackupRecipients;
  fetch?: typeof fetch;
}

export async function loadActiveBackupRecipients(): Promise<BackupRecipients | null> {
  const { data, error } = await supabase
    .from("backup_key_versions")
    .select("version, kms_key_id, age_recipient")
    .is("retired_at", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const kmsPublicKeyPem = process.env.BACKUP_KMS_PUBLIC_KEY?.trim();
  if (!kmsPublicKeyPem) return null;
  return {
    kmsPublicKeyPem,
    kmsKeyId: data.kms_key_id,
    ageRecipient: data.age_recipient,
    keyVersion: data.version,
  };
}

async function claimBackup(): Promise<BackupRow | null> {
  const { data, error } = await supabase.rpc("claim_source_audio_backup", {
    worker_name: config.workerName,
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
  const claimed = await claimBackup();
  if (!claimed) return false;

  try {
    const { data: call, error: callError } = await supabase
      .from("calls")
      .select("source_path, mime_type")
      .eq("id", claimed.call_id)
      .maybeSingle();
    if (callError) throw callError;
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
    const objectName = opaqueObjectName();

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
      { fetch: dependencies.fetch }
    );

    const { data: committed, error: commitError } = await supabase.rpc(
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
    const { error: failError } = await supabase.rpc(
      "fail_source_audio_backup",
      {
        target_call_id: claimed.call_id,
        target_lease_token: claimed.lease_token,
        target_reason: sanitizedError(error),
        target_retryable: retryable,
      }
    );
    if (failError) throw failError;
    log.error("source_audio_backup_failed", {
      retryable,
      error: sanitizedError(error),
    });
    return true;
  }
}

/** Content-free lag evidence for the operator alert. */
export async function reportBackupLag() {
  const { data, error } = await supabase.rpc("source_audio_backup_lag_alert");
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
