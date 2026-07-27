import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const schema = z.object({ inviteId: z.uuid() });

export async function POST(request: Request) {
  const parsed = await parseJson(request, schema);
  if (parsed.error) return parsed.error;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { error } = await supabase.rpc("activate_workspace_invitation", {
    target_invite_id: parsed.data.inviteId,
  });
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 409 });
  }
  return NextResponse.json({ activated: true });
}
