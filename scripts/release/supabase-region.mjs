#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export async function verifySupabaseRegion({
  token,
  projectRef,
  fetchImpl = fetch,
}) {
  if (!token || !projectRef) {
    throw new Error("Supabase region verification is not configured");
  }
  const response = await fetchImpl(
    `https://api.supabase.com/v1/projects/${projectRef}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!response.ok) {
    throw new Error(`Supabase Management API returned HTTP ${response.status}`);
  }
  const project = await response.json();
  if (project.region !== "us-east-1") {
    throw new Error(
      `Supabase project region ${project.region ?? "unknown"} is not us-east-1`
    );
  }
  return project.region;
}

async function run() {
  const region = await verifySupabaseRegion({
    token: process.env.SUPABASE_ACCESS_TOKEN ?? "",
    projectRef: process.env.SUPABASE_PROJECT_REF ?? "",
  });
  console.log(`Supabase persistent region verified as ${region}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
