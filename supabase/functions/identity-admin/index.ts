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

interface ListMfaStatusRequest {
  action: "list_mfa_status";
}

interface IssueRecoveryCodesRequest {
  action: "issue_recovery_codes";
}

interface RedeemRecoveryCodeRequest {
  action: "redeem_recovery_code";
  password: string;
  code: string;
}

type IdentityAdminRequest =
  | InviteRequest
  | ResetMfaRequest
  | PasswordResetRequest
  | ListMfaStatusRequest
  | IssueRecoveryCodesRequest
  | RedeemRecoveryCodeRequest;

const recoveryCodeCount = 10;
// Ambiguous glyphs are omitted so a code read off paper cannot be mistyped
// into a different valid-looking code.
const recoveryCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

/**
 * Reads the assurance level the caller actually presented. The SDK's
 * getAuthenticatorAssuranceLevel() reads a stored session, and this function
 * is handed a bearer token instead of one, so it would always report "no
 * session" here. The token itself is authenticated separately by getUser()
 * before this claim is trusted.
 */
function bearerAssuranceLevel(authorization: string) {
  const payload = authorization.replace(/^Bearer\s+/i, "").split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const claims = JSON.parse(decoded) as { aal?: unknown };
    return typeof claims.aal === "string" ? claims.aal : null;
  } catch {
    return null;
  }
}

/** 32 divides 256, so masking a random byte picks a character without bias. */
function generateRecoveryCode() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const characters = Array.from(
    bytes,
    (byte) => recoveryCodeAlphabet[byte & 31]
  ).join("");
  return [
    characters.slice(0, 4),
    characters.slice(4, 8),
    characters.slice(8, 12),
  ].join("-");
}

/** Accepts the code however it was transcribed: spaced, unspaced, lower case. */
function normalizeRecoveryCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function keyedRecoveryHash(code: string, key: string) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    material,
    encoder.encode(normalizeRecoveryCode(code))
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Compares two hex digests without letting the position of the first
 * mismatching character show up in the response time. */
