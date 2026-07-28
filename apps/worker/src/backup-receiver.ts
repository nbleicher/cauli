#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import {
  BackupReceiverStore,
  type ReceiverObject,
} from "./backup-receiver-store.js";
import { log, sanitizedError } from "./log.js";

interface ReceiverPrincipals {
  writer: string;
  retention: string;
  readers: Set<string>;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function header(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  if (typeof value === "string") return value;
  return value?.[0];
}

function respond(response: ServerResponse, status: number) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
}

async function readBody(request: IncomingMessage, maximumBytes: number) {
  const declaredBytes = Number(header(request, "content-length") ?? NaN);
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 0 ||
    declaredBytes > maximumBytes
  ) {
    throw new RangeError("Backup object exceeds the receiver limit");
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    receivedBytes += bytes.length;
    if (receivedBytes > maximumBytes || receivedBytes > declaredBytes) {
      throw new RangeError("Backup object exceeds the receiver limit");
    }
    chunks.push(bytes);
  }
  if (receivedBytes !== declaredBytes) {
    throw new Error("Backup object body ended before Content-Length");
  }
  return Buffer.concat(chunks);
}

function peerCommonName(request: IncomingMessage) {
  const commonName = (request.socket as TLSSocket).getPeerCertificate().subject
    ?.CN;
  return typeof commonName === "string" ? commonName : "";
}

export function createBackupReceiverHandler(
  store: BackupReceiverStore,
  principals: ReceiverPrincipals,
  maximumObjectBytes: number,
  identifyPeer: (request: IncomingMessage) => string = peerCommonName
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("cache-control", "no-store");
    const match = request.url?.match(/^\/objects\/([0-9a-f]{64})$/);
    if (!match) {
      respond(response, 404);
      return;
    }
    const objectName = match[1]!;
    const commonName = identifyPeer(request);

    try {
      if (request.method === "PUT") {
        if (commonName !== principals.writer) {
          respond(response, 403);
          return;
        }
        if (header(request, "if-none-match") !== "*") {
          respond(response, 428);
          return;
        }
        const metadata: ReceiverObject["metadata"] = {
          checksumSha256: header(request, "x-cauli-checksum-sha256") ?? "",
          manifest: header(request, "x-cauli-manifest") ?? "",
          kmsWrappedKey: header(request, "x-cauli-wrapped-kms") ?? "",
          ageWrappedKey: header(request, "x-cauli-wrapped-age") ?? "",
          keyVersion: Number(header(request, "x-cauli-key-version") ?? NaN),
        };
        if (
          !metadata.manifest ||
          !metadata.kmsWrappedKey ||
          !metadata.ageWrappedKey ||
          !Number.isSafeInteger(metadata.keyVersion) ||
          metadata.keyVersion <= 0
        ) {
          respond(response, 400);
          return;
        }
        const ciphertext = await readBody(request, maximumObjectBytes);
        const result = await store.put(objectName, { ciphertext, metadata });
        if (result.status === "created") {
          respond(response, 201);
          return;
        }
        if (result.status === "tombstoned") {
          respond(response, 410);
          return;
        }
        response.setHeader("x-cauli-checksum-sha256", result.checksumSha256);
        respond(response, 412);
        return;
      }

      if (request.method === "DELETE") {
        if (commonName !== principals.retention) {
          respond(response, 403);
          return;
        }
        await store.delete(objectName);
        respond(response, 204);
        return;
      }

      if (request.method === "GET") {
        if (!principals.readers.has(commonName)) {
          respond(response, 403);
          return;
        }
        const object = await store.get(objectName);
        if (!object) {
          respond(response, 404);
          return;
        }
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/octet-stream",
          "content-length": String(object.ciphertext.length),
          "x-cauli-checksum-sha256": object.metadata.checksumSha256,
          "x-cauli-manifest": object.metadata.manifest,
          "x-cauli-wrapped-kms": object.metadata.kmsWrappedKey,
          "x-cauli-wrapped-age": object.metadata.ageWrappedKey,
          "x-cauli-key-version": String(object.metadata.keyVersion),
        });
        response.end(object.ciphertext);
        return;
      }

      response.setHeader("allow", "GET, PUT, DELETE");
      respond(response, 405);
    } catch (error) {
      if (error instanceof RangeError) {
        respond(response, 413);
        return;
      }
      log.error("backup_receiver_request_failed", {
        method: request.method,
        error: sanitizedError(error),
      });
      respond(response, 503);
    }
  };
}

async function main() {
  const store = new BackupReceiverStore(required("BACKUP_RECEIVER_DATA_DIR"));
  await store.initialize();
  const principals: ReceiverPrincipals = {
    writer:
      process.env.BACKUP_RECEIVER_WRITER_CN?.trim() ?? "cauli-backup-writer",
    retention:
      process.env.BACKUP_RECEIVER_RETENTION_CN?.trim() ?? "cauli-retention",
    readers: new Set(
      (
        process.env.BACKUP_RECEIVER_READER_CNS ??
        "cauli-backup-writer,cauli-peely"
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  };
  const maximumObjectBytes = Number(
    process.env.BACKUP_RECEIVER_MAX_OBJECT_BYTES ?? 21_474_836_480
  );
  if (!Number.isSafeInteger(maximumObjectBytes) || maximumObjectBytes <= 0) {
    throw new Error(
      "BACKUP_RECEIVER_MAX_OBJECT_BYTES must be a positive integer"
    );
  }

  const [certificate, key, clientAuthority] = await Promise.all([
    readFile(required("BACKUP_RECEIVER_TLS_CERT")),
    readFile(required("BACKUP_RECEIVER_TLS_KEY")),
    readFile(required("BACKUP_RECEIVER_CLIENT_CA")),
  ]);
  const server = createServer(
    {
      cert: certificate,
      key,
      ca: clientAuthority,
      requestCert: true,
      rejectUnauthorized: true,
    },
    createBackupReceiverHandler(store, principals, maximumObjectBytes)
  );
  server.listen(Number(process.env.PORT ?? 8_443), "0.0.0.0", () => {
    log.info("backup_receiver_listening", {});
  });
  const stop = () => server.close();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.env.NODE_ENV !== "test") {
  void main().catch((error) => {
    log.error("backup_receiver_startup_failed", {
      error: sanitizedError(error),
    });
    process.exitCode = 1;
  });
}
