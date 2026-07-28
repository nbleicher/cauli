import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const comparabilitySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("combine"),
    versionIds: z.array(z.uuid()).min(2).max(100),
  }),
  z.object({
    action: z.literal("revoke"),
    comparisonSetId: z.uuid(),
  }),
]);

export async function POST(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, comparabilitySchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  if (parsed.data.action === "combine") {
    const { data, error } = await supabase.rpc(
      "mark_scorecard_versions_comparable",
      { target_version_ids: parsed.data.versionIds }
    );
    if (error) {
      return NextResponse.json(
        { error: sanitizeError(error) },
        { status: 409 }
      );
    }
    return NextResponse.json({ comparisonSetId: data }, { status: 201 });
  }

  const { error } = await supabase.rpc(
    "revoke_scorecard_version_comparability",
    { target_comparison_set_id: parsed.data.comparisonSetId }
  );
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
