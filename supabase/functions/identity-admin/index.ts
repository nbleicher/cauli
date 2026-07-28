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

interface PasswordResetRequest {
  action: "request_password_reset";
  email: string;
  redirectTo: string;
}

type IdentityAdminRequest =
  InviteRequest | ResetMfaRequest | PasswordResetRequest;

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
  console.error(
    "identity.operation_failed",
    error instanceof Error ? error.name : "UnknownError"
  );
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
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Identity service is not configured" }, 503);
  }
  if (!authorization) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const candidate = (await request.json()) as { action?: unknown };
    if (
      candidate.action !== "invite" &&
      candidate.action !== "reset_mfa" &&
      candidate.action !== "request_password_reset"
    ) {
      return jsonResponse({ error: "Unsupported identity action" }, 400);
    }
    const body = candidate as IdentityAdminRequest;
    if (body.action === "request_password_reset") {
      const configuredOrigin = new URL(
        Deno.env.get("APP_URL") ?? "http://127.0.0.1:3102"
      ).origin;
      const redirect = new URL(body.redirectTo);
      if (redirect.origin !== configuredOrigin) {
        return jsonResponse({ accepted: true }, 202);
      }
      const email = body.email.trim().toLowerCase();
      const anonymous = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false },
      });
      await anonymous.auth.resetPasswordForEmail(email, {
        redirectTo: redirect.toString(),
      });

      const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: profile } = await admin
        .from("profiles")
        .select("id")
        .ilike("email", email)
        .maybeSingle();
      if (profile) {
        const { data: membership } = await admin
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", profile.id)
          .eq("status", "active")
          .maybeSingle();
        if (membership) {
          await admin.rpc("record_audit_event", {
            target_workspace_id: membership.workspace_id,
            target_actor_id: profile.id,
            target_action: "auth.password_reset.requested",
            target_entity_type: "workspace_member",
            target_entity_id: profile.id,
            target_metadata: {},
          });
        }
      }
      return jsonResponse({ accepted: true }, 202);
    }

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
      const configuredOrigin = new URL(
        Deno.env.get("APP_URL") ?? "http://127.0.0.1:3102"
      ).origin;
      const redirect = new URL(body.redirectTo);
      if (redirect.origin !== configuredOrigin) {
        return jsonResponse({ error: "Invalid invitation redirect" }, 400);
      }
      const { data: invite, error: inviteError } = await admin
        .from("workspace_invites")
        .select("id, workspace_id, email, role, invited_by, accepted_at")
        .eq("id", body.inviteId)
        .eq("workspace_id", membership.workspace_id)
        .maybeSingle();
      if (inviteError) throw inviteError;
      if (!invite) return jsonResponse({ error: "Invitation not found" }, 404);

      const { data: invited, error: authError } =
        await admin.auth.admin.inviteUserByEmail(invite.email, {
          redirectTo: redirect.toString(),
        });
      if (
        authError &&
        !/already been registered|already exists/i.test(authError.message)
      ) {
        throw authError;
      }

      return jsonResponse(
        { invited: true, userId: invited.user?.id ?? null },
        201
      );
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
  } catch (error) {
    return jsonResponse({ error: safeMessage(error) }, 500);
  }
});