function constantTimeEquals(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** The address the request arrived from, as the proxy reported it. */
function callerAddress(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
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
  const recoveryCodeKey = Deno.env.get("MFA_RECOVERY_CODE_KEY") ?? "";
  const authorization = request.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !recoveryCodeKey) {
    return jsonResponse({ error: "Identity service is not configured" }, 503);
  }
  if (!authorization) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const candidate = (await request.json()) as { action?: unknown };
    if (
      candidate.action !== "invite" &&
      candidate.action !== "reset_mfa" &&
      candidate.action !== "request_password_reset" &&
      candidate.action !== "list_mfa_status" &&
      candidate.action !== "issue_recovery_codes" &&
      candidate.action !== "redeem_recovery_code"
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
      const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // Throttled per address and origin together, and answered exactly like an
      // accepted request: revealing the limit would reveal the address.
      const { data: allowance } = await admin.rpc("consume_rate_limit", {
        target_bucket: "auth.password_reset",
        target_subject: `${email}|${callerAddress(request)}`,
        max_attempts: 5,
        target_window: "1 hour",
      });
      if (allowance !== "allowed") {
        return jsonResponse({ accepted: true }, 202);
      }

      const anonymous = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false },
      });
      await anonymous.auth.resetPasswordForEmail(email, {
        redirectTo: redirect.toString(),
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

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Recovery Codes belong to the Workspace Member, not to Workspace Admin
    // authority, so both actions are settled before the Admin gate below.
    if (body.action === "issue_recovery_codes") {
      if (bearerAssuranceLevel(authorization) !== "aal2") {
        return jsonResponse(
          { error: "A verified second factor is required" },
          401
        );
      }
      const codes = Array.from({ length: recoveryCodeCount }, () =>
        generateRecoveryCode()
      );
      const hashes = await Promise.all(
        codes.map((code) => keyedRecoveryHash(code, recoveryCodeKey))
      );
      const { error: replaceError } = await admin.rpc(
        "replace_mfa_recovery_codes",
        { target_user_id: user.id, target_code_hashes: hashes }
      );
      if (replaceError) throw replaceError;
      // The only time these values leave the service.
      return jsonResponse({ codes }, 201);
    }

    if (body.action === "redeem_recovery_code") {
      // Repeated failures close recovery for an hour. Checked before the
      // password so a lockout cannot be used to test passwords either.
      const { data: locked, error: lockedError } = await admin.rpc(
        "mfa_recovery_locked",
        { target_user_id: user.id }
      );
      if (lockedError) throw lockedError;
      if (locked) {
        return jsonResponse({ error: "Recovery could not be verified" }, 401);
      }

      // The session alone is not enough: a Recovery Code only authorizes a
      // factor replacement once the password has been proven again.
      const anonymous = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false },
      });
      const { error: passwordError } = await anonymous.auth.signInWithPassword({
        email: user.email ?? "",
        password: body.password ?? "",
      });
      if (passwordError) {
        return jsonResponse({ error: "Recovery could not be verified" }, 401);
      }

      const presented = await keyedRecoveryHash(
        body.code ?? "",
        recoveryCodeKey
      );
      const { data: candidates, error: candidatesError } = await admin.rpc(
        "active_mfa_recovery_codes",
        { target_user_id: user.id }
      );
      if (candidatesError) throw candidatesError;

      // Every candidate is compared, so neither the matching position nor the
      // number of remaining codes is observable in the response time.
      let matchedId: string | null = null;
      for (const candidate of (candidates ?? []) as {
        id: string;
        code_hash: string;
      }[]) {
        if (constantTimeEquals(candidate.code_hash, presented)) {
          matchedId = candidate.id;
        }
      }

      if (!matchedId) {
        const { error: failureError } = await admin.rpc(
          "register_mfa_recovery_failure",
          { target_user_id: user.id }
        );
        if (failureError) throw failureError;
        return jsonResponse({ error: "Recovery could not be verified" }, 401);
      }

      const { data: remaining, error: consumeError } = await admin.rpc(
        "consume_mfa_recovery_code",
        { target_code_id: matchedId }
      );
      if (consumeError) throw consumeError;
      if (remaining === null) {
        // Another request consumed the same code first.
        return jsonResponse({ error: "Recovery could not be verified" }, 401);
      }

      const { data: factors, error: factorsError } =
        await admin.auth.admin.mfa.listFactors({ userId: user.id });
      if (factorsError) throw factorsError;
      for (const factor of factors?.factors ?? []) {
        const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
          userId: user.id,
          id: factor.id,
        });
        if (deleteError) throw deleteError;
      }

      return jsonResponse({ recovered: true, codesRemaining: remaining });
    }

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
    if (bearerAssuranceLevel(authorization) !== "aal2") {
      return jsonResponse(
        { error: "Verified TOTP MFA is required for Workspace Admin actions" },
        401
      );
    }

    if (body.action === "list_mfa_status") {
      const { data: members, error: membersError } = await admin
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", membership.workspace_id);
      if (membersError) throw membersError;
      const statuses = [];
      for (const member of members ?? []) {
        const { data: factors, error: factorsError } =
          await admin.auth.admin.mfa.listFactors({
            userId: member.user_id,
          });
        if (factorsError) throw factorsError;
        statuses.push({
          userId: member.user_id,
          enabled: (factors?.factors ?? []).some(
            (factor) => factor.status === "verified"
          ),
        });
      }
      return jsonResponse({ statuses });
    }

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
      // A reset removes every factor, so self-service would let one compromised
      // AAL2 session drop the Workspace Admin back to a single factor and
      // re-enroll an attacker's authenticator. Replacing your own inaccessible
      // factor is Recovery Code work, not an Admin action against yourself.
      if (body.userId === user.id) {
        return jsonResponse(
          { error: "Another Workspace Admin must reset your authenticator" },
          403
        );
      }
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

      const { error: initiationAuditError } = await admin.rpc(
        "record_audit_event",
        {
          target_workspace_id: membership.workspace_id,
          target_actor_id: user.id,
          target_action: "workspace.member.mfa_reset_initiated",
          target_entity_type: "workspace_member",
          target_entity_id: body.userId,
          target_metadata: {},
        }
      );
      if (initiationAuditError) throw initiationAuditError;

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
        target_action: "workspace.member.mfa_reset_completed",
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
