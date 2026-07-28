#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const endpoint = "https://backboard.railway.com/graphql/v2";
const approvedRegion = "us-east4-eqdc4a";

export function validateReleaseImage(image) {
  if (!/^ghcr\.io\/nbleicher\/cauli@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(
      "Release image must be the Cauli GHCR image pinned by digest"
    );
  }
  return image;
}

async function graphql(token, query, variables, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Project-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Railway API returned HTTP ${response.status}`);
  }
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(
      `Railway API rejected the operation: ${result.errors
        .map((error) => error.message)
        .join("; ")}`
    );
  }
  return result.data;
}

export async function deployRailwayImage({
  token,
  serviceId,
  environmentId,
  image,
  startCommand,
  healthcheckPath,
  fetchImpl = fetch,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxPolls = 120,
}) {
  validateReleaseImage(image);
  if (!token || !serviceId || !environmentId || !startCommand) {
    throw new Error("Railway deployment configuration is incomplete");
  }

  await graphql(
    token,
    `
      mutation UpdateReleaseService(
        $serviceId: String!
        $environmentId: String!
        $input: ServiceInstanceUpdateInput!
      ) {
        serviceInstanceUpdate(
          serviceId: $serviceId
          environmentId: $environmentId
          input: $input
        )
      }
    `,
    {
      serviceId,
      environmentId,
      input: {
        source: { image },
        startCommand,
        healthcheckPath,
        healthcheckTimeout: 300,
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 10,
        multiRegionConfig: {
          [approvedRegion]: { numReplicas: 1 },
        },
      },
    },
    fetchImpl
  );

  const deployment = await graphql(
    token,
    `
      mutation DeployReleaseService(
        $serviceId: String!
        $environmentId: String!
      ) {
        serviceInstanceDeployV2(
          serviceId: $serviceId
          environmentId: $environmentId
        )
      }
    `,
    { serviceId, environmentId },
    fetchImpl
  );
  const deploymentId = deployment.serviceInstanceDeployV2;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const result = await graphql(
      token,
      `
        query ReleaseDeployment($id: String!) {
          deployment(id: $id) {
            id
            status
          }
        }
      `,
      { id: deploymentId },
      fetchImpl
    );
    const status = result.deployment.status;
    if (status === "SUCCESS") return { deploymentId, status };
    if (["FAILED", "CRASHED", "REMOVED"].includes(status)) {
      throw new Error(`Railway deployment ${deploymentId} ended as ${status}`);
    }
    await sleep(5_000);
  }
  throw new Error(`Railway deployment ${deploymentId} did not become healthy`);
}

async function run() {
  const result = await deployRailwayImage({
    token: process.env.RAILWAY_PROJECT_TOKEN ?? "",
    serviceId: process.env.RAILWAY_SERVICE_ID ?? "",
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? "",
    image: process.env.CAULI_RELEASE_IMAGE ?? "",
    startCommand: process.env.RAILWAY_START_COMMAND ?? "",
    healthcheckPath: process.env.RAILWAY_HEALTHCHECK_PATH ?? "/health",
  });
  console.log(
    `Railway deployment ${result.deploymentId} is healthy and pinned to the requested digest.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
