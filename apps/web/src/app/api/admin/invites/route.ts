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
    .upsert(
      {
        workspace_id: auth.member.workspaceId,
        email: parsed.data.email,
        role: parsed.data.role,
        invited_by: auth.user.id,
        accepted_at: null,
        expires_at: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000
        ).toISOString(),
      },
      { onConflict: "workspace_id,email" }
    )
    .select("id")
    .single();

  if (inviteError) {
    return NextResponse.json(
      { error: sanitizeError(inviteError) },
      { status: 500 }
    );
  }

  const { data: invited, error: authError } =
    await admin.auth.admin.inviteUserByEmail(parsed.data.email, {
      redirectTo: `${publicEnv.appUrl}/auth/callback`,
    });

  if (
    authError &&
    !/already been registered|already exists/i.test(authError.message)
  ) {
    return NextResponse.json(
      { error: sanitizeError(authError) },
      { status: 500 }
    );
  }

  let invitedUserId = invited.user?.id ?? null;
  if (!invitedUserId && authError) {
    const { data: existingProfile } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", parsed.data.email)
      .maybeSingle();
    invitedUserId = existingProfile?.id ?? null;
  }

  if (invitedUserId) {
    const { error: membershipError } = await admin
      .from("workspace_members")
      .upsert(
        {
          workspace_id: auth.member.workspaceId,
          user_id: invitedUserId,
          role: parsed.data.role,
          invited_by: auth.user.id,
        },
        { onConflict: "workspace_id,user_id" }
      );
    if (membershipError) {
      return NextResponse.json(
        { error: sanitizeError(membershipError) },
        {
          status: membershipError.code === "23505" ? 409 : 500,
        }
      );
    }
    await admin
      .from("workspace_invites")
      .update({
        accepted_at: new Date().toISOString(),
      })
      .eq("id", invite.id);
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

export async function DELETE(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const inviteId = new URL(request.url).searchParams.get("id");
  if (!inviteId) {
    return NextResponse.json(
      { error: "Invite id is required" },
      { status: 400 }
    );
  }

  const admin = createAdminSupabaseClient();
  const { data: invite, error } = await admin
    .from("workspace_invites")
    .delete()
    .eq("id", inviteId)
    .eq("workspace_id", auth.member.workspaceId)
    .is("accepted_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
  if (!invite) {
    return NextResponse.json(
      { error: "Pending invite not found" },
      { status: 404 }
    );
  }

  await admin.from("audit_events").insert({
    workspace_id: auth.member.workspaceId,
    actor_id: auth.user.id,
    action: "workspace.invite.revoked",
    entity_type: "workspace_invite",
    entity_id: invite.id,
  });
  return new NextResponse(null, { status: 204 });
}
