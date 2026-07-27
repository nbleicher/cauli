import { roleSchema } from "@calllog/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { publicEnv } from "@/lib/env";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const inviteSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  role: roleSchema,
});

export async function POST(request: Request) {
  const auth = await requireApiAuth(["admin"]);
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, inviteSchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  const { data: inviteId, error: inviteError } = await supabase.rpc(
    "create_workspace_invite",
    {
      target_email: parsed.data.email,
      target_role: parsed.data.role,
    }
  );

  if (inviteError) {
    return NextResponse.json(
      { error: sanitizeError(inviteError) },
      { status: 500 }
    );
  }

  const { error: identityError } = await supabase.functions.invoke(
    "identity-admin",
    {
      body: {
        action: "invite",
        inviteId,
        redirectTo: `${publicEnv.appUrl}/auth/callback`,
      },
    }
  );
  if (identityError) {
    return NextResponse.json(
      { error: sanitizeError(identityError) },
      { status: 500 }
    );
  }

  return NextResponse.json({ inviteId }, { status: 201 });
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

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("revoke_workspace_invite", {
    target_invite_id: inviteId,
  });
  if (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    return NextResponse.json({ error: sanitizeError(error) }, { status });
  }
  return new NextResponse(null, { status: 204 });
}
