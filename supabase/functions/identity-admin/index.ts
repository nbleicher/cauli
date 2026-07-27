import { createClient } from "npm:@supabase/supabase-js@2.110.8";

interface InviteRequest {
  action: "invite";
  inviteId: string;
  redirectTo: string;
}

interface ResetMfaRequest {
  action: "reset_mfa";
  userId: string;
}

type IdentityAdminRequest = InviteRequest | ResetMfaRequest;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function safeMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Identity administration failed";
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authorization = request.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !authorization) {
    return jsonResponse({ error: "Identity service is not configured" }, 503);
  }

  try {
    const body = (await request.json()) as IdentityAdminRequest;
    const caller = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const {
      data: { user },
      error: userError,
    } = await caller.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

    const { data: membership, error: membershipError } = await caller
      .from("workspace_members")
      .select("workspace_id, role, status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .eq("role", "admin")
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) {
      return jsonResponse(
        { error: "Active Workspace Admin access is required" },
        403
      );
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    if (body.action === "invite") {
      const { data: invite, error: inviteError } = await admin
        .from("workspace_invites")
        .select("id, workspace_id, email, role, invited_by, accepted_at")
        .eq("id", body.inviteId)
        .eq("workspace_id", membership.workspace_id)
        .single();
      if (inviteError) throw inviteError;

      const { data: invited, error: authError } =
        await admin.auth.admin.inviteUserByEmail(invite.email, {
          redirectTo: body.redirectTo,
        });
      if (
        authError &&
        !/already been registered|already exists/i.test(authError.message)
      ) {
        throw authError;
      }

      let invitedUserId = invited.user?.id ?? null;
      if (!invitedUserId) {
        const { data: existingProfile, error: profileError } = await admin
          .from("profiles")
          .select("id")
          .ilike("email", invite.email)
          .maybeSingle();
        if (profileError) throw profileError;
        invitedUserId = existingProfile?.id ?? null;
      }

      if (invitedUserId) {
        const { data: previousMembership } = await admin
          .from("workspace_members")
          .select("role, status")
          .eq("workspace_id", invite.workspace_id)
          .eq("user_id", invitedUserId)
          .maybeSingle();

        const { error: upsertError } = await admin
          .from("workspace_members")
          .upsert(
            {
              workspace_id: invite.workspace_id,
              user_id: invitedUserId,
              role: invite.role,
              status: "active",
              status_changed_at: new Date().toISOString(),
              status_changed_by: user.id,
              invited_by: invite.invited_by,
            },
            { onConflict: "workspace_id,user_id" }
          );
        if (upsertError) throw upsertError;

        if (
          previousMembership &&
          (previousMembership.status !== "active" ||
            previousMembership.role !== invite.role)
        ) {
          const action =
            previousMembership.status !== "active"
              ? "workspace.member.activated"
              : "workspace.member.role_changed";
          const { error: auditError } = await admin.rpc("record_audit_event", {
            target_workspace_id: invite.workspace_id,
            target_actor_id: user.id,
            target_action: action,
            target_entity_type: "workspace_member",
            target_entity_id: invitedUserId,
            target_metadata: {
              previous_role: previousMembership.role,
              new_role: invite.role,
              previous_status: previousMembership.status,
              new_status: "active",
            },
          });
          if (auditError) throw auditError;
        }

        const { error: acceptError } = await admin
          .from("workspace_invites")
          .update({ accepted_at: new Date().toISOString() })
          .eq("id", invite.id);
        if (acceptError) throw acceptError;
      }

      return jsonResponse({ invited: true, userId: invitedUserId }, 201);
    }

    if (body.action === "reset_mfa") {
      const { data: targetMembership, error: targetError } = await admin
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", membership.workspace_id)
        .eq("user_id", body.userId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!targetMembership) {
        return jsonResponse({ error: "Not a member of this Workspace" }, 404);
      }

      const { data: factors, error: listError } =
        await admin.auth.admin.mfa.listFactors({ userId: body.userId });
      if (listError) throw listError;

      let removed = 0;
      for (const factor of factors?.factors ?? []) {
        const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
          userId: body.userId,
          id: factor.id,
        });
        if (deleteError) throw deleteError;
        removed += 1;
      }

      const { error: auditError } = await admin.rpc("record_audit_event", {
        target_workspace_id: membership.workspace_id,
        target_actor_id: user.id,
        target_action: "workspace.member.mfa_reset",
        target_entity_type: "workspace_member",
        target_entity_id: body.userId,
        target_metadata: { factors_removed: removed },
      });
      if (auditError) throw auditError;
      return jsonResponse({ removed });
    }

    return jsonResponse({ error: "Unsupported identity action" }, 400);
  } catch (error) {
    return jsonResponse({ error: safeMessage(error) }, 500);
  }
});
