import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  mkdtemp,
  rename,
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

function bundlePath(directory: string, objectName: string) {
  if (!/^[0-9a-f]{64}$/.test(objectName)) {
    throw new Error("Backup object names must be opaque 256-bit identifiers");
  }
  return join(directory, `${objectName}.bundle`);
}

function bundleFile(bundle: string, name: string) {
  return join(bundle, name);
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

interface PeelyBundleMetadata {
  formatVersion: 1;
  ciphertextSha256: string;
  manifestSha256: string;
  kmsWrappedKey: string;
  ageWrappedKey: string;
  keyVersion: number;
}

async function readBundleAt(bundle: string) {
  try {
    const [ciphertext, manifest, metadataBytes] = await Promise.all([
      readFile(bundleFile(bundle, "source-audio.backup")),
      readFile(bundleFile(bundle, "manifest.encrypted")),
      readFile(bundleFile(bundle, "wrapped-keys.json")),
    ]);
    const metadata = JSON.parse(
      metadataBytes.toString("utf8")
    ) as PeelyBundleMetadata;
    if (
      metadata.formatVersion !== 1 ||
      !/^[0-9a-f]{64}$/.test(metadata.ciphertextSha256) ||
      !/^[0-9a-f]{64}$/.test(metadata.manifestSha256) ||
      !metadata.kmsWrappedKey ||
      !metadata.ageWrappedKey ||
      !Number.isInteger(metadata.keyVersion) ||
      metadata.keyVersion <= 0 ||
      sha256(ciphertext) !== metadata.ciphertextSha256 ||
      sha256(manifest) !== metadata.manifestSha256
    ) {
      throw new Error("Peely recovery bundle verification failed");
    }
    return { ciphertext, manifest, ...metadata };
  } catch {
    return null;
  }
}

export async function readPeelyRecoveryBundle(
  directory: string,
  objectName: string
) {
  return readBundleAt(bundlePath(directory, objectName));
}

async function publishRecoveryBundle(
  directory: string,
  objectName: string,
  fetched: Awaited<ReturnType<typeof readBackupObject>>
) {
  const temporary = await mkdtemp(join(directory, `.${objectName}.tmp-`));
  const destination = bundlePath(directory, objectName);
  const displaced = join(
    directory,
    `.${objectName}.replaced-${crypto.randomUUID()}`
  );
  try {
    const metadata: PeelyBundleMetadata = {
      formatVersion: 1,
      ciphertextSha256: fetched.ciphertextSha256,
      manifestSha256: sha256(fetched.manifest),
      kmsWrappedKey: fetched.kmsWrappedKey,
      ageWrappedKey: fetched.ageWrappedKey,
      keyVersion: fetched.keyVersion,
    };
    await Promise.all([
      writeFile(
        bundleFile(temporary, "source-audio.backup"),
        fetched.ciphertext,
        { mode: 0o600 }
      ),
      writeFile(bundleFile(temporary, "manifest.encrypted"), fetched.manifest, {
        mode: 0o600,
      }),
      writeFile(
        bundleFile(temporary, "wrapped-keys.json"),
        JSON.stringify(metadata),
        { mode: 0o600 }
      ),
    ]);

    if (!(await readBundleAt(temporary))) {
      throw new Error("The staged Peely recovery bundle did not verify");
    }

    let hadDestination = false;
    try {
      await rename(destination, displaced);
      hadDestination = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (hadDestination) await rename(displaced, destination);
      throw error;
    }
    if (hadDestination) await rm(displaced, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
      const localPath = bundlePath(directory, objectName);
      // Authorizations outlive the copies they removed, so every run sees all
      // of them. Only a copy that was still here counts as removed by this run.
      const present = await stat(localPath).then(
        () => true,
        () => false
      );
      if (!present) continue;
      await rm(localPath, { recursive: true, force: true });
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
    try {
      const existing = await readPeelyRecoveryBundle(
        directory,
        object.object_name
      );
      if (existing?.ciphertextSha256 === object.ciphertext_sha256) {
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
      if (
        !fetched.manifest.length ||
        !fetched.kmsWrappedKey ||
        !fetched.ageWrappedKey ||
        !Number.isInteger(fetched.keyVersion) ||
        fetched.keyVersion <= 0
      ) {
        throw new Error(
          "The Source Audio Backup is missing recovery bundle material"
        );
      }

      await publishRecoveryBundle(directory, object.object_name, fetched);
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

interface LocalFreshnessDependencies {
  directory: string;
  sendOperatorEmail: (alert: OperatorAlert) => Promise<void>;
  now?: Date;
}

const LAST_SUCCESS_FILE = ".last-success.json";

export async function recordLocalPeelySyncSuccess(
  directory: string,
  completedAt = new Date()
) {
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${LAST_SUCCESS_FILE}.${process.pid}.${crypto.randomUUID()}`
  );
  await writeFile(
    temporary,
    JSON.stringify({ completedAt: completedAt.toISOString() }),
    { mode: 0o600 }
  );
  await rename(temporary, join(directory, LAST_SUCCESS_FILE));
}

/**
 * This check depends only on Peely's own disk and the alert channel. It still
 * fires when the production database or VPS failure that broke synchronization
 * would also make the server-side freshness RPC unavailable.
 */
export async function alertOnStaleLocalPeelySync(
  dependencies: LocalFreshnessDependencies
) {
  const now = dependencies.now ?? new Date();
  let lastSuccess: Date | null = null;
  try {
    const state = JSON.parse(
      await readFile(join(dependencies.directory, LAST_SUCCESS_FILE), "utf8")
    ) as { completedAt?: unknown };
    if (typeof state.completedAt === "string") {
      const parsed = new Date(state.completedAt);
      if (Number.isFinite(parsed.valueOf())) lastSuccess = parsed;
    }
  } catch {
    lastSuccess = null;
  }

  const staleHours = lastSuccess
    ? Math.floor((now.getTime() - lastSuccess.getTime()) / 3_600_000)
    : null;
  if (staleHours !== null && staleHours <= 48 && staleHours >= 0) return false;

  await dependencies.sendOperatorEmail({
    subject: "Cauli: the Peely offline backup copy is stale",
    body: lastSuccess
      ? `The last successful Peely synchronization completed ${staleHours} hours ago, past the 48-hour threshold.`
      : "Peely has never completed a successful synchronization.",
  });
  log.error("peely_sync_stale", { staleHours: staleHours ?? -1 });
  return true;
}

export interface IndependentAlertDependencies {
  directory: string;
  synchronize: () => Promise<PeelySyncResult>;
  sendOperatorEmail: (alert: OperatorAlert) => Promise<void>;
  now?: Date;
}

/** Runs the alert even when synchronization itself throws. */
export async function synchronizePeelyWithIndependentAlert(
  dependencies: IndependentAlertDependencies
) {
  let result: PeelySyncResult | undefined;
  let syncError: unknown;
  try {
    result = await dependencies.synchronize();
    if (result.failures.length === 0) {
      await recordLocalPeelySyncSuccess(
        dependencies.directory,
        dependencies.now
      );
    }
  } catch (error) {
    syncError = error;
  }

  await alertOnStaleLocalPeelySync(dependencies);
  if (syncError) throw syncError;
  return result!;
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
