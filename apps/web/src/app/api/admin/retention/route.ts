import { setRetentionPolicySchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function PATCH(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, setRetentionPolicySchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "set_workspace_retention_days_for_current_admin",
    { target_retention_days: parsed.data.retentionDays }
  );

  if (error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  return NextResponse.json({ retentionDays: data });
}
