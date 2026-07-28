import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Agent } from "node:https";
import { config } from "./config.js";
import { log, sanitizedError } from "./log.js";
import { supabase } from "./supabase.js";

/**
 * The retention principal.
 *
 * This is deliberately the only place in the codebase that can delete a Source
 * Audio Backup, and it is deliberately unable to do anything else: it holds its
 * own database role and its own client certificate, it never imports the
 * encryption module, and the instruction it acts on is a bare object name. It
 * cannot tell whose Call it is removing, and it could not read the contents if
 * it tried.
 *
 * It also only ever removes what the application already authorized. An object
 * name it was not handed is refused by the database, so a compromised retention
 * credential cannot turn into a way to erase live recovery copies.
 */

export interface RetentionTargetConfig {
  baseUrl: string;
  /** A different certificate from the one the worker creates backups with. */
  clientCertificatePem: string;
  clientKeyPem: string;
  certificateAuthorityPem: string;
}

export interface RetentionDependencies {
  target: RetentionTargetConfig;
  /** A Supabase client authenticated as `cauli_retention`, not the worker. */
  client?: SupabaseClient;
  fetch?: typeof fetch;
}

export function retentionTargetFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RetentionTargetConfig | null {
  const baseUrl = environment.BACKUP_VPS_URL?.trim();
  const clientCertificatePem = environment.RETENTION_VPS_CLIENT_CERT?.trim();
  const clientKeyPem = environment.RETENTION_VPS_CLIENT_KEY?.trim();
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

export function retentionClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): SupabaseClient | null {
  const key = environment.SUPABASE_RETENTION_KEY?.trim();
  if (!key) return null;
  return createClient(config.supabaseUrl, key, {
    auth: { persistSession: false },
  });
}

/**
 * Removes one object from the VPS. A copy that is already gone is success — a
 * retry after a partial failure has to converge, not fail forever on the part
 * that already worked.
 */
export async function deleteBackupObject(
  target: RetentionTargetConfig,
  objectName: string,
  options: { fetch?: typeof fetch } = {}
) {
  if (!/^[0-9a-f]{64}$/.test(objectName)) {
    throw new Error("Backup object names must be opaque 256-bit identifiers");
  }
  if (!target.baseUrl.startsWith("https://")) {
    throw new Error("The Source Audio Backup receiver requires HTTPS");
  }

  const response = await (options.fetch ?? fetch)(
    `${target.baseUrl.replace(/\/$/, "")}/objects/${objectName}`,
    {
      method: "DELETE",
      dispatcher: new Agent({
        cert: target.clientCertificatePem,
        key: target.clientKeyPem,
        ca: target.certificateAuthorityPem,
        rejectUnauthorized: true,
      }),
    } as RequestInit & { dispatcher: Agent }
  );

  if (response.status === 204 || response.status === 404) return;
  throw new Error(
    `The Source Audio Backup could not be deleted (${response.status})`
  );
}

/**
 * Carries out one authorized backup deletion. Returns whether there was work,
 * so the caller can back off when the queue is empty.
 */
export async function deleteOneAuthorizedBackup(
  dependencies: RetentionDependencies
): Promise<boolean> {
  const client = dependencies.client ?? supabase;
  const { data: objectName, error: claimError } = await client.rpc(
    "claim_backup_deletion",
    { worker_name: config.workerName }
  );
  if (claimError) throw claimError;
  if (!objectName) return false;

  try {
    await deleteBackupObject(dependencies.target, objectName as string, {
      fetch: dependencies.fetch,
    });
    const { error: commitError } = await client.rpc("commit_backup_deletion", {
      target_object_name: objectName,
    });
    if (commitError) throw commitError;
    log.info("source_audio_backup_deleted", {});
  } catch (error) {
    const { error: failError } = await client.rpc("fail_backup_deletion", {
      target_object_name: objectName,
      target_reason: sanitizedError(error),
    });
    if (failError) throw failError;
    log.error("source_audio_backup_deletion_failed", {
      error: sanitizedError(error),
    });
  }
  return true;
}

/**
 * Enters expired Calls into the same deletion workflow a Workspace Member's
 * manual delete uses. This runs as the application, not as the retention
 * principal — deciding what may go is the application's authority, and acting
 * on that decision is the retention principal's.
 */
export async function expireCallsForRetention() {
  const { data, error } = await supabase.rpc("expire_calls_for_retention", {
    batch_size: 100,
  });
  if (error) throw error;
  const expired = Number(data ?? 0);
  if (expired > 0) log.info("calls_expired_by_retention", { expired });
  return expired;
}
