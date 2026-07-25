import type { Role, WorkspaceMember } from "@calllog/shared";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

export interface AuthContext {
  user: {
    id: string;
    email: string;
  };
  member: WorkspaceMember;
}

export async function getAuthContext(): Promise<AuthContext | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id, user_id, role")
    .eq("user_id", user.id)
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
  };
}

// True when the user has a verified second factor but has not presented it on
// this session. Enforced on the server: a client-side check would be trivially
// bypassed by calling the API directly.
async function needsSecondFactor() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}

export async function requirePageAuth() {
  const context = await getAuthContext();
  if (!context) redirect(isSupabaseConfigured() ? "/login" : "/setup");
  if (await needsSecondFactor()) redirect("/auth/mfa");
  return context;
}

export async function requireApiAuth(
  allowedRoles?: Role[],
): Promise<AuthContext | NextResponse> {
  const context = await getAuthContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (await needsSecondFactor()) {
    return NextResponse.json({ error: "Second factor required" }, { status: 401 });
  }
  if (allowedRoles && !allowedRoles.includes(context.member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return context;
}

export function isAuthError(
  value: AuthContext | NextResponse,
): value is NextResponse {
  return value instanceof NextResponse;
}
