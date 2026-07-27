#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";

const TEXT_EXTENSIONS = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const EXCLUDED_PATHS = new Set([
  // This superseded ADR is retained as architectural history. ADR 0017 is the
  // accepted launch decision and the product must follow it.
  "docs/adr/0016-prohibit-unapproved-regulated-workloads.md",
  // Positive examples below are scanner self-tests, not product claims.
  "scripts/check-regulated-claims.mjs",
]);

const REGIME =
  "(?:SOC ?2|ISO ?27001|HIPAA|PCI(?: DSS)?|FedRAMP|CUI|FERPA|COPPA|GLBA|GDPR(?:-specific)?)";

const UNSUPPORTED_CLAIMS = [
  new RegExp(
    `\\b${REGIME}\\b.{0,30}\\b(?:certified|compliant|approved|ready|exempt)\\b`,
    "i"
  ),
  new RegExp(
    `\\b(?:certified|compliant|approved|ready|exempt)\\b.{0,30}\\b${REGIME}\\b`,
    "i"
  ),
  /\b(?:Cauli|the (?:service|platform|product|pilot)|we)\s+(?:is|are|has been|have been)\s+(?:independently\s+)?(?:certified|compliant|approved|regulated-use ready|exempt)\b/i,
  /\b(?:regulated workloads?|regulated-use workloads?).{0,40}\b(?:are prohibited|are forbidden|are not permitted|must not be used)\b/i,
];

const NEGATED_OR_POLICY_CONTEXT =
  /\b(?:not|no|never|without|does not|do not|must not|cannot|has not|have not|isn't|aren't|avoid|reject|unsupported|does not represent|do not represent)\b/i;

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to enumerate tracked files");
  }
  return result.stdout.split("\0").filter(Boolean);
}

function violationsFor(path, contents) {
  const violations = [];
  const lines = contents.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const context = `${lines[index - 1] ?? ""} ${line}`;
    if (NEGATED_OR_POLICY_CONTEXT.test(context)) continue;
    if (UNSUPPORTED_CLAIMS.some((pattern) => pattern.test(line))) {
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  return violations;
}

const selfTests = [
  ["Cauli is HIPAA compliant.", 1],
  ["Cauli is certified for PCI DSS.", 1],
  [
    "Cauli’s pilot has not been independently assessed, certified, or contractually approved for HIPAA.",
    0,
  ],
  ["Do not claim that Cauli is GDPR compliant.", 0],
];

for (const [line, expected] of selfTests) {
  const actual = violationsFor("<self-test>", line).length;
  if (actual !== expected) {
    throw new Error(`Claim-scanner self-test failed for: ${line}`);
  }
}

const violations = [];
for (const path of trackedFiles()) {
  if (
    EXCLUDED_PATHS.has(path) ||
    !TEXT_EXTENSIONS.has(extname(path)) ||
    !existsSync(path)
  )
    continue;
  const contents = readFileSync(path, "utf8");
  violations.push(...violationsFor(path, contents));
}

if (violations.length > 0) {
  console.error("Unsupported regulated-use claims found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Regulated-use claim scan passed.");
