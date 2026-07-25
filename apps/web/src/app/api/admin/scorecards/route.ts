import { createScorecardTemplateSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";

const publishSchema = createScorecardTemplateSchema.extend({
  templateId: z.uuid().nullable().default(null),
});

export async function POST(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, publishSchema);
  if (parsed.error) return parsed.error;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc("publish_scorecard", {
    target_workspace_id: auth.member.workspaceId,
    target_template_id: parsed.data.templateId,
    target_name: parsed.data.name,
    target_actor_id: auth.user.id,
    target_categories: parsed.data.categories,
  });

  if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  return NextResponse.json({ scorecardVersionId: data }, { status: 201 });
}
