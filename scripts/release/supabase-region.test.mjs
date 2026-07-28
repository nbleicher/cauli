import assert from "node:assert/strict";
import test from "node:test";
import { verifySupabaseRegion } from "./supabase-region.mjs";

test("accepts only the approved persistent Supabase region", async () => {
  const accepted = await verifySupabaseRegion({
    token: "test",
    projectRef: "project",
    fetchImpl: async () =>
      new Response(JSON.stringify({ region: "us-east-1" }), { status: 200 }),
  });
  assert.equal(accepted, "us-east-1");

  await assert.rejects(
    verifySupabaseRegion({
      token: "test",
      projectRef: "project",
      fetchImpl: async () =>
        new Response(JSON.stringify({ region: "eu-west-1" }), { status: 200 }),
    }),
    /not us-east-1/
  );
});
