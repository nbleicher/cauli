import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

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
  lockTimeoutMs?: number;
}

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function assertObjectName(objectName: string) {
  if (!/^[0-9a-f]{64}$/.test(objectName)) {
    throw new Error("Backup object names must be opaque 256-bit identifiers");
  }
}

function isAlreadyExists(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isMissing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Filesystem state machine for the narrow VPS receiver.
 *
 * PUT stages bytes before taking the per-object filesystem lock. DELETE writes
 * a durable tombstone before removing the object. Publication and deletion
 * both hold that same lock, so their order is definitive even across multiple
 * receiver processes:
 *
 * - DELETE first: the later PUT observes the tombstone and receives 410.
 * - PUT first: DELETE waits, then tombstones and removes the published object.
 *
 * A client clock, database clock, process pause, or disconnected HTTP client
 * therefore cannot recreate an object after a successful DELETE/404.
 */
export class BackupReceiverStore {
  readonly #objectsDirectory: string;
  readonly #incomingDirectory: string;
  readonly #locksDirectory: string;
  readonly #tombstonesDirectory: string;
  readonly #options: ReceiverStoreOptions;

  constructor(
    private readonly rootDirectory: string,
    options: ReceiverStoreOptions = {}
  ) {
    this.#objectsDirectory = join(rootDirectory, "objects");
    this.#incomingDirectory = join(rootDirectory, "incoming");
    this.#locksDirectory = join(rootDirectory, "locks");
    this.#tombstonesDirectory = join(rootDirectory, "tombstones");
    this.#options = options;
  }

  async initialize() {
    await Promise.all(
      [
        this.rootDirectory,
        this.#objectsDirectory,
        this.#incomingDirectory,
        this.#locksDirectory,
        this.#tombstonesDirectory,
      ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 }))
    );
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
    const stagedDirectory = await mkdtemp(
      join(this.#incomingDirectory, `${objectName}-`)
    );
    await Promise.all([
      writeFile(join(stagedDirectory, "ciphertext"), object.ciphertext, {
        mode: 0o600,
      }),
      writeFile(
        join(stagedDirectory, "metadata.json"),
        JSON.stringify(object.metadata),
        { mode: 0o600 }
      ),
    ]);

    try {
      await this.#options.beforePublish?.();
      return await this.#withLock(objectName, async () => {
        if (await this.#tombstoneExists(objectName)) {
          return { status: "tombstoned" };
        }

        const existing = await this.get(objectName);
        if (existing) {
          return {
            status: "existing",
            checksumSha256: existing.metadata.checksumSha256,
          };
        }

        await rename(stagedDirectory, this.#objectDirectory(objectName));
        return { status: "created" };
      });
    } finally {
      await rm(stagedDirectory, { recursive: true, force: true });
    }
  }

  async delete(objectName: string) {
    assertObjectName(objectName);
    await this.initialize();
    await this.#withLock(objectName, async () => {
      try {
        await writeFile(
          join(this.#tombstonesDirectory, objectName),
          `${new Date().toISOString()}\n`,
          { flag: "wx", mode: 0o600 }
        );
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      await rm(this.#objectDirectory(objectName), {
        recursive: true,
        force: true,
      });
    });
  }

  async get(objectName: string): Promise<ReceiverObject | null> {
    assertObjectName(objectName);
    try {
      const [ciphertext, metadata] = await Promise.all([
        readFile(join(this.#objectDirectory(objectName), "ciphertext")),
        readFile(join(this.#objectDirectory(objectName), "metadata.json"), {
          encoding: "utf8",
        }),
      ]);
      return {
        ciphertext,
        metadata: JSON.parse(metadata) as ReceiverObject["metadata"],
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async isTombstoned(objectName: string) {
    assertObjectName(objectName);
    await this.initialize();
    return this.#tombstoneExists(objectName);
  }

  #objectDirectory(objectName: string) {
    return join(this.#objectsDirectory, objectName);
  }

  async #tombstoneExists(objectName: string) {
    try {
      await readFile(join(this.#tombstonesDirectory, objectName));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async #withLock<T>(objectName: string, operation: () => Promise<T>) {
    const lockDirectory = join(this.#locksDirectory, objectName);
    const deadline = Date.now() + (this.#options.lockTimeoutMs ?? 60_000);
    while (true) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (Date.now() >= deadline) {
          throw new Error("Backup receiver object lock timed out");
        }
        await delay(10);
      }
    }

    try {
      return await operation();
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }
}
