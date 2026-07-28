import type { Role, WorkspaceMember } from "@calllog/shared";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { secondFactorRequirement } from "@/lib/server/mfa-policy";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

export interface AuthContext {
  user: {
    id: string;
    email: string;
  };
  member: WorkspaceMember;
  /** A Recovery Code was redeemed and no replacement factor is verified yet. */
  mfaRecoveryPending: boolean;
}

export type SessionLockReason = "inactivity" | "absolute";

/**
 * Reads why the current session is locked without recording activity. Only the
 * failure path needs this, so the ordinary request pays nothing for it.
 */
export async function getSessionLockReason(): Promise<SessionLockReason | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc("session_lock_reason");
  return data === "inactivity" || data === "absolute" ? data : null;
}

export async function getAuthContext(): Promise<AuthContext | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Marks the session in use and reports if it has aged out. The database
  // applies the same verdict to every policy, so a locked session cannot get
  // further by talking to PostgREST instead of to this application.
  const { data: lockReason } = await supabase.rpc("touch_session_activity");
  if (lockReason) return null;

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id, user_id, role, mfa_recovery_pending_at")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (!membership) return null;
  return {
    user: {
      id: user.id,
      email: user.email ?? "",
    },
    member: {
      workspaceId: membership.workspace_id,
      userId: membership.user_id,
      role: membership.role as Role,
    },
    mfaRecoveryPending: Boolean(membership.mfa_recovery_pending_at),
  };
}

// True when the user has a verified second factor but has not presented it on
// this session. Enforced on the server: a client-side check would be trivially
// bypassed by calling the API directly.
async function getSecondFactorRequirement(context: AuthContext) {
  const supabase = await createServerSupabaseClient();
  return secondFactorRequirement(
    context.member.role,
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    context.mfaRecoveryPending
  );
}

// Assurance is settled before anything else a signed-in page offers, including
// Legal Document acceptance: accepting current versions is a record bound to
// the account, so a password alone must not be able to produce one for a Role
// that requires a second factor.
export async function requirePageSecondFactor(context: AuthContext) {
  const secondFactor = await getSecondFactorRequirement(context);
  if (secondFactor === "enrollment_required") {
    redirect("/auth/mfa?enroll=required");
  }
  if (secondFactor === "verification_required") redirect("/auth/mfa");
  if (secondFactor === "unavailable") {
    redirect("/auth/mfa?verification=unavailable");
  }
}

export async function requirePageAuth() {
  const context = await getAuthContext();
  if (!context) {
    if (!isSupabaseConfigured()) redirect("/setup");
    const lockReason = await getSessionLockReason();
    redirect(lockReason ? `/login?locked=${lockReason}` : "/login");
  }
  await requirePageSecondFactor(context);
  const supabase = await createServerSupabaseClient();
  const { data: legalReady, error: legalError } = await supabase.rpc(
    "legal_gate_satisfied_for_current_user"
  );
  if (legalError || !legalReady) redirect("/legal/acceptance");
  return context;
}

/** The request-shaped counterpart to requirePageSecondFactor. */
export async function secondFactorApiError(context: AuthContext) {
  const secondFactor = await getSecondFactorRequirement(context);
  if (secondFactor === "enrollment_required") {
    return NextResponse.json(
      { error: "Verified TOTP enrollment required" },
      { status: 401 }
    );
  }
  if (secondFactor === "verification_required") {
    return NextResponse.json(
      { error: "Second factor required" },
      { status: 401 }
    );
  }
  if (secondFactor === "unavailable") {
    return NextResponse.json(
      { error: "Unable to verify second-factor assurance" },
      { status: 503 }
    );
  }
  return null;
}

// How recently a second factor must have been presented for an action that
// changes who holds authority. Short enough that a walked-away session cannot
// be used to grant access, long enough not to interrupt one sitting of work.
const freshMfaWindow = "15 minutes";

/**
 * Guards an action that alters authority. Returns a response to send when the
 * caller's second factor is too old to stand behind it, telling the client to
 * re-assert rather than leaving it to guess.
 */
export async function requireFreshMfa() {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc("recent_mfa_assertion", {
    max_age: freshMfaWindow,
  });
  if (data === true) return null;
  return NextResponse.json(
    {
      error: "Confirm your authenticator to continue",
      reassert: true,
    },
    { status: 401 }
  );
}

export async function requireApiAuth(
  allowedRoles?: Role[]
): Promise<AuthContext | NextResponse> {
  const context = await getAuthContext();
  if (!context) {
    const lockReason = await getSessionLockReason();
    return NextResponse.json(
      {
        error: lockReason ? "Session locked. Sign in again." : "Unauthorized",
      },
      { status: 401 }
    );
  }
  const secondFactorError = await secondFactorApiError(context);
  if (secondFactorError) return secondFactorError;
  const supabase = await createServerSupabaseClient();
  const { data: legalReady, error: legalError } = await supabase.rpc(
    "legal_gate_satisfied_for_current_user"
  );
  if (legalError || !legalReady) {
    return NextResponse.json(
      { error: "Current Legal Document acceptance is required" },
      { status: 403 }
    );
  }
  if (allowedRoles && !allowedRoles.includes(context.member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return context;
}

export function isAuthError(
  value: AuthContext | NextResponse
): value is NextResponse {
  return value instanceof NextResponse;
}
