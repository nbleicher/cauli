import { request } from "node:https";
import { Readable } from "node:stream";

/**
 * A `fetch`-shaped client that actually presents a client certificate.
 *
 * Node's global `fetch` is undici, and undici only accepts an undici
 * `Dispatcher` — handing it a `node:https.Agent` throws `agent.dispatch is not a
 * function` before a single byte is sent. Every call would have failed in
 * production while passing in tests, which inject their own `fetch`. So the
 * transport that carries Source Audio to the VPS is built on `node:https`
 * directly, where `cert`, `key`, and `ca` mean what they say.
 */

export interface MutualTlsCredentials {
  clientCertificatePem: string;
  clientKeyPem: string;
  /** The receiver's own CA, so the worker will not talk to an impostor. */
  certificateAuthorityPem: string;
}

export function mutualTlsFetch(
  credentials: MutualTlsCredentials
): typeof fetch {
  return async function mutualTlsRequest(input, init) {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.protocol !== "https:") {
      throw new Error("Mutual TLS requires HTTPS");
    }

    const headers = new Headers(init?.headers);
    const body = init?.body;
    const payload =
      body === undefined || body === null
        ? null
        : Buffer.isBuffer(body)
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : Buffer.from(String(body));

    return new Promise<Response>((resolve, reject) => {
      const clientRequest = request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: Object.fromEntries(headers.entries()),
          cert: credentials.clientCertificatePem,
          key: credentials.clientKeyPem,
          ca: credentials.certificateAuthorityPem,
          // The pinned CA is the whole point; never fall back to the system
          // trust store, and never accept an unverified peer.
          rejectUnauthorized: true,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode ?? 500;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) responseHeaders.append(name, item);
              } else if (value !== undefined) {
                responseHeaders.set(name, value);
              }
            }
            // 204 and 304 must not carry a body.
            const content =
              status === 204 || status === 304
                ? null
                : new Uint8Array(Buffer.concat(chunks));
            resolve(
              new Response(content, { status, headers: responseHeaders })
            );
          });
        }
      );

      clientRequest.on("error", reject);
      if (payload) {
        clientRequest.end(payload);
      } else if (body instanceof Readable) {
        body.pipe(clientRequest);
      } else {
        clientRequest.end();
      }
    });
  };
}
