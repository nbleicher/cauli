import { createScorecardTemplateSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const publishSchema = createScorecardTemplateSchema.extend({
  templateId: z.uuid().nullable().default(null),
});

export async function POST(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, publishSchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "publish_scorecard_for_current_admin",
    {
      target_template_id: parsed.data.templateId,
      target_name: parsed.data.name,
      target_categories: parsed.data.categories,
    }
  );

  if (error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  return NextResponse.json({ scorecardVersionId: data }, { status: 201 });
}
