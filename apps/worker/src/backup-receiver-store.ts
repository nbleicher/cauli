import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ReceiverObject {
  ciphertext: Buffer;
  metadata: {
    checksumSha256: string;
    manifest: string;
    kmsWrappedKey: string;
    ageWrappedKey: string;
    keyVersion: number;
  };
}

export type PutResult =
  | { status: "created" }
  | { status: "existing"; checksumSha256: string }
  | { status: "tombstoned" };

interface ReceiverStoreOptions {
  /**
   * Test seam for suspension after the complete request body is durable but
   * before publication. Production leaves this unset.
   */
  beforePublish?: () => Promise<void>;
}

interface LedgerRow {
  state: "published" | "tombstoned";
  checksum_sha256: string | null;
}

function assertObjectName(objectName: string) {
  if (!/^[0-9a-f]{64}$/.test(objectName)) {
    throw new Error("Backup object names must be opaque 256-bit identifiers");
  }
}

function syncDirectory(directory: string) {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurably(path: string, content: string | Buffer) {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Crash-safe filesystem state machine for the narrow VPS receiver.
 *
 * The SQLite ledger supplies an OS-managed cross-process write lock, released
 * automatically on process death. FULL synchronous commits make tombstones
 * durable before DELETE is acknowledged. Object bytes and directories are
 * explicitly flushed before a publication commit.
 *
 * PUT stages bytes before entering the transaction. DELETE commits a durable
 * tombstone before removing the object. Their order is therefore definitive:
 *
 * - DELETE first: the later PUT observes the tombstone and receives 410.
 * - PUT first: DELETE waits for the transaction, then tombstones and removes.
 *
 * A client clock, database clock, process pause, disconnected HTTP client, or
 * receiver crash therefore cannot recreate an object after DELETE/404.
 */
export class BackupReceiverStore {
  readonly #objectsDirectory: string;
  readonly #incomingDirectory: string;
  readonly #ledgerPath: string;
  readonly #options: ReceiverStoreOptions;
  #database: DatabaseSync | null = null;

  constructor(
    private readonly rootDirectory: string,
    options: ReceiverStoreOptions = {}
  ) {
    this.#objectsDirectory = join(rootDirectory, "objects");
    this.#incomingDirectory = join(rootDirectory, "incoming");
    this.#ledgerPath = join(rootDirectory, "receiver-ledger.sqlite");
    this.#options = options;
  }

  async initialize() {
    if (this.#database) return;
    for (const directory of [
      this.rootDirectory,
      this.#objectsDirectory,
      this.#incomingDirectory,
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(this.#ledgerPath);
    this.#database.exec(`
      pragma journal_mode = WAL;
      pragma synchronous = FULL;
      pragma busy_timeout = 60000;
      create table if not exists receiver_objects (
        object_name text primary key
          check (length(object_name) = 64),
        state text not null
          check (state in ('published', 'tombstoned')),
        checksum_sha256 text,
        changed_at text not null
      ) strict;
    `);
    syncDirectory(this.rootDirectory);
    this.#reconcilePublishedDirectories();
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }

  async put(objectName: string, object: ReceiverObject): Promise<PutResult> {
    assertObjectName(objectName);
    if (!/^[0-9a-f]{64}$/.test(object.metadata.checksumSha256)) {
      throw new Error("Backup ciphertext checksum must be SHA-256");
    }
    const actualChecksum = createHash("sha256")
      .update(object.ciphertext)
      .digest("hex");
    if (actualChecksum !== object.metadata.checksumSha256) {
      throw new Error("Backup ciphertext does not match its checksum");
    }

    await this.initialize();
    const stagedDirectory = mkdtempSync(
      join(this.#incomingDirectory, `${objectName}-`)
    );
    try {
      writeDurably(join(stagedDirectory, "ciphertext"), object.ciphertext);
      writeDurably(
        join(stagedDirectory, "metadata.json"),
        JSON.stringify(object.metadata)
      );
      syncDirectory(stagedDirectory);
      syncDirectory(this.#incomingDirectory);

      await this.#options.beforePublish?.();
      return this.#transaction(() => {
        const existing = this.#ledgerRow(objectName);
        if (existing?.state === "tombstoned") {
          return { status: "tombstoned" };
        }
        if (existing?.state === "published") {
          return {
            status: "existing",
            checksumSha256: existing.checksum_sha256 ?? "",
          };
        }

        const objectDirectory = this.#objectDirectory(objectName);
        if (existsSync(objectDirectory)) {
          const recovered = this.#readObject(objectName);
          this.#recordPublished(objectName, recovered.metadata.checksumSha256);
          return {
            status: "existing",
            checksumSha256: recovered.metadata.checksumSha256,
          };
        }

        renameSync(stagedDirectory, objectDirectory);
        syncDirectory(this.#objectsDirectory);
        this.#recordPublished(objectName, object.metadata.checksumSha256);
        return { status: "created" };
      });
    } finally {
      rmSync(stagedDirectory, { recursive: true, force: true });
    }
  }

  async delete(objectName: string) {
    assertObjectName(objectName);
    await this.initialize();
    this.#transaction(() => {
      this.#database!.prepare(
        `insert into receiver_objects (
           object_name, state, checksum_sha256, changed_at
         ) values (?, 'tombstoned', null, ?)
         on conflict (object_name) do update
         set state = 'tombstoned',
             checksum_sha256 = null,
             changed_at = excluded.changed_at`
      ).run(objectName, new Date().toISOString());
    });

    // The committed ledger fence already prevents every future PUT. Removing
    // bytes after that commit makes a crash between the two steps converge on
    // retry without reopening publication.
    rmSync(this.#objectDirectory(objectName), {
      recursive: true,
      force: true,
    });
    syncDirectory(this.#objectsDirectory);
  }

  async get(objectName: string): Promise<ReceiverObject | null> {
    assertObjectName(objectName);
    await this.initialize();
    if (this.#ledgerRow(objectName)?.state !== "published") return null;
    try {
      return this.#readObject(objectName);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async isTombstoned(objectName: string) {
    assertObjectName(objectName);
    await this.initialize();
    return this.#ledgerRow(objectName)?.state === "tombstoned";
  }

  durabilitySettings() {
    if (!this.#database) throw new Error("Receiver store is not initialized");
    return {
      journalMode: (
        this.#database.prepare("pragma journal_mode").get() as {
          journal_mode: string;
        }
      ).journal_mode,
      synchronous: (
        this.#database.prepare("pragma synchronous").get() as {
          synchronous: number;
        }
      ).synchronous,
    };
  }

  #objectDirectory(objectName: string) {
    return join(this.#objectsDirectory, objectName);
  }

  #ledgerRow(objectName: string) {
    return this.#database!.prepare(
      `select state, checksum_sha256
       from receiver_objects
       where object_name = ?`
    ).get(objectName) as LedgerRow | undefined;
  }

  #readObject(objectName: string): ReceiverObject {
    const objectDirectory = this.#objectDirectory(objectName);
    return {
      ciphertext: readFileSync(join(objectDirectory, "ciphertext")),
      metadata: JSON.parse(
        readFileSync(join(objectDirectory, "metadata.json"), "utf8")
      ) as ReceiverObject["metadata"],
    };
  }

  #recordPublished(objectName: string, checksumSha256: string) {
    this.#database!.prepare(
      `insert into receiver_objects (
         object_name, state, checksum_sha256, changed_at
       ) values (?, 'published', ?, ?)
       on conflict (object_name) do update
       set state = 'published',
           checksum_sha256 = excluded.checksum_sha256,
           changed_at = excluded.changed_at
       where receiver_objects.state != 'tombstoned'`
    ).run(objectName, checksumSha256, new Date().toISOString());
  }

  #reconcilePublishedDirectories() {
    this.#transaction(() => {
      let changed = false;
      for (const objectName of readdirSync(this.#objectsDirectory)) {
        if (!/^[0-9a-f]{64}$/.test(objectName)) continue;
        const row = this.#ledgerRow(objectName);
        if (row?.state === "tombstoned") {
          rmSync(this.#objectDirectory(objectName), {
            recursive: true,
            force: true,
          });
          changed = true;
          continue;
        }
        if (!row) {
          const recovered = this.#readObject(objectName);
          this.#recordPublished(objectName, recovered.metadata.checksumSha256);
        }
      }
      if (changed) syncDirectory(this.#objectsDirectory);
    });
  }

  #transaction<T>(operation: () => T) {
    this.#database!.exec("begin immediate");
    try {
      const result = operation();
      this.#database!.exec("commit");
      return result;
    } catch (error) {
      this.#database!.exec("rollback");
      throw error;
    }
  }
}
