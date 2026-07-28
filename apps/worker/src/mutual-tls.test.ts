import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBackupObject } from "./backup-target.js";
import { mutualTlsFetch } from "./mutual-tls.js";

/**
 * These drive the real transport against a real TLS server that really demands
 * a client certificate. Every other backup contract injects its own `fetch`,
 * which is exactly how a transport that could never have connected passed a
 * full test suite.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mutual-tls-contract-key";
process.env.OPENROUTER_API_KEY ??= "mutual-tls-contract-key";

const workspace = mkdtempSync(join(tmpdir(), "cauli-mtls-"));
let server: Server;
let baseUrl = "";
let received: { method: string; url: string; authorized: boolean }[] = [];

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: workspace, stdio: "ignore" });
}

function pem(name: string) {
  return readFileSync(join(workspace, name), "utf8");
}

function issue(name: string, commonName: string, authority: string) {
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${commonName}`
  );
  openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${authority}.crt`,
    "-CAkey",
    `${authority}.key`,
    "-CAcreateserial",
    "-out",
    `${name}.crt`,
    "-days",
    "1"
  );
}

beforeAll(async () => {
  // One CA the receiver and the worker both trust, and a second nobody does.
  for (const authority of ["ca", "impostor-ca"]) {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${authority}.key`,
      "-out",
      `${authority}.crt`,
      "-days",
      "1",
      "-subj",
      `/CN=${authority}`
    );
  }
  for (const [name, commonName, authority] of [
    ["server", "localhost", "ca"],
    ["worker", "cauli-backup-writer", "ca"],
    ["stranger", "someone-else", "impostor-ca"],
  ] as const) {
    issue(name, commonName, authority);
  }

  server = createServer(
    {
      cert: pem("server.crt"),
      key: pem("server.key"),
      ca: pem("ca.crt"),
      // The receiver demands a certificate it recognises, exactly as the VPS
      // intake does.
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorized: Boolean(
          (request.socket as { authorized?: boolean }).authorized
        ),
      });
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === "/slow") {
        request.resume();
        setTimeout(() => {
          response.writeHead(200);
          response.end();
        }, 250);
        return;
      }
      request.resume();
      request.on("end", () => {
        response.writeHead(201, { "x-cauli-checksum-sha256": "a".repeat(64) });
        response.end();
      });
    }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
});

const objectName = "b".repeat(64);

function credentials(overrides: Record<string, string> = {}) {
  return {
    baseUrl,
    clientCertificatePem: pem("worker.crt"),
    clientKeyPem: pem("worker.key"),
    certificateAuthorityPem: pem("ca.crt"),
    ...overrides,
  };
}

describe("the mutual TLS transport", () => {
  it("presents the client certificate on a real connection", async () => {
    received = [];
    const response = await mutualTlsFetch(credentials())(
      `${baseUrl}/objects/${objectName}`,
      { method: "PUT", body: new Uint8Array(Buffer.from("ciphertext")) }
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-cauli-checksum-sha256")).toBe(
      "a".repeat(64)
    );
    // The server verified the certificate rather than merely receiving bytes.
    expect(received).toEqual([
      { method: "PUT", url: `/objects/${objectName}`, authorized: true },
    ]);
  });

  it("is refused when it brings no certificate the receiver trusts", async () => {
    await expect(
      mutualTlsFetch(
        credentials({
          clientCertificatePem: pem("stranger.crt"),
          clientKeyPem: pem("stranger.key"),
        })
      )(`${baseUrl}/objects/${objectName}`, { method: "GET" })
    ).rejects.toThrow();
  });

  it("refuses a receiver that is not the pinned one", async () => {
    // Trusting only the impostor CA means the real receiver is now the
    // impostor, and the connection must not be made.
    await expect(
      mutualTlsFetch(
        credentials({ certificateAuthorityPem: pem("impostor-ca.crt") })
      )(`${baseUrl}/objects/${objectName}`, { method: "GET" })
    ).rejects.toThrow();
  });

  it("aborts a request that exceeds its bounded upload window", async () => {
    await expect(
      mutualTlsFetch(credentials())(`${baseUrl}/slow`, {
        method: "PUT",
        body: new Uint8Array(Buffer.from("ciphertext")),
        signal: AbortSignal.timeout(10),
      })
    ).rejects.toThrow(/abort/i);
  });

  it("carries a real backup and a real deletion end to end", async () => {
    received = [];
    const created = await createBackupObject(credentials(), {
      objectName,
      ciphertext: Buffer.from("encrypted Source Audio"),
      manifest: Buffer.from("encrypted manifest"),
      kmsWrappedKey: "kms-wrapped",
      ageWrappedKey: "age-wrapped",
      keyVersion: 1,
      ciphertextSha256: "a".repeat(64),
    });
    expect(created.created).toBe(true);

    const { deleteBackupObject } = await import("./retention.js");
    await deleteBackupObject(credentials(), objectName);

    expect(received.map((entry) => entry.method)).toEqual(["PUT", "DELETE"]);
    expect(received.every((entry) => entry.authorized)).toBe(true);
  });
});
