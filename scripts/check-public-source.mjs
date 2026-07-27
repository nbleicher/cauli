#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REQUIRED_FILES = [
  "CONTEXT.md",
  "NOTICE",
  "SECURITY.md",
  "docs/product/controlled-pilot-production-readiness.md",
  "docs/operations/human-production-readiness-runbook.md",
  "docs/product/controlled-pilot-ticket-map.md",
  "docs/adr/0007-main-is-the-production-source.md",
  "docs/adr/0008-public-source-remains-proprietary.md",
];

const FORBIDDEN_TRACKED_PATH =
  /(^|\/)(?:\.context|\.env(?:\.|$)|\.next|\.railway|\.temp|\.vercel|artifacts|coverage|dist|node_modules|playwright-report|test-results|tmp)(?:\/|$)|\.(?:age|key|log|p12|pem|zip)$/i;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

for (const path of REQUIRED_FILES) {
  if (!existsSync(path))
    fail(`Required public-source file is missing: ${path}`);
}

const filesResult = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (filesResult.status !== 0) {
  throw new Error(filesResult.stderr || "Unable to enumerate tracked files");
}

const trackedFiles = filesResult.stdout.split("\0").filter(Boolean);
for (const path of trackedFiles) {
  if (FORBIDDEN_TRACKED_PATH.test(path)) {
    fail(
      `Machine-local, secret-bearing, or release artifact is tracked: ${path}`
    );
  }
}

const openSourceLicense = trackedFiles.find((path) =>
  /(^|\/)(?:licen[cs]e|copying)(?:\.|$)/i.test(path)
);
if (openSourceLicense) {
  fail(
    `Unexpected license file requires operator review: ${openSourceLicense}`
  );
}

const callsPage = readFileSync("apps/web/src/app/(app)/calls/page.tsx", "utf8");
if (/ExtensionImport|extension-import/i.test(callsPage)) {
  fail("The production Calls page still exposes the legacy extension import.");
}

for (const path of ["docs/DEPLOYMENT.md"]) {
  const contents = readFileSync(path, "utf8");
  if (/extension-import|migration bridge|companion extension/i.test(contents)) {
    fail(`Production documentation still advertises legacy import: ${path}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Public-source release checks passed.");
