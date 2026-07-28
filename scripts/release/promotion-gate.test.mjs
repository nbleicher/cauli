import assert from "node:assert/strict";
import test from "node:test";
import {
  validatePromotionEvidence,
  verifyHumanGates,
} from "./promotion-gate.mjs";

const complete = {
  image: `ghcr.io/nbleicher/cauli@sha256:${"b".repeat(64)}`,
  commitSha: "c".repeat(40),
  preMigrationTimestamp: "2026-07-27T12:00:00Z",
  stagingEvidence: "staging-candidate-1",
  regionEvidence: "region-evidence-1",
  principalDenialEvidence: "principal-matrix-1",
  securityHeaderEvidence: "header-check-1",
  vulnerabilityEvidence: "trivy-run-1",
  manualSignoffEvidence: "release-signoff-1",
  recoveryDrillEvidence: "recovery-drills-1",
};

test("requires every production evidence category", () => {
  assert.doesNotThrow(() => validatePromotionEvidence(complete));
  assert.throws(
    () => validatePromotionEvidence({ ...complete, regionEvidence: "" }),
    /regionEvidence/
  );
  assert.throws(
    () => validatePromotionEvidence({ ...complete, recoveryDrillEvidence: "" }),
    /recoveryDrillEvidence/
  );
});

test("requires all human gates to be closed", async () => {
  const fetchImpl = async (url) =>
    new Response(
      JSON.stringify({ state: url.endsWith("/43") ? "open" : "closed" }),
      { status: 200 }
    );
  await assert.rejects(
    verifyHumanGates({
      repository: "nbleicher/cauli",
      token: "test",
      fetchImpl,
    }),
    /#43 is still open/
  );
});
