import assert from "node:assert/strict";
import test from "node:test";
import { assertSecurityResponse } from "./http-smoke.mjs";

function response(overrides = {}) {
  return new Response("", {
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'nonce-test123' 'strict-dynamic'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "microphone=(self)",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...overrides,
    },
  });
}

test("accepts the exact enforced header contract", () => {
  assert.equal(
    assertSecurityResponse(response(), {
      cspMode: "enforce",
      hstsExpected: false,
    }),
    "test123"
  );
});

test("rejects unsafe production script execution", () => {
  assert.throws(
    () =>
      assertSecurityResponse(
        response({
          "Content-Security-Policy":
            "script-src 'self' 'nonce-test123' 'strict-dynamic' 'unsafe-eval'; style-src-attr 'unsafe-inline'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        }),
        { cspMode: "enforce" }
      ),
    /unsafe/
  );
});
