import assert from "node:assert/strict";
import test from "node:test";
import { deployRailwayImage, validateReleaseImage } from "./railway-image.mjs";

const image = `ghcr.io/nbleicher/cauli@sha256:${"a".repeat(64)}`;

test("requires an exact Cauli image digest", () => {
  assert.equal(validateReleaseImage(image), image);
  assert.throws(
    () => validateReleaseImage("ghcr.io/nbleicher/cauli:latest"),
    /pinned by digest/
  );
});

test("updates the image and Virginia region before waiting for health", async () => {
  const requests = [];
  const responses = [
    { data: { serviceInstanceUpdate: true } },
    { data: { serviceInstanceDeployV2: "deployment-1" } },
    { data: { deployment: { id: "deployment-1", status: "DEPLOYING" } } },
    { data: { deployment: { id: "deployment-1", status: "SUCCESS" } } },
  ];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  };
  const result = await deployRailwayImage({
    token: "test-token",
    serviceId: "service",
    environmentId: "environment",
    image,
    startCommand: "node apps/web/server.js",
    healthcheckPath: "/api/health",
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.status, "SUCCESS");
  assert.equal(
    requests[0].variables.input.multiRegionConfig["us-east4-eqdc4a"]
      .numReplicas,
    1
  );
  assert.equal(requests[0].variables.input.source.image, image);
});
