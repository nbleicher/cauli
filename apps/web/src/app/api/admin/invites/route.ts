import { roleSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { publicEnv } from "@/lib/env";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";

const inviteSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  role: roleSchema,
});

export async function POST(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, inviteSchema);
  if (parsed.error) return parsed.error;

  const admin = createAdminSupabaseClient();
  const { data: invite, error: inviteError } = await admin
    .from("workspace_invites")
    .upsert({
      workspace_id: auth.member.workspaceId,
      email: parsed.data.email,
      role: parsed.data.role,
      invited_by: auth.user.id,
      accepted_at: null,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: "workspace_id,email" })
    .select("id")
    .single();

  if (inviteError) {
    return NextResponse.json({ error: sanitizeError(inviteError) }, { status: 500 });
  }

  const { data: invited, error: authError } = await admin.auth.admin.inviteUserByEmail(
    parsed.data.email,
    { redirectTo: `${publicEnv.appUrl}/auth/callback` },
  );

  if (authError && !/already been registered|already exists/i.test(authError.message)) {
    return NextResponse.json({ error: sanitizeError(authError) }, { status: 500 });
  }

  if (invited.user) {
    await admin.from("workspace_members").upsert({
      workspace_id: auth.member.workspaceId,
      user_id: invited.user.id,
      role: parsed.data.role,
      invited_by: auth.user.id,
    }, { onConflict: "workspace_id,user_id" });
  }

  await admin.from("audit_events").insert({
    workspace_id: auth.member.workspaceId,
    actor_id: auth.user.id,
    action: "workspace.invite.created",
    entity_type: "workspace_invite",
    entity_id: invite.id,
    metadata: { role: parsed.data.role },
  });

  return NextResponse.json({ inviteId: invite.id }, { status: 201 });
}
