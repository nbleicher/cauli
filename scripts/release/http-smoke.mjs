#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const exactHeaders = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function assertSecurityResponse(
  response,
  { cspMode, hstsExpected = false }
) {
  for (const [name, expected] of Object.entries(exactHeaders)) {
    if (response.headers.get(name) !== expected) {
      throw new Error(`${name} did not match the release contract`);
    }
  }
  const cspName =
    cspMode === "report-only"
      ? "content-security-policy-report-only"
      : "content-security-policy";
  const csp = response.headers.get(cspName) ?? "";
  if (
    !/script-src 'self' 'nonce-[A-Za-z0-9+/=_-]+' 'strict-dynamic'/.test(csp)
  ) {
    throw new Error("CSP is missing a per-request nonce and strict-dynamic");
  }
  const scriptPolicy = csp.match(/script-src ([^;]+)/)?.[1] ?? "";
  if (
    scriptPolicy.includes("'unsafe-inline'") ||
    scriptPolicy.includes("'unsafe-eval'")
  ) {
    throw new Error("Production CSP contains an unsafe script fallback");
  }
  for (const directive of [
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]) {
    if (!csp.includes(directive)) {
      throw new Error(`CSP is missing ${directive}`);
    }
  }
  const hsts = response.headers.get("strict-transport-security");
  if (hstsExpected && hsts !== "max-age=31536000; includeSubDomains") {
    throw new Error("HSTS is not enabled with the accepted one-year policy");
  }
  if (!hstsExpected && hsts) {
    throw new Error("HSTS includeSubDomains was enabled before acceptance");
  }
  return csp.match(/'nonce-([^']+)'/)?.[1] ?? "";
}

async function run() {
  const appUrl = new URL(process.env.CAULI_APP_URL ?? "");
  const loginOrigin = new URL(process.env.CAULI_LOGIN_ORIGIN ?? appUrl.origin)
    .origin;
  const cspMode =
    process.env.EXPECTED_CSP_MODE === "report-only" ? "report-only" : "enforce";
  const options = {
    cspMode,
    hstsExpected: process.env.HSTS_EXPECTED === "true",
  };

  const [first, second, health] = await Promise.all([
    fetch(appUrl),
    fetch(appUrl),
    fetch(new URL("/api/health", appUrl)),
  ]);
  if (!first.ok || !second.ok || !health.ok) {
    throw new Error("Public site or health endpoint is not healthy");
  }
  const firstNonce = assertSecurityResponse(first, options);
  const secondNonce = assertSecurityResponse(second, options);
  if (!firstNonce || firstNonce === secondNonce) {
    throw new Error("CSP nonce was not unique per request");
  }
  const html = await first.text();
  const expectedLogin = new URL("/login", loginOrigin).toString();
  if (!html.includes(expectedLogin)) {
    throw new Error("Public Log in does not target the configured app origin");
  }
  console.log("Release HTTP, public login, and browser-header smoke passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
