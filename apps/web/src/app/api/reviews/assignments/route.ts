import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isAuthError,
  requireApiAuth,
  requireFreshMfa,
} from "@/lib/server/auth";
import { parseJson, sanitizeError } from "@/lib/server/http";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const assignmentSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("claim"),
    callId: z.uuid(),
  }),
  z.object({
    action: z.literal("assign"),
    callId: z.uuid(),
    assigneeId: z.uuid(),
    expectedAssignmentVersion: z.number().int().min(0),
  }),
  z.object({
    action: z.literal("bulkAssign"),
    callIds: z.array(z.uuid()).min(1).max(250),
    assigneeId: z.uuid(),
  }),
]);

export async function POST(request: Request) {
  const auth = await requireApiAuth(["manager", "admin"]);
  if (isAuthError(auth)) return auth;
  const parsed = await parseJson(request, assignmentSchema);
  if (parsed.error) return parsed.error;

  const supabase = await createServerSupabaseClient();
  if (parsed.data.action === "claim") {
    const { data, error } = await supabase.rpc("claim_review", {
      target_call_id: parsed.data.callId,
    });
    if (error) {
      return NextResponse.json(
        { error: sanitizeError(error) },
        { status: /already assigned/i.test(error.message) ? 409 : 403 }
      );
    }
    return NextResponse.json({ assignment: data }, { status: 201 });
  }

  if (auth.member.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const freshMfaError = await requireFreshMfa();
  if (freshMfaError) return freshMfaError;

  if (parsed.data.action === "assign") {
    const { data, error } = await supabase.rpc("assign_review", {
      target_call_id: parsed.data.callId,
      target_assignee_id: parsed.data.assigneeId,
      expected_assignment_version: parsed.data.expectedAssignmentVersion,
    });
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
    return NextResponse.json({ assignment: data });
  }

  const { data, error } = await supabase.rpc("bulk_assign_unassigned_reviews", {
    target_call_ids: parsed.data.callIds,
    target_assignee_id: parsed.data.assigneeId,
  });
  if (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 403 });
  }
  return NextResponse.json({ assignments: data });
}
