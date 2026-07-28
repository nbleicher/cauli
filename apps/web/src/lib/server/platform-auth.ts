import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { secondFactorRequirement } from "@/lib/server/mfa-policy";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type PlatformEnvironment = "staging" | "production";

export interface PlatformAdminContext {
  user: {
    id: string;
    email: string;
  };
  environment: PlatformEnvironment;
}

export async function getPlatformAdminIdentity(): Promise<PlatformAdminContext | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: environment, error } = await supabase.rpc(
    "platform_admin_identity"
  );
  if (error || (environment !== "staging" && environment !== "production")) {
    return null;
  }
  return {
    user: { id: user.id, email: user.email ?? "" },
    environment,
  };
}

async function platformSecondFactorRequirement() {
  const supabase = await createServerSupabaseClient();
  return secondFactorRequirement(
    "admin",
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  );
}

function platformMfaLocation(requirement: string) {
  if (requirement === "enrollment_required") {
    return "/auth/mfa?enroll=required&platform=1&next=/platform-admin";
  }
  return "/auth/mfa?platform=1&next=/platform-admin";
}

async function touchPlatformSession() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("touch_platform_admin_session");
  return { lockReason: data as string | null, error };
}

export async function requirePlatformAdminPageAuth() {
  const context = await getPlatformAdminIdentity();
  if (!context) {
    if (!isSupabaseConfigured()) redirect("/setup");
    redirect("/platform-login");
  }
  const secondFactor = await platformSecondFactorRequirement();
  if (secondFactor !== "satisfied") {
    if (secondFactor === "unavailable") {
      redirect("/platform-login?security=unavailable");
    }
    redirect(platformMfaLocation(secondFactor));
  }
  const { lockReason, error } = await touchPlatformSession();
  if (error || lockReason) {
    redirect(
      `/platform-login?locked=${encodeURIComponent(lockReason ?? "security")}`
    );
  }
  return context;
}

export async function requirePlatformAdminApiAuth(): Promise<
  PlatformAdminContext | NextResponse
> {
  const context = await getPlatformAdminIdentity();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const secondFactor = await platformSecondFactorRequirement();
  if (secondFactor !== "satisfied") {
    return NextResponse.json(
      {
        error: "Platform Admin MFA is required",
        reassert: true,
        location: platformMfaLocation(secondFactor),
      },
      { status: 401 }
    );
  }
  const { lockReason, error } = await touchPlatformSession();
  if (error || lockReason) {
    return NextResponse.json(
      { error: "Platform Admin session locked" },
      { status: 401 }
    );
  }
  return context;
}

export function isPlatformAdminAuthError(
  value: PlatformAdminContext | NextResponse
): value is NextResponse {
  return value instanceof NextResponse;
}
