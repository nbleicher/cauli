import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { readBackupObject, type BackupTargetConfig } from "./backup-target.js";
import { log, sanitizedError } from "./log.js";

/**
 * The offline copy on Peely.
 *
 * This agent runs on the operator's machine, not in production, and is the
 * least capable principal in the system. It knows an opaque object name and the
 * digest that name should hash to — enough to copy a backup and prove it
 * arrived intact, and nothing else. It holds no wrapped key and never imports
 * the encryption module, so it cannot open a single thing it stores.
 *
 * It also never mirrors a disappearance. A copy missing from the VPS is not an
 * instruction to remove the offline one; only an application-authorized
 * deletion is. That is the whole point of keeping this copy: a VPS that loses
 * its objects, by accident or by host-root compromise, must not be able to take
 * Peely down with it.
 */

export interface PeelySyncDependencies {
  /** Usually /Volumes/Peely SSD. */
  directory: string;
  target: BackupTargetConfig;
  /** A Supabase client authenticated as `cauli_peely`. */
  client: SupabaseClient;
  fetch?: typeof fetch;
}

export interface PeelySyncResult {
  verified: number;
  copied: number;
  removed: number;
  failures: string[];
}

interface SyncObject {
  object_name: string;
  ciphertext_sha256: string;
}

function objectPath(directory: string, objectName: string) {
  if (!/^[0-9a-f]{64}$/.test(objectName)) {
    throw new Error("Backup object names must be opaque 256-bit identifiers");
  }
  return join(directory, `${objectName}.backup`);
}

function manifestPath(directory: string, objectName: string) {
  return join(directory, `${objectName}.manifest`);
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function storedChecksum(path: string) {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

/**
 * Copies every stored backup that is not already on Peely, verifies what is,
 * and removes only what the application authorized removing.
 */
export async function synchronizePeely(
  dependencies: PeelySyncDependencies
): Promise<PeelySyncResult> {
  const { client, directory } = dependencies;
  const result: PeelySyncResult = {
    verified: 0,
    copied: 0,
    removed: 0,
    failures: [],
  };

  await mkdir(directory, { recursive: true });

  // Authorized removals are applied first. Doing this after the copy loop would
  // mean fetching an object back from the VPS only to delete it again on the
  // same run, every run.
  const { data: authorized, error: deletionError } = await client.rpc(
    "list_authorized_backup_deletions"
  );
  if (deletionError) throw deletionError;

  for (const { object_name: objectName } of (authorized ?? []) as {
    object_name: string;
  }[]) {
    try {
      const localPath = objectPath(directory, objectName);
      // Authorizations outlive the copies they removed, so every run sees all
      // of them. Only a copy that was still here counts as removed by this run.
      const present = await stat(localPath).then(
        () => true,
        () => false
      );
      if (!present) continue;
      await rm(localPath, { force: true });
      await rm(manifestPath(directory, objectName), { force: true });
      result.removed += 1;
    } catch (error) {
      result.failures.push(sanitizedError(error));
    }
  }

  const { data: objects, error: listError } = await client.rpc(
    "list_backup_objects_for_sync"
  );
  if (listError) throw listError;

  for (const object of (objects ?? []) as SyncObject[]) {
    const localPath = objectPath(directory, object.object_name);
    try {
      const existing = await storedChecksum(localPath);
      if (existing === object.ciphertext_sha256) {
        result.verified += 1;
        continue;
      }

      const fetched = await readBackupObject(
        dependencies.target,
        object.object_name,
        { fetch: dependencies.fetch }
      );

      // What the VPS handed over is only accepted if it is what the database
      // says it should be. A corrupted or substituted object is never written
      // over a good offline copy.
      const actual = sha256(fetched.ciphertext);
      if (actual !== object.ciphertext_sha256) {
        throw new Error(
          "The Source Audio Backup on the VPS does not match its recorded checksum"
        );
      }

      await writeFile(localPath, fetched.ciphertext);
      await writeFile(
        manifestPath(directory, object.object_name),
        fetched.manifest
      );
      result.copied += 1;
    } catch (error) {
      // One bad object does not abandon the rest of the run.
      result.failures.push(sanitizedError(error));
    }
  }

  const { error: recordError } = await client.rpc("record_peely_sync", {
    target_objects_verified: result.verified,
    target_objects_copied: result.copied,
    target_objects_removed: result.removed,
    target_failure_reason: result.failures.length
      ? `${result.failures.length} object(s) failed`
      : null,
  });
  if (recordError) throw recordError;

  log.info("peely_sync_complete", {
    verified: result.verified,
    copied: result.copied,
    removed: result.removed,
    failures: result.failures.length,
  });
  return result;
}

/** Everything Peely holds, for the contract that says it holds nothing else. */
export async function listPeelyContents(directory: string) {
  const entries = await readdir(directory).catch(() => []);
  return entries.filter((entry) => !entry.startsWith("."));
}

export interface OperatorAlert {
  subject: string;
  body: string;
}

export interface FreshnessDependencies {
  client: SupabaseClient;
  sendOperatorEmail: (alert: OperatorAlert) => Promise<void>;
}

/**
 * An offline copy nobody notices going stale is not a recovery path. Forty-eight
 * hours without a *successful* sync raises an operator email — and so does never
 * having synchronized at all, which is the same problem wearing a different
 * face.
 */
export async function alertOnStalePeelySync(
  dependencies: FreshnessDependencies
) {
  const { data, error } = await dependencies.client.rpc("peely_sync_freshness");
  if (error) throw error;
  const freshness = (
    data as {
      last_success_at: string | null;
      stale_hours: number;
      alerting: boolean;
    }[]
  )?.[0];
  if (!freshness?.alerting) return false;

  const staleHours = Math.floor(Number(freshness.stale_hours));
  await dependencies.sendOperatorEmail({
    subject: "Cauli: the Peely offline backup copy is stale",
    // Content-free: how long, never what is missing or whose it was.
    body: freshness.last_success_at
      ? `The last successful Peely synchronization completed ${staleHours} hours ago, past the 48-hour threshold.`
      : "Peely has never completed a successful synchronization.",
  });
  log.error("peely_sync_stale", { staleHours });
  return true;
}
