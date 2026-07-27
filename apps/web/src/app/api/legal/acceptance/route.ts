import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const acceptanceSchema = z.object({
  versionIds: z.array(z.uuid()).min(2).max(4),
});

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = await parseJson(request, acceptanceSchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("accept_current_legal_documents", {
    target_version_ids: parsed.data.versionIds,
  });
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 409 });
  }
  return NextResponse.json({ accepted: data });
}
