import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthError, requireApiAuth } from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const transitionSchema = z.object({
  action: z.enum(["resolve", "verify"]),
  expectedVersion: z.number().int().positive(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth();
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, transitionSchema);
  if (parsed.error) return parsed.error;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Follow-up not found" }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    parsed.data.action === "resolve" ? "resolve_follow_up" : "verify_follow_up",
    {
      target_follow_up_id: id,
      expected_version: parsed.data.expectedVersion,
    }
  );
  if (error) {
    return NextResponse.json(
      { error: sanitizeError(error) },
      {
        status: /version conflict/i.test(error.message)
          ? 409
          : /not found/i.test(error.message)
            ? 404
            : 403,
      }
    );
  }
  return NextResponse.json({ followUp: data });
}
