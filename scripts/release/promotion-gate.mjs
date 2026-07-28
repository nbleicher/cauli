#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { validateReleaseImage } from "./railway-image.mjs";

const humanGateIssues = [41, 42, 43, 44];
const evidenceFields = [
  "stagingEvidence",
  "regionEvidence",
  "principalDenialEvidence",
  "securityHeaderEvidence",
  "vulnerabilityEvidence",
  "manualSignoffEvidence",
  // Recovery is proven before promotion, not after an incident.
  "recoveryDrillEvidence",
];

export function validatePromotionEvidence(input) {
  validateReleaseImage(input.image);
  if (!/^[a-f0-9]{40}$/.test(input.commitSha)) {
    throw new Error("Promotion requires the exact 40-character main commit");
  }
  const timestamp = new Date(input.preMigrationTimestamp);
  if (Number.isNaN(timestamp.valueOf()) || timestamp > new Date()) {
    throw new Error(
      "Promotion requires a valid pre-migration recovery timestamp"
    );
  }
  for (const field of evidenceFields) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      throw new Error(`Promotion evidence is missing ${field}`);
    }
  }
}

export async function verifyHumanGates({
  repository,
  token,
  fetchImpl = fetch,
}) {
  for (const issue of humanGateIssues) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/issues/${issue}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!response.ok) {
      throw new Error(`Unable to verify human gate #${issue}`);
    }
    const result = await response.json();
    if (result.state !== "closed") {
      throw new Error(`Human gate #${issue} is still open`);
    }
  }
}

async function run() {
  validatePromotionEvidence({
    image: process.env.CAULI_RELEASE_IMAGE ?? "",
    commitSha: process.env.CAULI_RELEASE_COMMIT ?? "",
    preMigrationTimestamp: process.env.PRE_MIGRATION_TIMESTAMP ?? "",
    stagingEvidence: process.env.STAGING_EVIDENCE ?? "",
    regionEvidence: process.env.REGION_EVIDENCE ?? "",
    principalDenialEvidence: process.env.PRINCIPAL_DENIAL_EVIDENCE ?? "",
    securityHeaderEvidence: process.env.SECURITY_HEADER_EVIDENCE ?? "",
    vulnerabilityEvidence: process.env.VULNERABILITY_EVIDENCE ?? "",
    manualSignoffEvidence: process.env.MANUAL_SIGNOFF_EVIDENCE ?? "",
    recoveryDrillEvidence: process.env.RECOVERY_DRILL_EVIDENCE ?? "",
  });
  await verifyHumanGates({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
  });
  console.log("Production promotion evidence and human gates are complete.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
