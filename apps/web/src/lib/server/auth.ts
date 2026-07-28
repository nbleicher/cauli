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

export async function getAuthContext(): Promise<AuthContext | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

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
  if (!context) redirect(isSupabaseConfigured() ? "/login" : "/setup");
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

export async function requireApiAuth(
  allowedRoles?: Role[]
): Promise<AuthContext | NextResponse> {
  const context = await getAuthContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
