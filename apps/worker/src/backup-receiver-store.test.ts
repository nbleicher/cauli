import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupReceiverStore,
  type ReceiverObject,
} from "./backup-receiver-store.js";
import { createBackupReceiverHandler } from "./backup-receiver.js";

const directories: string[] = [];
const stores: BackupReceiverStore[] = [];
const objectName = "a".repeat(64);
const object: ReceiverObject = {
  ciphertext: Buffer.from("encrypted Source Audio"),
  metadata: {
    checksumSha256: createHash("sha256")
      .update("encrypted Source Audio")
      .digest("hex"),
    manifest: "encrypted-manifest",
    kmsWrappedKey: "kms-wrapped",
    ageWrappedKey: "age-wrapped",
    keyVersion: 2,
  },
};

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "cauli-receiver-"));
  directories.push(directory);
  return directory;
}

function receiverStore(
  directory: string,
  options?: ConstructorParameters<typeof BackupReceiverStore>[1]
) {
  const store = new BackupReceiverStore(directory, options);
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("the durable Source Audio Backup receiver fence", () => {
  it("creates once and never overwrites different bytes", async () => {
    const store = receiverStore(await temporaryDirectory());
    expect(await store.put(objectName, object)).toEqual({ status: "created" });
    expect(await store.put(objectName, object)).toEqual({
      status: "existing",
      checksumSha256: object.metadata.checksumSha256,
    });
    expect((await store.get(objectName))?.ciphertext).toEqual(
      object.ciphertext
    );
  });

  it("tombstones a completed deletion so a later PUT cannot recreate it", async () => {
    const store = receiverStore(await temporaryDirectory());
    await store.delete(objectName);

    expect(await store.put(objectName, object)).toEqual({
      status: "tombstoned",
    });
    expect(await store.get(objectName)).toBeNull();
    expect(await store.isTombstoned(objectName)).toBe(true);
  });

  it("rejects publication after an accepted body pauses and deletion wins", async () => {
    let releasePublication!: () => void;
    let bodyAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      bodyAccepted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const directory = await temporaryDirectory();
    const delayedReceiver = receiverStore(directory, {
      beforePublish: async () => {
        bodyAccepted();
        await release;
      },
    });

    // The receiver has the whole body, but the caller can disconnect or its
    // process can suspend before publication. Retention is still allowed to
    // complete a DELETE/404 in that interval.
    const latePut = delayedReceiver.put(objectName, object);
    await accepted;
    const retentionReceiver = receiverStore(directory);
    await retentionReceiver.delete(objectName);
    releasePublication();

    expect(await latePut).toEqual({ status: "tombstoned" });
    expect(await retentionReceiver.get(objectName)).toBeNull();
    expect(await retentionReceiver.isTombstoned(objectName)).toBe(true);
  });

  it("keeps a disconnected accepted PUT fenced behind a receiver DELETE", async () => {
    let releasePublication!: () => void;
    let bodyAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      bodyAccepted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const store = receiverStore(await temporaryDirectory(), {
      beforePublish: async () => {
        bodyAccepted();
        await release;
      },
    });
    const server = createServer(
      createBackupReceiverHandler(
        store,
        {
          writer: "writer",
          retention: "retention",
          readers: new Set(["reader"]),
        },
        1_024,
        (incoming) => String(incoming.headers["x-test-principal"] ?? "")
      )
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const port = (server.address() as AddressInfo).port;

    try {
      const putRequest = request({
        host: "127.0.0.1",
        port,
        path: `/objects/${objectName}`,
        method: "PUT",
        headers: {
          "content-length": String(object.ciphertext.length),
          "if-none-match": "*",
          "x-test-principal": "writer",
          "x-cauli-checksum-sha256": object.metadata.checksumSha256,
          "x-cauli-manifest": object.metadata.manifest,
          "x-cauli-wrapped-kms": object.metadata.kmsWrappedKey,
          "x-cauli-wrapped-age": object.metadata.ageWrappedKey,
          "x-cauli-key-version": String(object.metadata.keyVersion),
        },
      });
      putRequest.on("error", () => {});
      putRequest.end(object.ciphertext);
      await accepted;

      // The caller times out after the receiver accepted every byte. The
      // receiver may still be paused, so client abort alone is not settlement.
      putRequest.destroy(new Error("caller timed out"));
      const deletionStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          const deletion = request(
            {
              host: "127.0.0.1",
              port,
              path: `/objects/${objectName}`,
              method: "DELETE",
              headers: { "x-test-principal": "retention" },
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode));
            }
          );
          deletion.on("error", reject);
          deletion.end();
        }
      );
      expect(deletionStatus).toBe(204);

      releasePublication();
      await expect.poll(() => store.isTombstoned(objectName)).toBe(true);
      expect(await store.get(objectName)).toBeNull();
    } finally {
      releasePublication();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("releases an in-flight transaction lock when the receiver process dies", async () => {
    const directory = await temporaryDirectory();
    const store = receiverStore(directory);
    await store.initialize();
    store.close();

    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { DatabaseSync } from "node:sqlite";
          const database = new DatabaseSync(process.argv[1]);
          database.exec("pragma busy_timeout = 60000; begin immediate");
          process.stdout.write("locked");
          setInterval(() => {}, 1000);
        `,
        join(directory, "receiver-ledger.sqlite"),
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");

    const restarted = receiverStore(directory);
    await restarted.delete(objectName);
    expect(await restarted.isTombstoned(objectName)).toBe(true);
  });

  it("persists an acknowledged tombstone across a receiver restart", async () => {
    const directory = await temporaryDirectory();
    const firstProcess = receiverStore(directory);
    await firstProcess.delete(objectName);
    expect(firstProcess.durabilitySettings()).toEqual({
      journalMode: "wal",
      synchronous: 2,
    });
    firstProcess.close();

    const restarted = receiverStore(directory);
    expect(await restarted.put(objectName, object)).toEqual({
      status: "tombstoned",
    });
    expect(await restarted.get(objectName)).toBeNull();
  });
});
