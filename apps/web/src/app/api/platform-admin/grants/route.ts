import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isPlatformAdminAuthError,
  requirePlatformAdminApiAuth,
} from "@/lib/server/platform-auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const grantSchema = z.object({
  workspaceId: z.uuid(),
  callId: z.uuid().nullable(),
  reason: z.string().trim().min(10).max(500),
  minutes: z.number().int().min(1).max(60),
});

function platformError(error: { message: string }) {
  if (/Fresh Platform Admin MFA/i.test(error.message)) {
    return NextResponse.json(
      {
        error: "Confirm your authenticator to continue",
        reassert: true,
        location: "/auth/mfa?platform=1&next=/platform-admin",
      },
      { status: 401 }
    );
  }
  const status = /not found|does not belong|does not exist/i.test(error.message)
    ? 404
    : 400;
  return NextResponse.json({ error: sanitizeError(error) }, { status });
}

export async function POST(request: Request) {
  const auth = await requirePlatformAdminApiAuth();
  if (isPlatformAdminAuthError(auth)) return auth;
  const parsed = await parseJson(request, grantSchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  const expiresAt = new Date(
    Date.now() + parsed.data.minutes * 60_000
  ).toISOString();
  const { data, error } = await supabase.rpc("grant_break_glass_access", {
    target_workspace_id: parsed.data.workspaceId,
    target_call_id: parsed.data.callId,
    target_reason: parsed.data.reason,
    target_expires_at: expiresAt,
  });
  if (error) return platformError(error);
  const grant = Array.isArray(data) ? data[0] : data;
  return NextResponse.json(
    {
      id: grant.id,
      workspaceId: grant.workspace_id,
      callId: grant.call_id,
      expiresAt: grant.expires_at,
    },
    { status: 201 }
  );
}

export async function DELETE(request: Request) {
  const auth = await requirePlatformAdminApiAuth();
  if (isPlatformAdminAuthError(auth)) return auth;
  const id = new URL(request.url).searchParams.get("id");
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(
      { error: "Grant id is required" },
      { status: 400 }
    );
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("revoke_break_glass_access", {
    target_grant_id: parsedId.data,
  });
  if (error) return platformError(error);
  return new NextResponse(null, { status: 204 });
}
