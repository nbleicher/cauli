import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const localUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const zeroUuid = "00000000-0000-0000-0000-000000000000";

process.env.NEXT_PUBLIC_SUPABASE_URL = localUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
process.env.OPENROUTER_API_KEY = "integration-test-key";

const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
const createdCallIds: string[] = [];
const createdJobIds: string[] = [];
const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdScorecardTemplateIds: string[] = [];

async function deleteAuthUser(userId: string) {
  let lastError: { message: string; status?: number } | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (!error) return;
    lastError = error;
    if (error.status && error.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError ?? new Error("Auth user cleanup failed");
}

afterEach(async () => {
  if (createdJobIds.length) {
    await admin
      .from("processing_jobs")
      .delete()
      .in("id", createdJobIds.splice(0));
  }
  if (createdCallIds.length) {
    await admin.from("calls").delete().in("id", createdCallIds.splice(0));
  }
  if (createdScorecardTemplateIds.length) {
    const { error: scorecardCleanupError } = await admin
      .from("scorecard_templates")
      .delete()
      .in("id", createdScorecardTemplateIds.splice(0));
    if (scorecardCleanupError) throw scorecardCleanupError;
  }
  const userIds = createdUserIds.splice(0);
  if (userIds.length) {
    const { error: inviteCleanupError } = await admin
      .from("workspace_invites")
      .delete()
      .in("invited_by", userIds);
    if (inviteCleanupError) throw inviteCleanupError;
    const { error: membershipCleanupError } = await admin
      .from("workspace_members")
      .delete()
      .in("user_id", userIds);
    if (membershipCleanupError) throw membershipCleanupError;
  }
  for (const userId of userIds) {
    await deleteAuthUser(userId);
  }
  if (createdWorkspaceIds.length) {
    await admin
      .from("workspaces")
      .delete()
      .in("id", createdWorkspaceIds.splice(0));
  }
  await admin
    .from("workspaces")
    .update({ legal_gate_required: false })
    .eq("id", workspaceId);
  // Rate-limit counters are Workspace- and Call-scoped, so one test's spending
  // would otherwise be charged to the next.
  await admin.from("rate_limit_state").delete().neq("bucket", "");
  // Budgets, the daily ledger, and the once-per-day warning claim are all
  // Workspace-scoped state that would otherwise leak into the next test.
  await admin.from("processing_spend").delete().neq("workspace_id", zeroUuid);
  await admin
    .from("workspace_processing_budget")
    .delete()
    .neq("workspace_id", zeroUuid);
  await admin.from("processing_budget_warnings").delete().neq("scope_key", "");
  await admin.from("platform_admins").delete().neq("user_id", zeroUuid);
  // Timing evidence outlives the job it describes, which is the point of it,
  // so one test's runs must not become the next test's service level.
  await admin.from("processing_runs").delete().neq("workspace_id", zeroUuid);
  await admin
    .from("platform_processing_budget")
    .update({ daily_limit_usd: 50, warning_ratio: 0.8 })
    .eq("singleton", true);
});

async function createWorkspaceMember(
  role: "member" | "manager" | "admin" = "member",
  targetWorkspaceId = workspaceId,
  verifyPrivilegedMfa = true
) {
  const password = `Test-${crypto.randomUUID()}!`;
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email: `database-contract-${crypto.randomUUID()}@example.com`,
      password,
      email_confirm: true,
    });
  if (createError) throw createError;
  createdUserIds.push(created.user.id);

  const { error: membershipError } = await admin
    .from("workspace_members")
    .insert({
      workspace_id: targetWorkspaceId,
      user_id: created.user.id,
      role,
    });
  if (membershipError) throw membershipError;

  const client = createClient(localUrl, anonKey, {
    auth: { persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email: created.user.email!,
    password,
  });
  if (signInError) throw signInError;
  if (role !== "member" && verifyPrivilegedMfa) {
    const { data: enrollment, error: enrollmentError } =
      await client.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `database-contract-${crypto.randomUUID()}`,
      });
    if (enrollmentError) throw enrollmentError;
    const { data: challenge, error: challengeError } =
      await client.auth.mfa.challenge({ factorId: enrollment.id });
    if (challengeError) throw challengeError;
    const { error: verificationError } = await client.auth.mfa.verify({
      factorId: enrollment.id,
      challengeId: challenge.id,
      code: totpCode(enrollment.totp.secret),
    });
    if (verificationError) throw verificationError;
  }
  return { client, userId: created.user.id };
}

function totpCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.toUpperCase().replaceAll("=", "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

function ms(span: string) {
  const units: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
  };
  const amount = Number.parseInt(span, 10);
  return amount * units[span.slice(-1)]!;
}

/**
 * Audit Events are immutable, so they outlive every test that produced them.
 * Anchoring on the last identifier before a test starts scopes an assertion to
 * that test's own evidence without depending on the database clock.
 */
async function latestAuditEventId() {
  const { data } = await admin
    .from("audit_events")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as number | undefined) ?? 0;
}

async function createCall(
  userId: string,
  overrides: Record<string, unknown> = {}
) {
  const callId = crypto.randomUUID();
  const chunkPrefix = `${workspaceId}/${callId}/chunks`;
  const { error } = await admin.from("calls").insert({
    id: callId,
    workspace_id: workspaceId,
    owner_id: userId,
    source_mode: "both",
    chunk_prefix: chunkPrefix,
    recording_attested_by: userId,
    recording_attested_at: new Date().toISOString(),
    ...overrides,
  });
  if (error) throw error;
  createdCallIds.push(callId);
  return { callId, chunkPrefix };
}

describe.skipIf(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)("database authorization and durability contracts", () => {
  it("keeps optional scoring and Scorecard Version comparability explicit", async () => {
    const workspaceAdmin = await createWorkspaceMember("admin");
    const manager = await createWorkspaceMember("manager");
    const owner = await createWorkspaceMember("member");

    const categories = [
      {
        name: "Discovery",
        criteria: [
          {
            label: "Required discovery",
            description: "",
            weight: 1,
            required: true,
          },
          {
            label: "Optional next step",
            description: "",
            weight: 100,
            required: false,
          },
        ],
      },
    ];
    const { data: firstVersionId, error: firstPublishError } =
      await workspaceAdmin.client.rpc("publish_scorecard_for_current_admin", {
        target_template_id: null,
        target_name: "Database contract Scorecard",
        target_categories: categories,
      });
    expect(firstPublishError).toBeNull();

    const { data: firstVersion, error: firstVersionError } = await admin
      .from("scorecard_versions")
      .select("id, template_id, name")
      .eq("id", firstVersionId)
      .single();
    if (firstVersionError) throw firstVersionError;
    createdScorecardTemplateIds.push(firstVersion.template_id);
    expect(firstVersion.name).toBe("Database contract Scorecard");

    const { data: firstCategories, error: firstCategoriesError } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", firstVersion.id);
    if (firstCategoriesError) throw firstCategoriesError;
    const { data: firstCriteria, error: firstCriteriaError } = await admin
      .from("scorecard_criteria")
      .select("id, label, required, weight")
      .in(
        "category_id",
        (firstCategories ?? []).map((category) => category.id)
      )
      .order("position");
    if (firstCriteriaError) throw firstCriteriaError;
    const requiredCriterion = firstCriteria?.find(
      (criterion) => criterion.required
    );
    const optionalCriterion = firstCriteria?.find(
      (criterion) => !criterion.required
    );
    if (!requiredCriterion || !optionalCriterion) {
      throw new Error("Expected required and optional criteria");
    }

    const firstCall = await createCall(owner.userId, { status: "ready" });
    const { error: firstClaimError } = await manager.client.rpc(
      "claim_review",
      { target_call_id: firstCall.callId }
    );
    expect(firstClaimError).toBeNull();
    const { data: firstReview, error: firstReviewError } =
      await manager.client.rpc("submit_call_review_with_follow_up", {
        target_call_id: firstCall.callId,
        target_scorecard_version_id: firstVersion.id,
        expected_version: 0,
        expected_assignment_version: 1,
        target_status: "reviewed",
        target_summary: "Optional criterion is not applicable.",
        target_follow_up: "",
        target_follow_up_due_date: null,
        target_answers: [
          {
            criterionId: requiredCriterion.id,
            value: 5,
            comment: "Complete",
          },
          {
            criterionId: optionalCriterion.id,
            value: null,
            comment: "Not applicable",
          },
        ],
      });
    expect(firstReviewError).toBeNull();
    expect(firstReview.score).toBe(100);

    const secondCall = await createCall(owner.userId, { status: "ready" });
    const { error: secondClaimError } = await manager.client.rpc(
      "claim_review",
      { target_call_id: secondCall.callId }
    );
    expect(secondClaimError).toBeNull();
    const { error: requiredNaError } = await manager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        target_call_id: secondCall.callId,
        target_scorecard_version_id: firstVersion.id,
        expected_version: 0,
        expected_assignment_version: 1,
        target_status: "reviewed",
        target_summary: "Required criterion cannot be N/A.",
        target_follow_up: "",
        target_follow_up_due_date: null,
        target_answers: [
          {
            criterionId: requiredCriterion.id,
            value: null,
            comment: "",
          },
        ],
      }
    );
    expect(requiredNaError?.message).toMatch(/required criteria/i);

    const { error: immutableCriterionError } = await admin
      .from("scorecard_criteria")
      .update({ label: "Mutated publication" })
      .eq("id", requiredCriterion.id);
    expect(immutableCriterionError?.message).toMatch(/immutable/i);
    const { error: immutableVersionError } = await admin
      .from("scorecard_versions")
      .delete()
      .eq("id", firstVersion.id);
    expect(immutableVersionError?.message).toMatch(/immutable/i);

    const { data: secondVersionId, error: secondPublishError } =
      await workspaceAdmin.client.rpc("publish_scorecard_for_current_admin", {
        target_template_id: firstVersion.template_id,
        target_name: "Database contract Scorecard",
        target_categories: [
          {
            ...categories[0],
            criteria: [
              ...categories[0]!.criteria,
              {
                label: "Optional wrap-up",
                description: "",
                weight: 3,
                required: false,
              },
            ],
          },
        ],
      });
    expect(secondPublishError).toBeNull();

    const { data: boundReview } = await admin
      .from("call_reviews")
      .select("scorecard_version_id")
      .eq("id", firstReview.id)
      .single();
    expect(boundReview?.scorecard_version_id).toBe(firstVersion.id);
    const { data: preservedCriterion } = await admin
      .from("scorecard_criteria")
      .select("label")
      .eq("id", requiredCriterion.id)
      .single();
    expect(preservedCriterion?.label).toBe("Required discovery");

    const { data: secondVersionCategories } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", secondVersionId);
    const { data: secondVersionCriteria } = await admin
      .from("scorecard_criteria")
      .select("id")
      .in(
        "category_id",
        (secondVersionCategories ?? []).map((category) => category.id)
      )
      .order("position");
    const thirdCall = await createCall(owner.userId, { status: "ready" });
    const { error: thirdClaimError } = await manager.client.rpc(
      "claim_review",
      { target_call_id: thirdCall.callId }
    );
    expect(thirdClaimError).toBeNull();
    const { error: thirdReviewError } = await manager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        target_call_id: thirdCall.callId,
        target_scorecard_version_id: secondVersionId,
        expected_version: 0,
        expected_assignment_version: 1,
        target_status: "reviewed",
        target_summary: "Second version review.",
        target_follow_up: "",
        target_follow_up_due_date: null,
        target_answers: (secondVersionCriteria ?? []).map((criterion) => ({
          criterionId: criterion.id,
          value: 4,
          comment: "",
        })),
      }
    );
    expect(thirdReviewError).toBeNull();

    const { data: defaultSegments } = await workspaceAdmin.client
      .from("review_score_segments")
      .select("scorecard_version_id, analytics_segment_id")
      .in("call_id", [firstCall.callId, thirdCall.callId])
      .order("scorecard_version_id");
    expect(
      new Set(
        (defaultSegments ?? []).map((segment) => segment.analytics_segment_id)
      ).size
    ).toBe(2);

    const { error: managerComparisonError } = await manager.client.rpc(
      "mark_scorecard_versions_comparable",
      { target_version_ids: [firstVersion.id, secondVersionId] }
    );
    expect(managerComparisonError?.message).toMatch(/admin access/i);

    const { data: comparisonSetId, error: comparisonError } =
      await workspaceAdmin.client.rpc("mark_scorecard_versions_comparable", {
        target_version_ids: [firstVersion.id, secondVersionId],
      });
    expect(comparisonError).toBeNull();

    const { data: combinedSegments } = await workspaceAdmin.client
      .from("review_score_segments")
      .select("analytics_segment_id")
      .in("call_id", [firstCall.callId, thirdCall.callId]);
    expect(
      new Set(
        (combinedSegments ?? []).map((segment) => segment.analytics_segment_id)
      )
    ).toEqual(new Set([comparisonSetId]));

    const { error: revokeError } = await workspaceAdmin.client.rpc(
      "revoke_scorecard_version_comparability",
      { target_comparison_set_id: comparisonSetId }
    );
    expect(revokeError).toBeNull();
    const { data: segmentedAgain } = await workspaceAdmin.client
      .from("review_score_segments")
      .select("analytics_segment_id")
      .in("call_id", [firstCall.callId, thirdCall.callId]);
    expect(
      new Set(
        (segmentedAgain ?? []).map((segment) => segment.analytics_segment_id)
      )
    ).toEqual(new Set([firstVersion.id, secondVersionId]));

    const { data: auditEvents } = await admin
      .from("audit_events")
      .select("action")
      .eq("workspace_id", workspaceId)
      .in("action", [
        "scorecard.version.published",
        "scorecard.versions.comparable",
        "scorecard.versions.comparability_revoked",
      ]);
    expect(new Set((auditEvents ?? []).map((event) => event.action))).toEqual(
      new Set([
        "scorecard.version.published",
        "scorecard.versions.comparable",
        "scorecard.versions.comparability_revoked",
      ])
    );
  });

  it("claims and assigns Reviews atomically within one Workspace", async () => {
    const workspaceAdmin = await createWorkspaceMember("admin");
    const firstManager = await createWorkspaceMember("manager");
    const secondManager = await createWorkspaceMember("manager");
    const owner = await createWorkspaceMember("member");

    const { data: scorecardVersionId, error: publishError } =
      await workspaceAdmin.client.rpc("publish_scorecard_for_current_admin", {
        target_template_id: null,
        target_name: "Assignment contract Scorecard",
        target_categories: [
          {
            name: "Quality",
            criteria: [
              {
                label: "Clear outcome",
                description: "",
                weight: 1,
                required: true,
              },
            ],
          },
        ],
      });
    expect(publishError).toBeNull();
    const { data: scorecardVersion } = await admin
      .from("scorecard_versions")
      .select("template_id")
      .eq("id", scorecardVersionId)
      .single();
    createdScorecardTemplateIds.push(scorecardVersion!.template_id);
    const { data: scorecardCategory } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", scorecardVersionId)
      .single();
    const { data: scorecardCriterion } = await admin
      .from("scorecard_criteria")
      .select("id")
      .eq("category_id", scorecardCategory!.id)
      .single();

    const claimedCall = await createCall(owner.userId, { status: "ready" });
    const concurrentClaims = await Promise.all([
      firstManager.client.rpc("claim_review", {
        target_call_id: claimedCall.callId,
      }),
      secondManager.client.rpc("claim_review", {
        target_call_id: claimedCall.callId,
      }),
    ]);
    expect(concurrentClaims.filter((claim) => !claim.error)).toHaveLength(1);
    expect(concurrentClaims.filter((claim) => claim.error)).toHaveLength(1);
    expect(
      concurrentClaims.find((claim) => claim.error)?.error?.message
    ).toMatch(/already assigned/i);

    const { data: claimedAssignment } = await admin
      .from("call_review_assignments")
      .select("assignee_id, version")
      .eq("call_id", claimedCall.callId)
      .single();
    expect(claimedAssignment?.version).toBe(1);

    const firstCanEdit = await firstManager.client.rpc("can_review_call", {
      target_call_id: claimedCall.callId,
    });
    const secondCanEdit = await secondManager.client.rpc("can_review_call", {
      target_call_id: claimedCall.callId,
    });
    expect(
      [firstCanEdit.data === true, secondCanEdit.data === true].filter(Boolean)
    ).toHaveLength(1);

    const assignedCall = await createCall(owner.userId, { status: "ready" });
    const { data: initialAssignment, error: assignmentError } =
      await workspaceAdmin.client.rpc("assign_review", {
        target_call_id: assignedCall.callId,
        target_assignee_id: firstManager.userId,
        expected_assignment_version: 0,
      });
    expect(assignmentError).toBeNull();
    expect(initialAssignment).toMatchObject({
      assignee_id: firstManager.userId,
      version: 1,
    });

    const { error: staleReassignmentError } = await workspaceAdmin.client.rpc(
      "assign_review",
      {
        target_call_id: assignedCall.callId,
        target_assignee_id: secondManager.userId,
        expected_assignment_version: 0,
      }
    );
    expect(staleReassignmentError?.message).toMatch(/version conflict/i);

    const { data: reassigned, error: reassignmentError } =
      await workspaceAdmin.client.rpc("assign_review", {
        target_call_id: assignedCall.callId,
        target_assignee_id: secondManager.userId,
        expected_assignment_version: 1,
      });
    expect(reassignmentError).toBeNull();
    expect(reassigned).toMatchObject({
      assignee_id: secondManager.userId,
      version: 2,
    });

    const { error: legacySubmissionBypassError } =
      await firstManager.client.rpc("submit_call_review", {
        target_call_id: assignedCall.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 0,
        target_status: "reviewed",
        target_summary: "Legacy overload must not bypass assignment.",
        target_follow_up: "",
        target_answers: [],
      });
    expect(legacySubmissionBypassError?.message).toMatch(
      /permission denied|could not find/i
    );

    const reviewPayload = {
      target_call_id: assignedCall.callId,
      target_scorecard_version_id: scorecardVersionId,
      expected_version: 0,
      target_status: "reviewed",
      target_summary: "Assignment concurrency is preserved.",
      target_follow_up: "",
      target_follow_up_due_date: null,
      target_answers: [
        {
          criterionId: scorecardCriterion!.id,
          value: 5,
          comment: "",
        },
      ],
    };
    const { error: staleEditorError } = await firstManager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        ...reviewPayload,
        expected_assignment_version: 1,
      }
    );
    expect(staleEditorError?.message).toMatch(/assignment version conflict/i);
    const { error: formerAssigneeError } = await firstManager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        ...reviewPayload,
        expected_assignment_version: 2,
      }
    );
    expect(formerAssigneeError?.message).toMatch(/only the Review Assignee/i);
    const { data: submittedReview, error: submitError } =
      await secondManager.client.rpc("submit_call_review_with_follow_up", {
        ...reviewPayload,
        expected_assignment_version: 2,
      });
    expect(submitError).toBeNull();
    expect(submittedReview).toMatchObject({
      call_id: assignedCall.callId,
      version: 1,
      status: "reviewed",
    });

    const firstBulkCall = await createCall(owner.userId, { status: "ready" });
    const secondBulkCall = await createCall(owner.userId, { status: "ready" });
    const preclaimedCall = await createCall(owner.userId, { status: "ready" });
    const stillUnassignedCall = await createCall(owner.userId, {
      status: "ready",
    });
    const { error: preclaimError } = await secondManager.client.rpc(
      "claim_review",
      { target_call_id: preclaimedCall.callId }
    );
    expect(preclaimError).toBeNull();

    const { data: bulkAssignments, error: bulkError } =
      await workspaceAdmin.client.rpc("bulk_assign_unassigned_reviews", {
        target_call_ids: [firstBulkCall.callId, secondBulkCall.callId],
        target_assignee_id: firstManager.userId,
      });
    expect(bulkError).toBeNull();
    expect(bulkAssignments).toHaveLength(2);

    const { data: staleFilteredBulk, error: staleFilteredBulkError } =
      await workspaceAdmin.client.rpc("bulk_assign_unassigned_reviews", {
        target_call_ids: [preclaimedCall.callId, stillUnassignedCall.callId],
        target_assignee_id: firstManager.userId,
      });
    expect(staleFilteredBulkError).toBeNull();
    expect(staleFilteredBulk).toHaveLength(1);
    expect(staleFilteredBulk?.[0]?.call_id).toBe(stillUnassignedCall.callId);
    const { data: preservedClaim } = await admin
      .from("call_review_assignments")
      .select("assignee_id")
      .eq("call_id", preclaimedCall.callId)
      .single();
    expect(preservedClaim?.assignee_id).toBe(secondManager.userId);

    const otherWorkspaceId = crypto.randomUUID();
    createdWorkspaceIds.push(otherWorkspaceId);
    const { error: otherWorkspaceError } = await admin
      .from("workspaces")
      .insert({
        id: otherWorkspaceId,
        name: "Other assignment Workspace",
        slug: `other-assignment-${otherWorkspaceId.slice(0, 8)}`,
      });
    if (otherWorkspaceError) throw otherWorkspaceError;
    const otherOwner = await createWorkspaceMember("member", otherWorkspaceId);
    const otherCall = await createCall(otherOwner.userId, {
      workspace_id: otherWorkspaceId,
      status: "ready",
      chunk_prefix: `${otherWorkspaceId}/${crypto.randomUUID()}/chunks`,
    });
    const rollbackCall = await createCall(owner.userId, { status: "ready" });
    const { error: crossWorkspaceBulkError } = await workspaceAdmin.client.rpc(
      "bulk_assign_unassigned_reviews",
      {
        target_call_ids: [rollbackCall.callId, otherCall.callId],
        target_assignee_id: firstManager.userId,
      }
    );
    expect(crossWorkspaceBulkError?.message).toMatch(/Admin Workspace/i);
    const { count: rollbackAssignmentCount } = await admin
      .from("call_review_assignments")
      .select("call_id", { count: "exact", head: true })
      .eq("call_id", rollbackCall.callId);
    expect(rollbackAssignmentCount).toBe(0);

    const { error: directCrossWorkspaceWrite } = await firstManager.client
      .from("call_review_assignments")
      .insert({
        call_id: otherCall.callId,
        workspace_id: otherWorkspaceId,
        assignee_id: firstManager.userId,
        assigned_by: firstManager.userId,
      });
    expect(directCrossWorkspaceWrite).not.toBeNull();

    const affectedBulkCallIds = [
      firstBulkCall.callId,
      secondBulkCall.callId,
      stillUnassignedCall.callId,
    ];
    const { data: auditEvents } = await admin
      .from("audit_events")
      .select("action, entity_id, metadata")
      .eq("workspace_id", workspaceId)
      .in("entity_id", [
        claimedCall.callId,
        assignedCall.callId,
        preclaimedCall.callId,
        ...affectedBulkCallIds,
      ]);
    expect(
      auditEvents?.some(
        (event) =>
          event.action === "review.claimed" &&
          event.entity_id === claimedCall.callId
      )
    ).toBe(true);
    expect(
      auditEvents?.some(
        (event) =>
          event.action === "review.assigned" &&
          event.entity_id === assignedCall.callId
      )
    ).toBe(true);
    expect(
      auditEvents?.some(
        (event) =>
          event.action === "review.reassigned" &&
          event.entity_id === assignedCall.callId
      )
    ).toBe(true);
    for (const callId of affectedBulkCallIds) {
      expect(
        auditEvents?.some(
          (event) =>
            event.action === "review.bulk_assigned" &&
            event.entity_id === callId &&
            typeof event.metadata.bulk_operation_id === "string"
        )
      ).toBe(true);
    }
  });

  it("preserves complete immutable Review Revision history with In Progress privacy", async () => {
    const workspaceAdmin = await createWorkspaceMember("admin");
    const manager = await createWorkspaceMember("manager");
    const owner = await createWorkspaceMember("member");
    const sameWorkspaceNonOwner = await createWorkspaceMember("member");

    const { data: scorecardVersionId, error: publishError } =
      await workspaceAdmin.client.rpc("publish_scorecard_for_current_admin", {
        target_template_id: null,
        target_name: "Revision history Scorecard",
        target_categories: [
          {
            name: "Quality",
            criteria: [
              {
                label: "Required outcome",
                description: "",
                weight: 3,
                required: true,
              },
              {
                label: "Optional detail",
                description: "",
                weight: 1,
                required: false,
              },
            ],
          },
        ],
      });
    expect(publishError).toBeNull();
    const { data: version } = await admin
      .from("scorecard_versions")
      .select("template_id")
      .eq("id", scorecardVersionId)
      .single();
    createdScorecardTemplateIds.push(version!.template_id);
    const { data: categories } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", scorecardVersionId);
    const { data: criteria } = await admin
      .from("scorecard_criteria")
      .select("id, required")
      .in(
        "category_id",
        (categories ?? []).map((category) => category.id)
      )
      .order("position");
    const requiredCriterion = criteria?.find((criterion) => criterion.required);
    const optionalCriterion = criteria?.find(
      (criterion) => !criterion.required
    );
    if (!requiredCriterion || !optionalCriterion) {
      throw new Error("Expected both revision-history criteria");
    }

    const call = await createCall(owner.userId, { status: "ready" });
    const { error: claimError } = await manager.client.rpc("claim_review", {
      target_call_id: call.callId,
    });
    expect(claimError).toBeNull();

    const { data: firstReview, error: firstSubmitError } =
      await manager.client.rpc("submit_call_review_with_follow_up", {
        target_call_id: call.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 0,
        expected_assignment_version: 1,
        target_status: "reviewed",
        target_summary: "First submitted summary.",
        target_follow_up: "",
        target_follow_up_due_date: null,
        target_answers: [
          {
            criterionId: requiredCriterion.id,
            value: 5,
            comment: "First required comment.",
          },
          {
            criterionId: optionalCriterion.id,
            value: null,
            comment: "First optional N/A comment.",
          },
        ],
      });
    expect(firstSubmitError).toBeNull();
    expect(firstReview).toMatchObject({ version: 1, score: 100 });

    const { error: inProgressSubmitError } = await manager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        target_call_id: call.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 1,
        expected_assignment_version: 1,
        target_status: "in_progress",
        target_summary: "Private In Progress summary.",
        target_follow_up: "",
        target_follow_up_due_date: null,
        target_answers: [
          {
            criterionId: requiredCriterion.id,
            value: 1,
            comment: "Private In Progress comment.",
          },
        ],
      }
    );
    expect(inProgressSubmitError).toBeNull();

    const { data: ownerHistoryDuringInProgress, error: ownerHistoryError } =
      await owner.client.rpc("review_revision_history", {
        target_call_id: call.callId,
      });
    expect(ownerHistoryError).toBeNull();
    expect(ownerHistoryDuringInProgress).toHaveLength(1);
    expect(ownerHistoryDuringInProgress?.[0]).toMatchObject({
      revision: 1,
      scorecard_version_id: scorecardVersionId,
      status: "reviewed",
      score: 100,
      summary: "First submitted summary.",
      follow_up_state: "not_required",
      submitted_by: manager.userId,
    });
    expect(JSON.stringify(ownerHistoryDuringInProgress)).not.toContain(
      "Private In Progress"
    );

    const { data: thirdReview, error: thirdSubmitError } =
      await manager.client.rpc("submit_call_review_with_follow_up", {
        target_call_id: call.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 2,
        expected_assignment_version: 1,
        target_status: "needs_follow_up",
        target_summary: "Third submitted summary.",
        target_follow_up: "Complete the documented action.",
        target_follow_up_due_date: null,
        target_answers: [
          {
            criterionId: requiredCriterion.id,
            value: 3,
            comment: "Third required comment.",
          },
          {
            criterionId: optionalCriterion.id,
            value: 5,
            comment: "Third optional comment.",
          },
        ],
      });
    expect(thirdSubmitError).toBeNull();
    expect(thirdReview).toMatchObject({
      version: 3,
      status: "needs_follow_up",
    });

    const { data: managerHistory, error: managerHistoryError } =
      await manager.client.rpc("review_revision_history", {
        target_call_id: call.callId,
      });
    expect(managerHistoryError).toBeNull();
    expect(
      managerHistory?.map((revision: { revision: number }) => revision.revision)
    ).toEqual([3, 2, 1]);
    expect(managerHistory?.[0]).toMatchObject({
      scorecard_version_id: scorecardVersionId,
      status: "needs_follow_up",
      summary: "Third submitted summary.",
      follow_up: "Complete the documented action.",
      follow_up_state: "open",
      submitted_by: manager.userId,
    });
    expect(managerHistory?.[0]?.answers).toEqual([
      {
        criterionId: requiredCriterion.id,
        value: 3,
        comment: "Third required comment.",
      },
      {
        criterionId: optionalCriterion.id,
        value: 5,
        comment: "Third optional comment.",
      },
    ]);
    expect(Date.parse(managerHistory![0]!.submitted_at)).not.toBeNaN();

    const { data: ownerHistoryAfterSubmission } = await owner.client.rpc(
      "review_revision_history",
      { target_call_id: call.callId }
    );
    expect(
      ownerHistoryAfterSubmission?.map(
        (revision: { revision: number }) => revision.revision
      )
    ).toEqual([3, 1]);
    const { data: nonOwnerHistory } = await sameWorkspaceNonOwner.client.rpc(
      "review_revision_history",
      { target_call_id: call.callId }
    );
    expect(nonOwnerHistory).toEqual([]);

    const { data: ownerDirectHistory, error: ownerDirectHistoryError } =
      await owner.client
        .from("review_revisions")
        .select("revision, status")
        .eq("review_id", firstReview.id)
        .order("revision");
    expect(ownerDirectHistoryError).toBeNull();
    expect(ownerDirectHistory).toEqual([
      { revision: 1, status: "reviewed" },
      { revision: 3, status: "needs_follow_up" },
    ]);

    const { error: suspendOwnerError } = await workspaceAdmin.client.rpc(
      "set_workspace_member_status",
      {
        target_user_id: owner.userId,
        target_status: "suspended",
      }
    );
    expect(suspendOwnerError).toBeNull();
    const { data: suspendedOwnerDirectHistory } = await owner.client
      .from("review_revisions")
      .select("id")
      .eq("review_id", firstReview.id);
    expect(suspendedOwnerDirectHistory).toEqual([]);

    const { error: staleReviewError } = await manager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        target_call_id: call.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 2,
        expected_assignment_version: 1,
        target_status: "reviewed",
        target_summary: "Stale overwrite.",
        target_follow_up: "",
        target_follow_up_due_date: null,
        target_answers: [
          {
            criterionId: requiredCriterion.id,
            value: 1,
            comment: "",
          },
        ],
      }
    );
    expect(staleReviewError?.message).toMatch(/Review version conflict/i);
    const { count: unchangedRevisionCount } = await admin
      .from("review_revisions")
      .select("id", { count: "exact", head: true })
      .eq("review_id", firstReview.id);
    expect(unchangedRevisionCount).toBe(3);

    const firstRevisionId = managerHistory?.find(
      (revision: { revision: number }) => revision.revision === 1
    )?.id;
    if (!firstRevisionId) throw new Error("Expected the first Review Revision");
    const { error: mutationError } = await admin
      .from("review_revisions")
      .update({ summary: "Mutated history" })
      .eq("id", firstRevisionId);
    expect(mutationError?.message).toMatch(/permission denied|immutable/i);
    const { error: individualDeleteError } = await admin
      .from("review_revisions")
      .delete()
      .eq("id", firstRevisionId);
    expect(individualDeleteError?.message).toMatch(
      /permission denied|whole-Call deletion/i
    );

    const otherWorkspaceId = crypto.randomUUID();
    createdWorkspaceIds.push(otherWorkspaceId);
    const { error: workspaceError } = await admin.from("workspaces").insert({
      id: otherWorkspaceId,
      name: "Other revision Workspace",
      slug: `other-revision-${otherWorkspaceId.slice(0, 8)}`,
    });
    if (workspaceError) throw workspaceError;
    const otherWorkspaceMember = await createWorkspaceMember(
      "member",
      otherWorkspaceId
    );
    const { data: crossWorkspaceHistory } =
      await otherWorkspaceMember.client.rpc("review_revision_history", {
        target_call_id: call.callId,
      });
    expect(crossWorkspaceHistory).toEqual([]);

    const { error: wholeCallDeleteError } = await admin
      .from("calls")
      .delete()
      .eq("id", call.callId);
    expect(wholeCallDeleteError).toBeNull();
    const { count: retainedAfterCallDelete } = await admin
      .from("review_revisions")
      .select("id", { count: "exact", head: true })
      .eq("review_id", firstReview.id);
    expect(retainedAfterCallDelete).toBe(0);
  });

  it("tracks dated Follow-ups through overdue, resolution, reassignment, and verification", async () => {
    const workspaceAdmin = await createWorkspaceMember("admin");
    const firstManager = await createWorkspaceMember("manager");
    const secondManager = await createWorkspaceMember("manager");
    const owner = await createWorkspaceMember("member");
    const nonOwner = await createWorkspaceMember("member");

    const { data: scorecardVersionId, error: publishError } =
      await workspaceAdmin.client.rpc("publish_scorecard_for_current_admin", {
        target_template_id: null,
        target_name: "Follow-up contract Scorecard",
        target_categories: [
          {
            name: "Quality",
            criteria: [
              {
                label: "Required outcome",
                description: "",
                weight: 1,
                required: true,
              },
            ],
          },
        ],
      });
    expect(publishError).toBeNull();
    const { data: version } = await admin
      .from("scorecard_versions")
      .select("template_id")
      .eq("id", scorecardVersionId)
      .single();
    createdScorecardTemplateIds.push(version!.template_id);
    const { data: category } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", scorecardVersionId)
      .single();
    const { data: criterion } = await admin
      .from("scorecard_criteria")
      .select("id")
      .eq("category_id", category!.id)
      .single();

    const call = await createCall(owner.userId, { status: "ready" });
    const { error: claimError } = await firstManager.client.rpc(
      "claim_review",
      { target_call_id: call.callId }
    );
    expect(claimError).toBeNull();
    const { data: review, error: submitError } = await firstManager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        target_call_id: call.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 0,
        expected_assignment_version: 1,
        target_status: "needs_follow_up",
        target_summary: "A dated action is required.",
        target_follow_up: "Complete the agreed coaching action.",
        target_follow_up_due_date: null,
        target_answers: [
          {
            criterionId: criterion!.id,
            value: 3,
            comment: "",
          },
        ],
      }
    );
    expect(submitError).toBeNull();

    const { data: followUp, error: followUpError } = await admin
      .from("follow_ups")
      .select(
        "id, review_id, call_id, owner_id, due_date, status, version, created_from_revision"
      )
      .eq("call_id", call.callId)
      .single();
    if (followUpError) throw followUpError;
    expect(followUp).toMatchObject({
      review_id: review.id,
      call_id: call.callId,
      owner_id: owner.userId,
      status: "open",
      version: 1,
      created_from_revision: 1,
    });
    const defaultDueDate = new Date();
    defaultDueDate.setUTCDate(defaultDueDate.getUTCDate() + 7);
    expect(followUp.due_date).toBe(defaultDueDate.toISOString().slice(0, 10));

    const dueDate = new Date(`${followUp.due_date}T00:00:00Z`);
    const overdueDate = new Date(dueDate);
    overdueDate.setUTCDate(overdueDate.getUTCDate() + 1);
    const { data: ownerOpenQueue } = await owner.client.rpc("follow_up_queue", {
      as_of_date: followUp.due_date,
    });
    expect(ownerOpenQueue).toHaveLength(1);
    expect(ownerOpenQueue?.[0]).toMatchObject({
      id: followUp.id,
      display_status: "open",
      can_resolve: true,
      can_verify: false,
    });
    const { data: ownerOverdueQueue } = await owner.client.rpc(
      "follow_up_queue",
      { as_of_date: overdueDate.toISOString().slice(0, 10) }
    );
    expect(ownerOverdueQueue?.[0]?.display_status).toBe("overdue");
    const { data: assigneeQueue } = await firstManager.client.rpc(
      "follow_up_queue",
      { as_of_date: overdueDate.toISOString().slice(0, 10) }
    );
    expect(assigneeQueue).toHaveLength(1);
    expect(assigneeQueue?.[0]).toMatchObject({
      review_assignee_id: firstManager.userId,
      can_resolve: false,
      can_verify: false,
    });
    const { data: adminQueue } = await workspaceAdmin.client.rpc(
      "follow_up_queue",
      { as_of_date: overdueDate.toISOString().slice(0, 10) }
    );
    expect(adminQueue).toHaveLength(1);
    const { data: nonOwnerQueue } = await nonOwner.client.rpc(
      "follow_up_queue",
      { as_of_date: overdueDate.toISOString().slice(0, 10) }
    );
    expect(nonOwnerQueue).toEqual([]);

    const { error: nonOwnerResolveError } = await nonOwner.client.rpc(
      "resolve_follow_up",
      {
        target_follow_up_id: followUp.id,
        expected_version: 1,
      }
    );
    expect(nonOwnerResolveError?.message).toMatch(/only the Follow-up owner/i);

    const concurrentResolutions = await Promise.all([
      owner.client.rpc("resolve_follow_up", {
        target_follow_up_id: followUp.id,
        expected_version: 1,
      }),
      owner.client.rpc("resolve_follow_up", {
        target_follow_up_id: followUp.id,
        expected_version: 1,
      }),
    ]);
    expect(
      concurrentResolutions.filter((result) => !result.error)
    ).toHaveLength(1);
    expect(concurrentResolutions.filter((result) => result.error)).toHaveLength(
      1
    );
    expect(
      concurrentResolutions.find((result) => result.error)?.error?.message
    ).toMatch(/version conflict/i);

    const { data: reassigned, error: reassignmentError } =
      await workspaceAdmin.client.rpc("assign_review", {
        target_call_id: call.callId,
        target_assignee_id: secondManager.userId,
        expected_assignment_version: 1,
      });
    expect(reassignmentError).toBeNull();
    expect(reassigned).toMatchObject({
      assignee_id: secondManager.userId,
      version: 2,
    });

    const { data: awaitingQueue } = await secondManager.client.rpc(
      "follow_up_queue",
      { as_of_date: overdueDate.toISOString().slice(0, 10) }
    );
    expect(awaitingQueue?.[0]).toMatchObject({
      display_status: "awaiting_verification",
      can_verify: true,
      version: 2,
    });
    const { error: formerAssigneeVerifyError } = await firstManager.client.rpc(
      "verify_follow_up",
      {
        target_follow_up_id: followUp.id,
        expected_version: 2,
      }
    );
    expect(formerAssigneeVerifyError?.message).toMatch(
      /Review Assignee or an Admin/i
    );
    const { data: verified, error: verifyError } =
      await secondManager.client.rpc("verify_follow_up", {
        target_follow_up_id: followUp.id,
        expected_version: 2,
      });
    expect(verifyError).toBeNull();
    expect(verified).toMatchObject({ status: "verified", version: 3 });
    const { data: closedOwnerQueue } = await owner.client.rpc(
      "follow_up_queue",
      { as_of_date: overdueDate.toISOString().slice(0, 10) }
    );
    expect(closedOwnerQueue).toEqual([]);

    const reopenedDueDate = new Date(overdueDate);
    reopenedDueDate.setUTCDate(reopenedDueDate.getUTCDate() + 14);
    const { error: reopenError } = await secondManager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        target_call_id: call.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 1,
        expected_assignment_version: 2,
        target_status: "needs_follow_up",
        target_summary: "A new submission reopens the tracked work.",
        target_follow_up: "Complete the revised coaching action.",
        target_follow_up_due_date: reopenedDueDate.toISOString().slice(0, 10),
        target_answers: [
          {
            criterionId: criterion!.id,
            value: 4,
            comment: "",
          },
        ],
      }
    );
    expect(reopenError).toBeNull();
    const { data: reopened, count: followUpCount } = await admin
      .from("follow_ups")
      .select("id, status, version, created_from_revision", {
        count: "exact",
      })
      .eq("review_id", review.id)
      .single();
    expect(followUpCount).toBe(1);
    expect(reopened).toMatchObject({
      id: followUp.id,
      status: "open",
      version: 4,
      created_from_revision: 2,
    });

    const pastCall = await createCall(owner.userId, { status: "ready" });
    const { error: pastClaimError } = await secondManager.client.rpc(
      "claim_review",
      { target_call_id: pastCall.callId }
    );
    expect(pastClaimError).toBeNull();
    const pastDate = new Date();
    pastDate.setUTCDate(pastDate.getUTCDate() - 1);
    const { error: pastDueDateError } = await secondManager.client.rpc(
      "submit_call_review_with_follow_up",
      {
        target_call_id: pastCall.callId,
        target_scorecard_version_id: scorecardVersionId,
        expected_version: 0,
        expected_assignment_version: 1,
        target_status: "needs_follow_up",
        target_summary: "Past due dates are invalid.",
        target_follow_up: "This should roll back.",
        target_follow_up_due_date: pastDate.toISOString().slice(0, 10),
        target_answers: [
          {
            criterionId: criterion!.id,
            value: 3,
            comment: "",
          },
        ],
      }
    );
    expect(pastDueDateError?.message).toMatch(/cannot be in the past/i);
    const { count: pastCallFollowUps } = await admin
      .from("follow_ups")
      .select("id", { count: "exact", head: true })
      .eq("call_id", pastCall.callId);
    const { count: pastCallReviews } = await admin
      .from("call_reviews")
      .select("id", { count: "exact", head: true })
      .eq("call_id", pastCall.callId);
    expect(pastCallFollowUps).toBe(0);
    expect(pastCallReviews).toBe(0);

    const { error: directStateWriteError } = await owner.client
      .from("follow_ups")
      .update({ status: "verified" })
      .eq("id", followUp.id);
    expect(directStateWriteError).not.toBeNull();

    const { data: auditEvents } = await admin
      .from("audit_events")
      .select("action, entity_id, metadata")
      .eq("entity_id", followUp.id);
    expect(auditEvents?.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "follow_up.created",
        "follow_up.resolved",
        "follow_up.verified",
        "follow_up.reopened",
      ])
    );
    expect(JSON.stringify(auditEvents)).not.toContain(
      "Complete the agreed coaching action."
    );

    const { data: ownerDirectFollowUps, error: ownerDirectFollowUpsError } =
      await owner.client.from("follow_ups").select("id").eq("id", followUp.id);
    expect(ownerDirectFollowUpsError).toBeNull();
    expect(ownerDirectFollowUps).toEqual([{ id: followUp.id }]);
    const { error: suspendOwnerError } = await workspaceAdmin.client.rpc(
      "set_workspace_member_status",
      {
        target_user_id: owner.userId,
        target_status: "suspended",
      }
    );
    expect(suspendOwnerError).toBeNull();
    const { data: suspendedOwnerDirectFollowUps } = await owner.client
      .from("follow_ups")
      .select("id")
      .eq("id", followUp.id);
    expect(suspendedOwnerDirectFollowUps).toEqual([]);
  });

  it("enforces one Workspace per person and the ten-active-member pilot cap", async () => {
    const members = [];
    for (let index = 0; index < 10; index += 1) {
      members.push(
        await createWorkspaceMember(index === 0 ? "admin" : "member")
      );
    }
    const pilotAdmin = members[0]!;
    const suspendedMember = members[1]!;

    const password = `Test-${crypto.randomUUID()}!`;
    const { data: eleventh, error: createError } =
      await admin.auth.admin.createUser({
        email: `eleventh-${crypto.randomUUID()}@example.com`,
        password,
        email_confirm: true,
      });
    if (createError) throw createError;
    createdUserIds.push(eleventh.user.id);

    const { error: capError } = await admin.from("workspace_members").insert({
      workspace_id: workspaceId,
      user_id: eleventh.user.id,
      role: "member",
    });
    expect(capError?.message).toMatch(/limited to ten active/i);

    const { error: suspendError } = await pilotAdmin.client.rpc(
      "set_workspace_member_status",
      {
        target_user_id: suspendedMember.userId,
        target_status: "suspended",
      }
    );
    expect(suspendError).toBeNull();

    const { error: admittedError } = await admin
      .from("workspace_members")
      .insert({
        workspace_id: workspaceId,
        user_id: eleventh.user.id,
        role: "member",
      });
    expect(admittedError).toBeNull();

    const { error: suspendEleventhError } = await pilotAdmin.client.rpc(
      "set_workspace_member_status",
      {
        target_user_id: eleventh.user.id,
        target_status: "suspended",
      }
    );
    expect(suspendEleventhError).toBeNull();

    const otherWorkspaceId = crypto.randomUUID();
    createdWorkspaceIds.push(otherWorkspaceId);
    const { error: workspaceError } = await admin.from("workspaces").insert({
      id: otherWorkspaceId,
      name: "Second Workspace",
      slug: `second-${otherWorkspaceId.slice(0, 8)}`,
    });
    if (workspaceError) throw workspaceError;

    const { error: secondWorkspaceError } = await admin
      .from("workspace_members")
      .insert({
        workspace_id: otherWorkspaceId,
        user_id: eleventh.user.id,
        role: "member",
      });
    expect(secondWorkspaceError?.code).toBe("23505");

    const { data: suspendedAccess } = await suspendedMember.client
      .from("calls")
      .select("id");
    expect(suspendedAccess).toEqual([]);

    const { data: statusAudit } = await admin
      .from("audit_events")
      .select("action, entity_id, metadata")
      .eq("workspace_id", workspaceId)
      .eq("action", "workspace.member.suspended")
      .eq("entity_id", suspendedMember.userId)
      .single();
    expect(statusAudit).toMatchObject({
      action: "workspace.member.suspended",
      entity_id: suspendedMember.userId,
      metadata: {
        previous_status: "active",
        new_status: "suspended",
      },
    });
  });

  it("activates only a valid email-matched invitation after password creation", async () => {
    const { client: workspaceAdmin, userId: workspaceAdminId } =
      await createWorkspaceMember("admin");
    const email = `activation-${crypto.randomUUID()}@example.com`;
    const password = `Activation-${crypto.randomUUID()}!`;
    const inviteId = crypto.randomUUID();
    const { error: inviteError } = await admin
      .from("workspace_invites")
      .insert({
        id: inviteId,
        workspace_id: workspaceId,
        email,
        role: "member",
        invited_by: workspaceAdminId,
      });
    if (inviteError) throw inviteError;

    const { data: invitedUser, error: userError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (userError) throw userError;
    createdUserIds.push(invitedUser.user.id);

    const [{ data: pendingInvite }, { count: prematureMemberships }] =
      await Promise.all([
        admin
          .from("workspace_invites")
          .select("accepted_at")
          .eq("id", inviteId)
          .single(),
        admin
          .from("workspace_members")
          .select("user_id", { count: "exact", head: true })
          .eq("user_id", invitedUser.user.id),
      ]);
    expect(pendingInvite?.accepted_at).toBeNull();
    expect(prematureMemberships).toBe(0);

    const invitedClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: signInError } = await invitedClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;

    const wrongInviteId = crypto.randomUUID();
    const { error: wrongInviteInsertError } = await admin
      .from("workspace_invites")
      .insert({
        id: wrongInviteId,
        workspace_id: workspaceId,
        email: `wrong-${email}`,
        role: "member",
        invited_by: workspaceAdminId,
      });
    if (wrongInviteInsertError) throw wrongInviteInsertError;
    const { error: wrongEmailError } = await invitedClient.rpc(
      "activate_workspace_invitation",
      { target_invite_id: wrongInviteId }
    );
    expect(wrongEmailError?.message).toMatch(
      /invalid, expired, used, or revoked/i
    );

    const { data: membership, error: activationError } =
      await invitedClient.rpc("activate_workspace_invitation", {
        target_invite_id: inviteId,
      });
    expect(activationError).toBeNull();
    expect(membership).toMatchObject({
      workspace_id: workspaceId,
      user_id: invitedUser.user.id,
      role: "member",
      status: "active",
    });

    const { error: reusedError } = await invitedClient.rpc(
      "activate_workspace_invitation",
      { target_invite_id: inviteId }
    );
    expect(reusedError?.message).toMatch(/invalid, expired, used, or revoked/i);

    const { data: activationAudit } = await admin
      .from("audit_events")
      .select("actor_id, action, entity_id, metadata")
      .eq("action", "workspace.invite.activated")
      .eq("entity_id", inviteId)
      .single();
    expect(activationAudit).toMatchObject({
      actor_id: invitedUser.user.id,
      action: "workspace.invite.activated",
      entity_id: inviteId,
      metadata: { role: "member" },
    });

    const expiredEmail = `expired-${crypto.randomUUID()}@example.com`;
    const expiredPassword = `Activation-${crypto.randomUUID()}!`;
    const { data: expiredUser, error: expiredUserError } =
      await admin.auth.admin.createUser({
        email: expiredEmail,
        password: expiredPassword,
        email_confirm: true,
      });
    if (expiredUserError) throw expiredUserError;
    createdUserIds.push(expiredUser.user.id);
    const expiredInviteId = crypto.randomUUID();
    const { error: expiredInviteError } = await admin
      .from("workspace_invites")
      .insert({
        id: expiredInviteId,
        workspace_id: workspaceId,
        email: expiredEmail,
        role: "member",
        invited_by: workspaceAdminId,
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      });
    if (expiredInviteError) throw expiredInviteError;
    const expiredClient = createClient(localUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { error: expiredSignInError } =
      await expiredClient.auth.signInWithPassword({
        email: expiredEmail,
        password: expiredPassword,
      });
    if (expiredSignInError) throw expiredSignInError;
    const { error: expiredActivationError } = await expiredClient.rpc(
      "activate_workspace_invitation",
      { target_invite_id: expiredInviteId }
    );
    expect(expiredActivationError?.message).toMatch(
      /invalid, expired, used, or revoked/i
    );

    const { error: revokeError } = await workspaceAdmin.rpc(
      "revoke_workspace_invite",
      { target_invite_id: wrongInviteId }
    );
    expect(revokeError).toBeNull();
  });

  it("keeps Audit Events safe, immutable, retained, and Workspace-isolated", async () => {
    const { client: workspaceAdmin, userId: workspaceAdminId } =
      await createWorkspaceMember("admin");
    const { client: workspaceMember } = await createWorkspaceMember("member");

    const otherWorkspaceId = crypto.randomUUID();
    createdWorkspaceIds.push(otherWorkspaceId);
    const { error: workspaceError } = await admin.from("workspaces").insert({
      id: otherWorkspaceId,
      name: "Other audit Workspace",
      slug: `other-audit-${otherWorkspaceId.slice(0, 8)}`,
    });
    if (workspaceError) throw workspaceError;
    const { userId: otherAdminId } = await createWorkspaceMember(
      "admin",
      otherWorkspaceId
    );

    const entityId = crypto.randomUUID();
    const { data: eventId, error: recordError } = await admin.rpc(
      "record_audit_event",
      {
        target_workspace_id: workspaceId,
        target_actor_id: workspaceAdminId,
        target_action: "workspace.test.created",
        target_entity_type: "workspace",
        target_entity_id: entityId,
        target_metadata: { role: "admin", test_run: true },
      }
    );
    expect(recordError).toBeNull();
    expect(eventId).toBeTypeOf("number");

    const { error: otherRecordError } = await admin.rpc("record_audit_event", {
      target_workspace_id: otherWorkspaceId,
      target_actor_id: otherAdminId,
      target_action: "workspace.test.created",
      target_entity_type: "workspace",
      target_entity_id: otherWorkspaceId,
      target_metadata: {},
    });
    expect(otherRecordError).toBeNull();

    const { error: unsafeError } = await admin.rpc("record_audit_event", {
      target_workspace_id: workspaceId,
      target_actor_id: workspaceAdminId,
      target_action: "workspace.test.created",
      target_entity_type: "workspace",
      target_entity_id: entityId,
      target_metadata: { email: "customer@example.com" },
    });
    expect(unsafeError?.message).toMatch(/prohibited content/i);

    const { error: insertError } = await workspaceMember
      .from("audit_events")
      .insert({
        workspace_id: workspaceId,
        actor_id: workspaceAdminId,
        action: "workspace.test.forged",
        entity_type: "workspace",
        entity_id: entityId,
      });
    expect(insertError).not.toBeNull();

    const { data: adminEvents, error: selectError } = await workspaceAdmin
      .from("audit_events")
      .select(
        "id, workspace_id, actor_id, action, entity_type, entity_id, metadata, created_at, retained_until"
      )
      .eq("id", eventId)
      .single();
    expect(selectError).toBeNull();
    expect(adminEvents).toMatchObject({
      id: eventId,
      workspace_id: workspaceId,
      actor_id: workspaceAdminId,
      action: "workspace.test.created",
      entity_type: "workspace",
      entity_id: entityId,
      metadata: { role: "admin", test_run: true },
    });
    expect(
      new Date(adminEvents!.retained_until).getTime() -
        new Date(adminEvents!.created_at).getTime()
    ).toBeGreaterThanOrEqual(365 * 24 * 60 * 60 * 1_000);

    const { data: memberEvents } = await workspaceMember
      .from("audit_events")
      .select("id");
    expect(memberEvents).toEqual([]);

    const { data: crossWorkspaceEvents } = await workspaceAdmin
      .from("audit_events")
      .select("workspace_id")
      .eq("workspace_id", otherWorkspaceId);
    expect(crossWorkspaceEvents).toEqual([]);

    const { error: updateError } = await admin
      .from("audit_events")
      .update({ entity_id: "mutated" })
      .eq("id", eventId);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await admin
      .from("audit_events")
      .delete()
      .eq("id", eventId);
    expect(deleteError).not.toBeNull();
  });

  it("prevents a Workspace Member from rewriting protected Call fields directly", async () => {
    const { client, userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);

    const { data, error } = await (client as SupabaseClient)
      .from("calls")
      .update({
        status: "ready",
        source_path: `${workspaceId}/another-call/source.webm`,
      })
      .eq("id", callId)
      .select("status, source_path");

    expect(error).not.toBeNull();
    expect(data).toBeNull();
    const { data: storedCall } = await admin
      .from("calls")
      .select("status, source_path")
      .eq("id", callId)
      .single();
    expect(storedCall).toEqual({
      status: "recording",
      source_path: null,
    });
  });

  it("keeps the web principal inside its narrow application commands", async () => {
    const { client, userId } = await createWorkspaceMember();
    const callId = crypto.randomUUID();
    createdCallIds.push(callId);

    const { data: createdCall, error: createError } = await client.rpc(
      "create_attested_call_for_current_user",
      {
        target_call_id: callId,
        target_source_mode: "both",
        target_mic_label: "Microphone",
        target_tab_label: "Browser tab",
        target_title: "Principal boundary",
        target_recording_attested: true,
      }
    );
    expect(createError).toBeNull();
    expect(createdCall).toMatchObject({
      id: callId,
      workspace_id: workspaceId,
      owner_id: userId,
      recording_attested_by: userId,
      status: "recording",
      title: "Principal boundary",
    });

    const { error: jobWriteError } = await client
      .from("processing_jobs")
      .insert({
        workspace_id: workspaceId,
        call_id: callId,
        kind: "process_recording",
        idempotency_key: `forged:${callId}`,
      });
    expect(jobWriteError).not.toBeNull();

    const { error: workerClaimError } = await client.rpc(
      "claim_processing_job",
      { worker_name: "forged-web-worker" }
    );
    expect(workerClaimError).not.toBeNull();

    const { error: arbitraryAuditError } = await client.rpc(
      "record_audit_event",
      {
        target_workspace_id: workspaceId,
        target_actor_id: userId,
        target_action: "workspace.test.forged",
        target_entity_type: "workspace",
        target_entity_id: workspaceId,
        target_metadata: {},
      }
    );
    expect(arbitraryAuditError).not.toBeNull();

    const { error: retentionPurgeError } = await client.rpc(
      "purge_expired_audit_events"
    );
    expect(retentionPurgeError).not.toBeNull();

    const { error: privilegedFinalizeError } = await client.rpc(
      "finalize_call",
      {
        target_call_id: callId,
        final_chunk_sequence: 0,
        target_duration_ms: 1_000,
        target_mime_type: "audio/webm",
        target_source_mode: "both",
        target_mic_label: "",
        target_tab_label: "",
        target_degraded_intervals: [],
      }
    );
    expect(privilegedFinalizeError).not.toBeNull();
  });

  it("denies privileged database authority until the session reaches AAL2", async () => {
    const manager = await createWorkspaceMember("manager", workspaceId, false);
    const workspaceAdmin = await createWorkspaceMember(
      "admin",
      workspaceId,
      false
    );
    const owner = await createWorkspaceMember("member");
    const { callId } = await createCall(owner.userId, { status: "ready" });

    const { data: visibleCalls, error: visibilityError } = await manager.client
      .from("calls")
      .select("id")
      .eq("id", callId);
    expect(visibilityError).toBeNull();
    expect(visibleCalls).toEqual([]);

    const { data: canView } = await manager.client.rpc("can_view_call", {
      target_call_id: callId,
    });
    expect(canView).toBe(false);

    const { error: inviteError } = await workspaceAdmin.client.rpc(
      "create_workspace_invite",
      {
        target_email: `blocked-invite-${crypto.randomUUID()}@example.com`,
        target_role: "member",
      }
    );
    expect(inviteError?.message).toMatch(/Verified TOTP MFA is required/i);

    // Reaching past the RPCs at the table changes nothing either.
    const { error: directInviteError } = await workspaceAdmin.client
      .from("workspace_invites")
      .insert({
        workspace_id: workspaceId,
        email: `direct-invite-${crypto.randomUUID()}@example.com`,
        role: "admin",
        invited_by: workspaceAdmin.userId,
      });
    expect(directInviteError).not.toBeNull();

    await workspaceAdmin.client
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", workspaceId)
      .eq("user_id", owner.userId);
    const { data: unchanged, error: unchangedError } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", owner.userId)
      .single();
    if (unchangedError) throw unchangedError;
    expect(unchanged.role).toBe("member");
  });

  it("requires a Recording Attestation and stores its actor, time, and optional Call title", async () => {
    const owner = await createWorkspaceMember("member");
    const unattestedCallId = crypto.randomUUID();
    const beforeAttestation = Date.now();

    const { error: privilegedBypassError } = await admin.from("calls").insert({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      owner_id: owner.userId,
      source_mode: "both",
      chunk_prefix: `${workspaceId}/${crypto.randomUUID()}/chunks`,
      recording_attestation_required: false,
    });
    expect(privilegedBypassError?.message).toMatch(
      /Recording Attestation is required/i
    );

    const { error: unattestedError } = await owner.client.rpc(
      "create_call_for_current_user",
      {
        target_call_id: unattestedCallId,
        target_source_mode: "both",
        target_mic_label: "Test microphone",
        target_tab_label: "Test call tab",
      }
    );
    if (!unattestedError) createdCallIds.push(unattestedCallId);
    expect(unattestedError?.message).toMatch(
      /Recording Attestation is required/i
    );

    const callId = crypto.randomUUID();
    const { data: created, error: createError } = await owner.client.rpc(
      "create_attested_call_for_current_user",
      {
        target_call_id: callId,
        target_source_mode: "both",
        target_mic_label: "Test microphone",
        target_tab_label: "Test call tab",
        target_title: "  Pilot kickoff  ",
        target_recording_attested: true,
      }
    );
    if (createError) throw createError;
    createdCallIds.push(callId);

    const call = Array.isArray(created) ? created[0] : created;
    expect(call).toMatchObject({
      id: callId,
      owner_id: owner.userId,
      recording_attested_by: owner.userId,
      title: "Pilot kickoff",
    });
    expect(Date.parse(call.recording_attested_at)).toBeGreaterThanOrEqual(
      beforeAttestation - 5_000
    );
    expect(Date.parse(call.recording_attested_at)).toBeLessThanOrEqual(
      Date.now() + 5_000
    );

    const missingConfirmationId = crypto.randomUUID();
    const { error: missingConfirmationError } = await owner.client.rpc(
      "create_attested_call_for_current_user",
      {
        target_call_id: missingConfirmationId,
        target_source_mode: "both",
        target_mic_label: "Test microphone",
        target_tab_label: "Test call tab",
        target_title: null,
        target_recording_attested: false,
      }
    );
    expect(missingConfirmationError?.message).toMatch(
      /Recording Attestation is required/i
    );
  });

  it("allows only the Call owner to rename after capture", async () => {
    const owner = await createWorkspaceMember("member");
    const manager = await createWorkspaceMember("manager");
    const workspaceAdmin = await createWorkspaceMember("admin");
    const { callId } = await createCall(owner.userId, {
      status: "recording",
      title: "Original title",
    });

    const { error: activeRenameError } = await owner.client.rpc(
      "rename_owned_call",
      {
        target_call_id: callId,
        target_title: "Too early",
      }
    );
    expect(activeRenameError?.message).toMatch(/after capture/i);

    const { error: readyError } = await admin
      .from("calls")
      .update({ status: "ready", stopped_at: new Date().toISOString() })
      .eq("id", callId);
    if (readyError) throw readyError;

    for (const privileged of [manager, workspaceAdmin]) {
      const { error } = await privileged.client.rpc("rename_owned_call", {
        target_call_id: callId,
        target_title: "Privileged rewrite",
      });
      expect(error?.message).toMatch(/Only the Call owner can rename/i);
    }

    const { data: renamed, error: renameError } = await owner.client.rpc(
      "rename_owned_call",
      {
        target_call_id: callId,
        target_title: "  Customer discovery  ",
      }
    );
    if (renameError) throw renameError;
    const call = Array.isArray(renamed) ? renamed[0] : renamed;
    expect(call.title).toBe("Customer discovery");

    const { data: persisted, error: persistedError } = await admin
      .from("calls")
      .select("title")
      .eq("id", callId)
      .single();
    if (persistedError) throw persistedError;
    expect(persisted.title).toBe("Customer discovery");
  });

  it("issues Recovery Codes that are single-use, replaceable, and unreadable", async () => {
    const member = await createWorkspaceMember("member");
    const hashSet = () =>
      Array.from({ length: 10 }, () =>
        createHash("sha256").update(crypto.randomUUID()).digest("hex")
      );
    const firstHashes = hashSet();

    const { error: issueError } = await admin.rpc(
      "replace_mfa_recovery_codes",
      { target_user_id: member.userId, target_code_hashes: firstHashes }
    );
    if (issueError) throw issueError;

    const { data: firstActive, error: firstActiveError } = await admin.rpc(
      "active_mfa_recovery_codes",
      { target_user_id: member.userId }
    );
    if (firstActiveError) throw firstActiveError;
    expect(firstActive).toHaveLength(10);
    expect(
      firstActive.map((code: { code_hash: string }) => code.code_hash).sort()
    ).toEqual([...firstHashes].sort());

    const { error: sizeError } = await admin.rpc("replace_mfa_recovery_codes", {
      target_user_id: member.userId,
      target_code_hashes: firstHashes.slice(0, 9),
    });
    expect(sizeError?.message).toMatch(/exactly ten codes/i);

    // One code, one use: a replay of the same row finds nothing to consume.
    const { data: remaining, error: consumeError } = await admin.rpc(
      "consume_mfa_recovery_code",
      { target_code_id: firstActive[0].id }
    );
    if (consumeError) throw consumeError;
    expect(remaining).toBe(9);
    const { data: replayed } = await admin.rpc("consume_mfa_recovery_code", {
      target_code_id: firstActive[0].id,
    });
    expect(replayed).toBeNull();

    // Two requests presenting the same code race for one row.
    const contested = await Promise.all([
      admin.rpc("consume_mfa_recovery_code", {
        target_code_id: firstActive[1].id,
      }),
      admin.rpc("consume_mfa_recovery_code", {
        target_code_id: firstActive[1].id,
      }),
    ]);
    expect(contested.filter((outcome) => outcome.data !== null)).toHaveLength(
      1
    );

    // Redemption withdraws authority until a replacement factor is verified.
    const { data: pending, error: pendingError } = await admin
      .from("workspace_members")
      .select("mfa_recovery_pending_at")
      .eq("user_id", member.userId)
      .single();
    if (pendingError) throw pendingError;
    expect(pending.mfa_recovery_pending_at).not.toBeNull();
    const { data: roleWhilePending } = await member.client.rpc(
      "current_user_role",
      { target_workspace_id: workspaceId }
    );
    expect(roleWhilePending).toBeNull();

    // Hashes are never readable by the Workspace Member they belong to.
    const { error: directReadError } = await member.client
      .from("mfa_recovery_codes")
      .select("code_hash");
    expect(directReadError).not.toBeNull();

    const secondHashes = hashSet();
    const { error: regenerateError } = await admin.rpc(
      "replace_mfa_recovery_codes",
      { target_user_id: member.userId, target_code_hashes: secondHashes }
    );
    if (regenerateError) throw regenerateError;

    const { data: secondActive } = await admin.rpc(
      "active_mfa_recovery_codes",
      { target_user_id: member.userId }
    );
    expect(
      secondActive.map((code: { code_hash: string }) => code.code_hash).sort()
    ).toEqual([...secondHashes].sort());
    const { data: obsolete } = await admin.rpc("consume_mfa_recovery_code", {
      target_code_id: firstActive[2].id,
    });
    expect(obsolete).toBeNull();

    const { data: restored } = await admin
      .from("workspace_members")
      .select("mfa_recovery_pending_at")
      .eq("user_id", member.userId)
      .single();
    expect(restored?.mfa_recovery_pending_at).toBeNull();
    const { data: roleAfterReplacement } = await member.client.rpc(
      "current_user_role",
      { target_workspace_id: workspaceId }
    );
    expect(roleAfterReplacement).toBe("member");

    const { data: audit, error: auditError } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("entity_id", member.userId);
    if (auditError) throw auditError;
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "auth.mfa.recovery_codes_generated",
        "auth.mfa.recovery_codes_regenerated",
        "auth.mfa.recovery_used",
      ])
    );
    const serializedAudit = JSON.stringify(audit);
    for (const hash of [...firstHashes, ...secondHashes]) {
      expect(serializedAudit).not.toContain(hash);
    }
  });

  it("locks an idle session, spares an active Recording, and expires at twelve hours", async () => {
    const member = await createWorkspaceMember("member");
    const sessionOf = async () => {
      const { data } = await member.client.rpc("touch_session_activity");
      return data;
    };
    const reasonOf = async () => {
      const { data } = await member.client.rpc("session_lock_reason");
      return data;
    };
    const backdate = async (column: string, ago: string) => {
      const { error } = await admin
        .from("session_activity")
        .update({ [column]: new Date(Date.now() - ms(ago)).toISOString() })
        .eq("user_id", member.userId);
      if (error) throw error;
    };

    expect(await sessionOf()).toBeNull();
    expect(await reasonOf()).toBeNull();

    // An active Recording suspends the threshold instead of resetting it.
    const { callId } = await createCall(member.userId, { status: "recording" });
    await backdate("last_seen_at", "31m");
    expect(await reasonOf()).toBeNull();
    expect(await sessionOf()).toBeNull();
    const { data: roleWhileRecording } = await member.client.rpc(
      "current_user_role",
      { target_workspace_id: workspaceId }
    );
    expect(roleWhileRecording).toBe("member");

    // Stop & Save ends the exception, and the elapsed threshold applies at once.
    const { error: finalizeError } = await admin
      .from("calls")
      .update({ status: "ready" })
      .eq("id", callId);
    if (finalizeError) throw finalizeError;
    expect(await reasonOf()).toBe("inactivity");
    expect(await sessionOf()).toBe("inactivity");

    // The lock is written down, so a later request cannot revive the session.
    const { error: reviveError } = await admin
      .from("session_activity")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", member.userId);
    if (reviveError) throw reviveError;
    expect(await reasonOf()).toBe("inactivity");
    const { data: roleWhileLocked } = await member.client.rpc(
      "current_user_role",
      { target_workspace_id: workspaceId }
    );
    expect(roleWhileLocked).toBeNull();

    const { error: clearError } = await admin
      .from("session_activity")
      .update({ locked_at: null, lock_reason: null })
      .eq("user_id", member.userId);
    if (clearError) throw clearError;
    await backdate("started_at", "13h");
    expect(await reasonOf()).toBe("absolute");
  });

  it("applies each documented abuse limit at the database boundary", async () => {
    const member = await createWorkspaceMember("member");
    const workspaceAdmin = await createWorkspaceMember("admin");

    // Bucket semantics: the allowance is spent, then the window resets it.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { data } = await admin.rpc("consume_rate_limit", {
        target_bucket: "test.bucket",
        target_subject: member.userId,
        max_attempts: 3,
        target_window: "1 hour",
      });
      expect(data).toBe("allowed");
    }
    const { data: spent } = await admin.rpc("consume_rate_limit", {
      target_bucket: "test.bucket",
      target_subject: member.userId,
      max_attempts: 3,
      target_window: "1 hour",
    });
    expect(spent).toBe("limited");
    const { error: rewindError } = await admin
      .from("rate_limit_state")
      .update({
        window_started_at: new Date(Date.now() - ms("2h")).toISOString(),
      })
      .eq("bucket", "test.bucket");
    if (rewindError) throw rewindError;
    const { data: renewed } = await admin.rpc("consume_rate_limit", {
      target_bucket: "test.bucket",
      target_subject: member.userId,
      max_attempts: 3,
      target_window: "1 hour",
    });
    expect(renewed).toBe("allowed");

    // Invitations: twenty an hour per Workspace, enforced on the table itself.
    for (let issued = 1; issued <= 20; issued += 1) {
      const { error } = await workspaceAdmin.client.rpc(
        "create_workspace_invite",
        {
          target_email: `limit-${crypto.randomUUID()}@example.com`,
          target_role: "member",
        }
      );
      expect(error).toBeNull();
    }
    const { error: throttledInvite } = await workspaceAdmin.client.rpc(
      "create_workspace_invite",
      {
        target_email: `limit-${crypto.randomUUID()}@example.com`,
        target_role: "member",
      }
    );
    expect(throttledInvite?.message).toMatch(/too many workspace invitations/i);

    // Signed delivery: sixty an hour per Workspace Member.
    for (let issued = 1; issued <= 60; issued += 1) {
      const { data } = await member.client.rpc(
        "consume_signed_download_allowance"
      );
      expect(data).toBe("allowed");
    }
    const { data: throttledDownload } = await member.client.rpc(
      "consume_signed_download_allowance"
    );
    expect(throttledDownload).toBe("limited");

    // Recording chunk upload is deliberately outside every counter.
    const { data: buckets } = await admin
      .from("rate_limit_state")
      .select("bucket");
    expect(
      (buckets ?? []).map((row: { bucket: string }) => row.bucket)
    ).not.toContain("recording.chunk");

    const { data: exceeded } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("action", "security.rate_limit.exceeded");
    expect((exceeded ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(exceeded)).not.toContain(member.userId);
  });

  it("measures how recently the second factor was actually presented", async () => {
    const workspaceAdmin = await createWorkspaceMember("admin");

    // The window is the control: the same session is fresh against an hour and
    // stale against an instant, which is only true if the assertion's own
    // timestamp is being read rather than the session's assurance level.
    const { data: fresh, error: freshError } = await workspaceAdmin.client.rpc(
      "recent_mfa_assertion",
      { max_age: "1 hour" }
    );
    if (freshError) throw freshError;
    expect(fresh).toBe(true);

    const { data: stale } = await workspaceAdmin.client.rpc(
      "recent_mfa_assertion",
      { max_age: "0 seconds" }
    );
    expect(stale).toBe(false);

    // A session that never presented a factor is never fresh.
    const member = await createWorkspaceMember("member");
    const { data: never } = await member.client.rpc("recent_mfa_assertion", {
      max_age: "1 hour",
    });
    expect(never).toBe(false);
  });

  it("locks Recovery Code attempts after five failures and alerts an Admin", async () => {
    const member = await createWorkspaceMember("member");

    for (let failure = 1; failure <= 5; failure += 1) {
      const { data } = await admin.rpc("register_mfa_recovery_failure", {
        target_user_id: member.userId,
      });
      expect(data).toBe("allowed");
    }
    const { data: locked } = await admin.rpc("register_mfa_recovery_failure", {
      target_user_id: member.userId,
    });
    expect(locked).toBe("locked");

    const { data: isLocked } = await admin.rpc("mfa_recovery_locked", {
      target_user_id: member.userId,
    });
    expect(isLocked).toBe(true);

    const { data: audit, error: auditError } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("entity_id", member.userId);
    if (auditError) throw auditError;
    const actions = audit.map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "auth.mfa.recovery_failed",
        "auth.mfa.recovery_locked",
      ])
    );
    expect(
      actions.filter((action) => action === "auth.mfa.recovery_locked")
    ).toHaveLength(1);

    const { error: expireError } = await admin
      .from("rate_limit_state")
      .update({
        locked_until: new Date(Date.now() - ms("1m")).toISOString(),
      })
      .eq("bucket", "auth.recovery");
    if (expireError) throw expireError;
    const { data: reopened } = await admin.rpc("mfa_recovery_locked", {
      target_user_id: member.userId,
    });
    expect(reopened).toBe(false);
  });

  it("requires immutable current Legal Document acceptance before gated access", async () => {
    const { client: initialAdmin, userId: initialAdminId } =
      await createWorkspaceMember("admin");
    const { client: member } = await createWorkspaceMember("member");

    const { error: initialAdminError } = await admin
      .from("workspace_members")
      .update({ is_initial_admin: true })
      .eq("workspace_id", workspaceId)
      .eq("user_id", initialAdminId);
    if (initialAdminError) throw initialAdminError;

    const { data: notReadyBeforeGate } = await admin.rpc(
      "legal_package_ready",
      { target_workspace_id: workspaceId }
    );
    expect(notReadyBeforeGate).toBe(false);
    const { error: prematureGateError } = await admin
      .from("workspaces")
      .update({ legal_gate_required: true })
      .eq("id", workspaceId);
    expect(prematureGateError?.message).toMatch(
      /four operator-approved core Legal Documents/i
    );

    const approvalTimestamp = new Date(Date.now() - 1_000).toISOString();
    const { data: requiredDocuments, error: documentsError } = await admin
      .from("legal_documents")
      .select("id, document_type")
      .in("document_type", [
        "terms",
        "privacy",
        "dpa",
        "recording_responsibilities",
      ]);
    if (documentsError) throw documentsError;
    const testVersion = `test-${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
    const { error: publishError } = await admin
      .from("legal_document_versions")
      .insert(
        requiredDocuments.map((document) => {
          const content = `Approved test ${document.document_type} content.`;
          return {
            document_id: document.id,
            version: testVersion,
            content_markdown: content,
            content_sha256: createHash("sha256").update(content).digest("hex"),
            is_material: true,
            published_at: approvalTimestamp,
            effective_at: approvalTimestamp,
            operator_approved_at: approvalTimestamp,
            operator_approval_reference: "test-operator-approval",
          };
        })
      );
    if (publishError) throw publishError;

    const { error: gateError } = await admin
      .from("workspaces")
      .update({ legal_gate_required: true })
      .eq("id", workspaceId);
    if (gateError) throw gateError;

    const { data: packageReady } = await admin.rpc("legal_package_ready", {
      target_workspace_id: workspaceId,
    });
    expect(packageReady).toBe(true);

    const { data: initialRequired, error: initialRequiredError } =
      await initialAdmin.rpc("required_legal_documents_for_current_user");
    if (initialRequiredError) throw initialRequiredError;
    expect(initialRequired).toHaveLength(4);
    expect(
      initialRequired.map(
        (document: { document_type: string }) => document.document_type
      )
    ).toEqual(["dpa", "privacy", "recording_responsibilities", "terms"]);

    const { data: memberRequired, error: memberRequiredError } =
      await member.rpc("required_legal_documents_for_current_user");
    if (memberRequiredError) throw memberRequiredError;
    expect(memberRequired).toHaveLength(2);

    const { data: beforeAcceptance } = await initialAdmin.rpc(
      "legal_gate_satisfied_for_current_user"
    );
    expect(beforeAcceptance).toBe(false);

    const initialVersionIds = initialRequired.map(
      (document: { version_id: string }) => document.version_id
    );
    const { error: partialError } = await initialAdmin.rpc(
      "accept_current_legal_documents",
      { target_version_ids: initialVersionIds.slice(0, 2) }
    );
    expect(partialError?.message).toMatch(/Every current required/i);
    const { error: extraVersionError } = await member.rpc(
      "accept_current_legal_documents",
      {
        target_version_ids: [
          ...memberRequired.map(
            (document: { version_id: string }) => document.version_id
          ),
          initialVersionIds[0],
        ],
      }
    );
    expect(extraVersionError?.message).toMatch(/Every current required/i);

    const { data: acceptedCount, error: acceptanceError } =
      await initialAdmin.rpc("accept_current_legal_documents", {
        target_version_ids: initialVersionIds,
      });
    expect(acceptanceError).toBeNull();
    expect(acceptedCount).toBe(4);

    const { data: afterAcceptance } = await initialAdmin.rpc(
      "legal_gate_satisfied_for_current_user"
    );
    expect(afterAcceptance).toBe(true);

    const { data: acceptance } = await admin
      .from("legal_acceptances")
      .select("id")
      .eq("user_id", initialAdminId)
      .limit(1)
      .single();
    const { error: acceptanceMutationError } = await admin
      .from("legal_acceptances")
      .update({ accepted_at: new Date(0).toISOString() })
      .eq("id", acceptance!.id);
    expect(acceptanceMutationError).not.toBeNull();

    const termsDocument = requiredDocuments.find(
      (document) => document.document_type === "terms"
    )!;
    const nextTerms = "Materially updated pilot terms.";
    // Backdated like the first publication so the version is already effective
    // when the gate evaluates it, whatever the database clock reads.
    const materialTimestamp = new Date(Date.now() - 1_000).toISOString();
    const { error: nextTermsError } = await admin
      .from("legal_document_versions")
      .insert({
        document_id: termsDocument.id,
        version: `test-${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`,
        content_markdown: nextTerms,
        content_sha256: createHash("sha256").update(nextTerms).digest("hex"),
        is_material: true,
        published_at: materialTimestamp,
        effective_at: materialTimestamp,
        operator_approved_at: materialTimestamp,
        operator_approval_reference: "test-material-update",
      });
    if (nextTermsError) throw nextTermsError;

    const { data: afterMaterialChange } = await initialAdmin.rpc(
      "legal_gate_satisfied_for_current_user"
    );
    expect(afterMaterialChange).toBe(false);
  });

  it("retains uploaded Source Audio when an Incomplete Recording ages out", async () => {
    const { userId } = await createWorkspaceMember();
    const oldTimestamp = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const { callId, chunkPrefix } = await createCall(userId, {
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });
    const chunkPath = `${chunkPrefix}/00000000.webm`;
    const { error: uploadError } = await admin.storage
      .from("recordings")
      .upload(chunkPath, Buffer.from("recoverable Source Audio"), {
        contentType: "audio/webm",
      });
    if (uploadError) throw uploadError;

    try {
      const { cleanupAbandonedCalls } = await import("./jobs.js");
      await cleanupAbandonedCalls();

      const { data: storedCall } = await admin
        .from("calls")
        .select("status")
        .eq("id", callId)
        .single();
      expect(storedCall?.status).toBe("abandoned");

      const { data: retainedAudio, error: downloadError } = await admin.storage
        .from("recordings")
        .download(chunkPath);
      expect(downloadError).toBeNull();
      await expect(retainedAudio?.text()).resolves.toBe(
        "recoverable Source Audio"
      );
    } finally {
      await admin.storage.from("recordings").remove([chunkPath]);
    }
  }, 20_000);

  it("does not claim a call-bound job after its Call is deleted", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `deleted-call:${callId}`,
    });
    if (insertError) throw insertError;

    const { error: deleteError } = await admin
      .from("calls")
      .delete()
      .eq("id", callId);
    if (deleteError) throw deleteError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "orphan-check-worker" }
    );

    expect(claimError).toBeNull();
    expect(
      (claimed ?? []).some(
        (job: { call_id: string | null; kind: string }) =>
          job.call_id === null && job.kind !== "cleanup_abandoned"
      )
    ).toBe(false);
    const { data: orphanedJob } = await admin
      .from("processing_jobs")
      .select("call_id, status")
      .eq("id", jobId)
      .single();
    expect(orphanedJob).toEqual({
      call_id: null,
      status: "failed",
    });
  });

  it("reclaims a stale Transcription Job after its worker disappears", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const staleLock = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "processing",
      idempotency_key: `reclaim:${callId}`,
      attempts: 1,
      max_attempts: 3,
      locked_at: staleLock,
      locked_by: "worker-that-disappeared",
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "replacement-worker" }
    );

    expect(claimError).toBeNull();
    expect(claimed).toHaveLength(1);
    expect(claimed?.[0]).toMatchObject({
      id: jobId,
      status: "processing",
      attempts: 2,
      locked_by: "replacement-worker",
    });
    const { data: processingCall } = await admin
      .from("calls")
      .select("status")
      .eq("id", callId)
      .single();
    expect(processingCall?.status).toBe("processing");
  });

  it("renews an active job lease only for its current token", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `heartbeat:${callId}`,
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "active-worker" }
    );
    if (claimError) throw claimError;
    const leaseToken = claimed?.[0]?.lease_token;
    expect(leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const { data: renewed, error: renewError } = await admin.rpc(
      "renew_processing_job_lease",
      {
        target_job_id: jobId,
        target_lease_token: leaseToken,
      }
    );
    expect(renewError).toBeNull();
    expect(renewed).toBe(true);

    const { data: rejected } = await admin.rpc("renew_processing_job_lease", {
      target_job_id: jobId,
      target_lease_token: crypto.randomUUID(),
    });
    expect(rejected).toBe(false);
  });

  it("commits processed recording state only for the current lease owner", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `commit:${callId}`,
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "commit-worker" }
    );
    if (claimError) throw claimError;
    const leaseToken = claimed?.[0]?.lease_token as string;
    const commitArgs = {
      target_job_id: jobId,
      target_source_path: `${workspaceId}/${callId}/artifacts/source.webm`,
      target_mp3_path: `${workspaceId}/${callId}/artifacts/recording.mp3`,
      target_source_bytes: 42,
      target_model: "test/model",
      target_language: "en",
      target_full_text: "lease fenced transcript",
      target_provider_generation_id: "generation-id",
      target_provider_cost_usd: 0.25,
      target_provider_duration_seconds: 1.5,
      target_segments: [
        {
          sequence: 0,
          start_ms: 0,
          end_ms: 1_500,
          text: "lease fenced transcript",
        },
      ],
    };

    const { data: rejected } = await admin.rpc("commit_processed_recording", {
      ...commitArgs,
      target_lease_token: crypto.randomUUID(),
    });
    expect(rejected).toBe(false);
    const { data: unchangedCall } = await admin
      .from("calls")
      .select("status, source_path")
      .eq("id", callId)
      .single();
    expect(unchangedCall).toEqual({
      status: "processing",
      source_path: null,
    });

    const { data: committed, error: commitError } = await admin.rpc(
      "commit_processed_recording",
      {
        ...commitArgs,
        target_lease_token: leaseToken,
      }
    );
    expect(commitError).toBeNull();
    expect(committed).toBe(true);

    const { data: readyCall } = await admin
      .from("calls")
      .select("status, source_path, mp3_path, source_bytes")
      .eq("id", callId)
      .single();
    expect(readyCall).toMatchObject({
      status: "ready",
      source_path: commitArgs.target_source_path,
      mp3_path: commitArgs.target_mp3_path,
      source_bytes: 42,
    });
    const { data: transcript } = await admin
      .from("transcripts")
      .select(
        "full_text, transcript_segments(sequence, start_ms, end_ms, text)"
      )
      .eq("call_id", callId)
      .single();
    expect(transcript).toMatchObject({
      full_text: "lease fenced transcript",
      transcript_segments: [
        {
          sequence: 0,
          start_ms: 0,
          end_ms: 1_500,
          text: "lease fenced transcript",
        },
      ],
    });
    const { data: completedJob } = await admin
      .from("processing_jobs")
      .select("status, lease_token, finished_at")
      .eq("id", jobId)
      .single();
    expect(completedJob).toMatchObject({
      status: "complete",
      lease_token: null,
    });
    expect(completedJob?.finished_at).not.toBeNull();
  });

  it("commits WAV export state only for the current lease owner", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const exportJobId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { error: exportError } = await admin.from("export_jobs").insert({
      id: exportJobId,
      call_id: callId,
      requested_by: userId,
      format: "wav",
      status: "queued",
    });
    if (exportError) throw exportError;
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "generate_wav",
      status: "queued",
      idempotency_key: `wav-commit:${callId}`,
      payload: { exportJobId },
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "wav-worker" }
    );
    if (claimError) throw claimError;
    const leaseToken = claimed?.[0]?.lease_token as string;
    const wavPath = `${workspaceId}/${callId}/artifacts/recording.wav`;

    const { data: rejected } = await admin.rpc("commit_wav_export", {
      target_job_id: jobId,
      target_lease_token: crypto.randomUUID(),
      target_wav_path: wavPath,
    });
    expect(rejected).toBe(false);

    const { data: committed, error: commitError } = await admin.rpc(
      "commit_wav_export",
      {
        target_job_id: jobId,
        target_lease_token: leaseToken,
        target_wav_path: wavPath,
      }
    );
    expect(commitError).toBeNull();
    expect(committed).toBe(true);

    const [{ data: call }, { data: exportJob }, { data: completedJob }] =
      await Promise.all([
        admin.from("calls").select("wav_path").eq("id", callId).single(),
        admin
          .from("export_jobs")
          .select("status, completed_at")
          .eq("id", exportJobId)
          .single(),
        admin
          .from("processing_jobs")
          .select("status, lease_token")
          .eq("id", jobId)
          .single(),
      ]);
    expect(call?.wav_path).toBe(wavPath);
    expect(exportJob?.status).toBe("complete");
    expect(exportJob?.completed_at).not.toBeNull();
    expect(completedJob).toEqual({
      status: "complete",
      lease_token: null,
    });
  });

  it("deletes a Call only for the current deletion-job lease owner", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId);
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "delete_call",
      status: "queued",
      idempotency_key: `delete-commit:${callId}`,
    });
    if (insertError) throw insertError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "delete-worker" }
    );
    if (claimError) throw claimError;
    expect(claimed).toHaveLength(1);
    expect(claimed?.[0]?.id).toBe(jobId);
    const leaseToken = claimed?.[0]?.lease_token as string;

    const { data: rejected } = await admin.rpc("commit_call_deletion", {
      target_job_id: jobId,
      target_lease_token: crypto.randomUUID(),
    });
    expect(rejected).toBe(false);
    const { count: retainedCount } = await admin
      .from("calls")
      .select("id", { count: "exact", head: true })
      .eq("id", callId);
    expect(retainedCount).toBe(1);

    const { data: committed, error: commitError } = await admin.rpc(
      "commit_call_deletion",
      {
        target_job_id: jobId,
        target_lease_token: leaseToken,
      }
    );
    if (commitError) throw commitError;
    expect(committed).toBe(true);

    const [{ count: callCount }, { data: completedJob }] = await Promise.all([
      admin
        .from("calls")
        .select("id", { count: "exact", head: true })
        .eq("id", callId),
      admin
        .from("processing_jobs")
        .select("status, call_id, lease_token")
        .eq("id", jobId)
        .single(),
    ]);
    expect(callCount).toBe(0);
    expect(completedJob).toEqual({
      status: "complete",
      call_id: null,
      lease_token: null,
    });
  });

  it("pauses transcription on a spent budget without consuming an attempt", async () => {
    const { userId } = await createWorkspaceMember();
    // One hour of audio at the worst active price is well over a cent, so a
    // one-cent limit is guaranteed to be in the way.
    const { callId } = await createCall(userId, {
      status: "queued",
      duration_ms: ms("1h"),
      stopped_at: new Date().toISOString(),
    });
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { error: insertError } = await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `budget-pause:${callId}`,
    });
    if (insertError) throw insertError;

    const { error: budgetError } = await admin
      .from("workspace_processing_budget")
      .insert({ workspace_id: workspaceId, daily_limit_usd: 0.01 });
    if (budgetError) throw budgetError;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "budget-worker" }
    );
    if (claimError) throw claimError;
    expect(claimed).toHaveLength(0);

    const { data: pausedJob } = await admin
      .from("processing_jobs")
      .select("status, attempts, budget_paused_reason, budget_reserved_usd")
      .eq("id", jobId)
      .single();
    expect(pausedJob).toEqual({
      status: "budget_paused",
      attempts: 0,
      budget_paused_reason: "workspace_limit",
      budget_reserved_usd: 0,
    });

    // The Call says so too, in words its Admin can repeat to the Call's owner.
    const { data: pausedCall } = await admin
      .from("calls")
      .select("status, error_message, source_path, deleted_at")
      .eq("id", callId)
      .single();
    expect(pausedCall?.status).toBe("budget_paused");
    expect(pausedCall?.error_message).toContain("Your recording is safe");
    expect(pausedCall?.deleted_at).toBeNull();

    const { data: pauseEvents } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("entity_id", jobId)
      .eq("action", "processing.budget.paused");
    expect(pauseEvents).toHaveLength(1);
    expect(pauseEvents?.[0]?.metadata).toMatchObject({
      reason_code: "workspace_limit",
    });

    // Nothing was charged for work that never started.
    const { data: ledger } = await admin
      .from("processing_spend")
      .select("reserved_usd, settled_usd")
      .eq("workspace_id", workspaceId);
    expect(Number(ledger?.[0]?.reserved_usd ?? 0)).toBe(0);
  });

  it("keeps recording and Source Audio capture working while Budget Paused", async () => {
    const { client, userId } = await createWorkspaceMember();
    const { error: budgetError } = await admin
      .from("workspace_processing_budget")
      .insert({ workspace_id: workspaceId, daily_limit_usd: 0 });
    if (budgetError) throw budgetError;

    const pausedCallId = crypto.randomUUID();
    createdCallIds.push(pausedCallId);
    const { error: pausedInsertError } = await admin.from("calls").insert({
      id: pausedCallId,
      workspace_id: workspaceId,
      owner_id: userId,
      source_mode: "mic",
      status: "queued",
      duration_ms: ms("1h"),
      chunk_prefix: `${workspaceId}/${pausedCallId}/chunks`,
      recording_attested_by: userId,
      recording_attested_at: new Date().toISOString(),
    });
    if (pausedInsertError) throw pausedInsertError;
    const pausedJobId = crypto.randomUUID();
    createdJobIds.push(pausedJobId);
    await admin.from("processing_jobs").insert({
      id: pausedJobId,
      workspace_id: workspaceId,
      call_id: pausedCallId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `budget-capture:${pausedCallId}`,
    });
    await admin.rpc("claim_processing_job", { worker_name: "budget-worker" });

    // A spent budget must not become a recording outage: a Workspace Member
    // can still start a new Call and its Source Audio still lands.
    const newCallId = crypto.randomUUID();
    createdCallIds.push(newCallId);
    const { data: created, error: createError } = await client.rpc(
      "create_attested_call_for_current_user",
      {
        target_call_id: newCallId,
        target_source_mode: "mic",
        target_mic_label: "Built-in",
        target_tab_label: "",
        target_title: null,
        target_recording_attested: true,
      }
    );
    if (createError) throw createError;
    expect((created as { status: string }).status).toBe("recording");

    const { data: finalized, error: finalizeError } = await client.rpc(
      "finalize_owned_call",
      {
        target_call_id: newCallId,
        final_chunk_sequence: 0,
        target_duration_ms: 1_000,
        target_mime_type: "audio/webm;codecs=opus",
        target_source_mode: "mic",
        target_mic_label: "Built-in",
        target_tab_label: "",
        target_degraded_intervals: [],
      }
    );
    if (finalizeError) throw finalizeError;
    expect((finalized as { status: string }).status).toBe("queued");
  });

  it("cannot overspend a budget through racing workers", async () => {
    const { userId } = await createWorkspaceMember();
    const jobIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { callId } = await createCall(userId, {
        status: "queued",
        duration_ms: ms("1h"),
        stopped_at: new Date().toISOString(),
      });
      const jobId = crypto.randomUUID();
      jobIds.push(jobId);
      createdJobIds.push(jobId);
      await admin.from("processing_jobs").insert({
        id: jobId,
        workspace_id: workspaceId,
        call_id: callId,
        kind: "process_recording",
        status: "queued",
        idempotency_key: `budget-race-${index}:${callId}`,
      });
    }

    const { data: unitCost, error: costError } = await admin.rpc(
      "estimated_transcription_cost_usd",
      { target_duration_ms: ms("1h") }
    );
    if (costError) throw costError;
    const perJob = Number(unitCost);
    expect(perJob).toBeGreaterThan(0);

    // Exactly two of the five fit. Five workers ask at once.
    const limit = perJob * 2.5;
    await admin
      .from("workspace_processing_budget")
      .insert({ workspace_id: workspaceId, daily_limit_usd: limit.toFixed(2) });

    const claims = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        admin.rpc("claim_processing_job", { worker_name: `race-${index}` })
      )
    );
    for (const claim of claims) {
      if (claim.error) throw claim.error;
    }

    const { data: finalJobs } = await admin
      .from("processing_jobs")
      .select("status")
      .in("id", jobIds);
    const claimedCount = (finalJobs ?? []).filter(
      (job) => job.status === "processing"
    ).length;
    expect(claimedCount).toBe(2);

    const { data: ledger } = await admin
      .from("processing_spend")
      .select("reserved_usd")
      .eq("workspace_id", workspaceId)
      .single();
    expect(Number(ledger?.reserved_usd)).toBeLessThanOrEqual(limit);
    expect(Number(ledger?.reserved_usd)).toBeCloseTo(perJob * 2, 6);
  });

  it("warns a Platform Admin at 80% before any work is paused", async () => {
    const sinceEventId = await latestAuditEventId();
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId, {
      status: "queued",
      duration_ms: ms("1h"),
      stopped_at: new Date().toISOString(),
    });
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `budget-warn:${callId}`,
    });

    const { data: unitCost } = await admin.rpc(
      "estimated_transcription_cost_usd",
      { target_duration_ms: ms("1h") }
    );
    // A limit this job fills to 90% of: above the 80% warning, below the pause.
    await admin.from("workspace_processing_budget").insert({
      workspace_id: workspaceId,
      daily_limit_usd: (Number(unitCost) / 0.9).toFixed(2),
    });

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_processing_job",
      { worker_name: "warn-worker" }
    );
    if (claimError) throw claimError;
    expect(claimed).toHaveLength(1);

    const { data: warnings } = await admin
      .from("audit_events")
      .select("id, action, entity_type, entity_id, metadata, workspace_id")
      .eq("action", "platform.budget.warned")
      .eq("entity_id", workspaceId)
      .gt("id", sinceEventId);
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]?.metadata).toMatchObject({ scope: "workspace" });
    // Warnings belong to the operator, not to the Workspace's own Audit Log.
    expect(warnings?.[0]?.workspace_id).not.toBe(workspaceId);

    // A second claim on the same day does not warn twice.
    await admin.rpc("claim_processing_job", { worker_name: "warn-worker" });
    const { count: warningCount } = await admin
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("action", "platform.budget.warned")
      .eq("entity_id", workspaceId)
      .gt("id", sinceEventId);
    expect(warningCount).toBe(1);
  });

  it("resumes Budget Paused work after a limit change and after the daily reset", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId, {
      status: "queued",
      duration_ms: ms("1h"),
      stopped_at: new Date().toISOString(),
    });
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `budget-resume:${callId}`,
    });
    await admin
      .from("workspace_processing_budget")
      .insert({ workspace_id: workspaceId, daily_limit_usd: 0 });
    await admin.rpc("claim_processing_job", { worker_name: "resume-worker" });
    const { data: paused } = await admin
      .from("processing_jobs")
      .select("status")
      .eq("id", jobId)
      .single();
    expect(paused?.status).toBe("budget_paused");

    // A raised limit is enough on its own: nobody has to press retry.
    await admin
      .from("workspace_processing_budget")
      .update({ daily_limit_usd: 10 })
      .eq("workspace_id", workspaceId);
    const { data: resumedCount, error: resumeError } = await admin.rpc(
      "resume_budget_paused_jobs"
    );
    if (resumeError) throw resumeError;
    expect(resumedCount).toBe(1);

    const [{ data: resumedJob }, { data: resumedCall }] = await Promise.all([
      admin
        .from("processing_jobs")
        .select("status, attempts, budget_paused_reason")
        .eq("id", jobId)
        .single(),
      admin
        .from("calls")
        .select("status, error_message")
        .eq("id", callId)
        .single(),
    ]);
    expect(resumedJob).toEqual({
      status: "queued",
      attempts: 0,
      budget_paused_reason: null,
    });
    expect(resumedCall).toEqual({ status: "queued", error_message: null });

    const { data: resumeEvents } = await admin
      .from("audit_events")
      .select("action")
      .eq("entity_id", jobId)
      .eq("action", "processing.budget.resumed");
    expect(resumeEvents).toHaveLength(1);

    // The daily reset is the same mechanism seen from the other side: the
    // ledger is keyed by day, so yesterday's spending stops being in the way
    // without anybody resetting a counter.
    await admin
      .from("processing_jobs")
      .update({
        status: "budget_paused",
        budget_paused_reason: "workspace_limit",
      })
      .eq("id", jobId);
    const today = new Date().toISOString().slice(0, 10);
    await admin.from("processing_spend").upsert({
      spend_date: today,
      workspace_id: workspaceId,
      settled_usd: 9.99,
    });
    const { data: stillPaused } = await admin.rpc("resume_budget_paused_jobs");
    expect(stillPaused).toBe(0);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    await admin
      .from("processing_spend")
      .update({ spend_date: yesterday })
      .eq("spend_date", today)
      .eq("workspace_id", workspaceId);
    const { data: resumedNextDay } = await admin.rpc(
      "resume_budget_paused_jobs"
    );
    expect(resumedNextDay).toBe(1);
  });

  it("lets only a Platform Admin move a budget, and only a Workspace Admin read it", async () => {
    const sinceEventId = await latestAuditEventId();
    const { client: adminClient, userId: adminUserId } =
      await createWorkspaceMember("admin");
    const { client: memberClient } = await createWorkspaceMember();

    const { error: deniedPlatform } = await adminClient.rpc(
      "set_platform_processing_budget",
      { target_daily_limit_usd: 500 }
    );
    expect(deniedPlatform?.message).toContain("Platform Admin");

    const { error: deniedWorkspace } = await adminClient.rpc(
      "set_workspace_processing_budget",
      { target_workspace_id: workspaceId, target_daily_limit_usd: 500 }
    );
    expect(deniedWorkspace?.message).toContain("Platform Admin");

    const { data: unchanged } = await admin
      .from("platform_processing_budget")
      .select("daily_limit_usd")
      .single();
    expect(Number(unchanged?.daily_limit_usd)).toBe(50);

    // The pause and its operational reason are the Admin's to see.
    const { data: status, error: statusError } = await adminClient.rpc(
      "workspace_processing_budget_status"
    );
    if (statusError) throw statusError;
    expect(status).toMatchObject({
      dailyLimitUsd: 10,
      pausedJobCount: 0,
      editable: false,
    });
    expect(status).not.toHaveProperty("platformLimitUsd");

    const { error: memberDenied } = await memberClient.rpc(
      "workspace_processing_budget_status"
    );
    expect(memberDenied?.message).toContain("Workspace Admin");

    // The same call from an operator succeeds and is audited.
    const { error: grantError } = await admin
      .from("platform_admins")
      .insert({ user_id: adminUserId });
    if (grantError) throw grantError;
    const { data: changed, error: changeError } = await adminClient.rpc(
      "set_platform_processing_budget",
      { target_daily_limit_usd: 75 }
    );
    if (changeError) throw changeError;
    expect(changed).toMatchObject({ dailyLimitUsd: 75 });

    const { data: budgetEvents } = await admin
      .from("audit_events")
      .select("id, action, entity_type, metadata")
      .eq("action", "platform.budget.changed")
      .eq("entity_type", "platform_budget")
      .gt("id", sinceEventId);
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents?.[0]?.metadata).toMatchObject({ limit_usd: 75 });
  });

  it("raises the operational alerts an operator is expected to act on", async () => {
    const { userId } = await createWorkspaceMember();

    const { data: quiet, error: quietError } = await admin.rpc(
      "processing_operational_alerts"
    );
    if (quietError) throw quietError;
    expect(quiet).toEqual([]);

    // A job that has been waiting longer than the five-minute queue budget.
    const { callId } = await createCall(userId, {
      status: "queued",
      duration_ms: ms("1h"),
      stopped_at: new Date().toISOString(),
    });
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `alert-queue:${callId}`,
      next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const { data: queued } = await admin.rpc("processing_operational_alerts");
    const queueAlert = (
      queued as Array<{ alert: string; detail: { queueAgeSeconds: number } }>
    ).find((entry) => entry.alert === "processing.queue_age");
    expect(queueAlert).toBeDefined();
    expect(queueAlert?.detail.queueAgeSeconds).toBeGreaterThan(300);

    // Repeated exhaustion is its own signal, separate from a slow queue.
    for (let index = 0; index < 3; index += 1) {
      const { callId: attentionCallId } = await createCall(userId);
      const attentionJobId = crypto.randomUUID();
      createdJobIds.push(attentionJobId);
      await admin.from("processing_jobs").insert({
        id: attentionJobId,
        workspace_id: workspaceId,
        call_id: attentionCallId,
        kind: "process_recording",
        status: "failed",
        attempts: 3,
        max_attempts: 3,
        finished_at: new Date().toISOString(),
        idempotency_key: `alert-attention-${index}:${attentionCallId}`,
      });
    }
    const { data: attention } = await admin.rpc(
      "processing_operational_alerts"
    );
    expect(
      (attention as Array<{ alert: string }>).map((entry) => entry.alert)
    ).toContain("processing.needs_attention");
  });

  it("reports provider incidents apart from Cauli missing its own target", async () => {
    const { userId } = await createWorkspaceMember();
    const jobIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { callId } = await createCall(userId, {
        status: "queued",
        duration_ms: ms("1h"),
        stopped_at: new Date().toISOString(),
      });
      const jobId = crypto.randomUUID();
      jobIds.push(jobId);
      createdJobIds.push(jobId);
      await admin.from("processing_jobs").insert({
        id: jobId,
        workspace_id: workspaceId,
        call_id: callId,
        kind: "process_recording",
        status: "queued",
        idempotency_key: `alert-provider-${index}:${callId}`,
      });
      const { data: claimed } = await admin.rpc("claim_processing_job", {
        worker_name: `provider-${index}`,
      });
      expect((claimed as Array<{ id: string }>)[0]?.id).toBe(jobId);
      // The provider was unavailable; Cauli itself was not at fault.
      const { error: failError } = await admin
        .from("processing_jobs")
        .update({
          status: "failed",
          attempts: 3,
          error_category: "provider_unavailable",
          finished_at: new Date().toISOString(),
        })
        .eq("id", jobId);
      if (failError) throw failError;
    }

    const { data: runs } = await admin
      .from("processing_runs")
      .select("outcome, error_category, counts_toward_target")
      .in("job_id", jobIds);
    expect(runs).toHaveLength(3);
    for (const run of runs ?? []) {
      expect(run.outcome).toBe("failed");
      expect(run.error_category).toBe("provider_unavailable");
    }

    // Reported as a provider incident and still counted against the target:
    // visible as both, excused as neither.
    const { data: level } = await admin.rpc("processing_service_level", {
      window_hours: 1,
    });
    expect(level).toMatchObject({ eligibleCalls: 3, providerIncidents: 3 });

    const { data: alerts } = await admin.rpc("processing_operational_alerts");
    expect(
      (alerts as Array<{ alert: string }>).map((entry) => entry.alert)
    ).toContain("processing.provider_incident");
  });

  it("pages 250+ Calls by cursor and stays correct as Calls change", async () => {
    const { client, userId } = await createWorkspaceMember("manager");
    const total = 260;
    const base = Date.parse("2026-06-01T00:00:00.000Z");
    // Seeded rows are cleaned up in bulk by owner below rather than one
    // identifier at a time: 260 of them in a shared teardown makes a request
    // line long enough to be its own failure.
    const rows = Array.from({ length: total }, (_unused, index) => {
      const callId = crypto.randomUUID();
      return {
        id: callId,
        workspace_id: workspaceId,
        owner_id: userId,
        title: `Call ${String(index).padStart(3, "0")}`,
        source_mode: "mic" as const,
        status: "ready" as const,
        chunk_prefix: `${workspaceId}/${callId}/chunks`,
        started_at: new Date(base + index * 60_000).toISOString(),
        recording_attested_by: userId,
        recording_attested_at: new Date(base).toISOString(),
      };
    });
    const { error: seedError } = await admin.from("calls").insert(rows);
    if (seedError) throw seedError;

    async function page(cursor: { startedAt: string; id: string } | null) {
      const { data, error } = await client.rpc("list_calls_page", {
        cursor_started_at: cursor?.startedAt ?? null,
        cursor_id: cursor?.id ?? null,
      });
      if (error) throw error;
      return data as Array<{ id: string; started_at: string; title: string }>;
    }

    // A page is 50 Calls plus the one row that answers "is there more".
    const first = await page(null);
    expect(first).toHaveLength(51);
    const seen = new Set<string>();
    let walked = 0;
    let cursor: { startedAt: string; id: string } | null = null;
    for (let index = 0; index < 8; index += 1) {
      const rowsPage: Array<{ id: string; started_at: string }> =
        await page(cursor);
      const visible = rowsPage.slice(0, 50);
      for (const row of visible) {
        // No Call is ever shown twice, which is the whole point of a cursor.
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      walked += visible.length;
      if (rowsPage.length <= 50) break;
      const last = visible[visible.length - 1]!;
      cursor = { startedAt: last.started_at, id: last.id };
    }
    expect(walked).toBe(total);

    // Now change the set between two page requests: a newer Call inserted
    // above page one, and a Call deleted below the cursor.
    const restartFirst = await page(null);
    const boundary = restartFirst[49]!;
    const newerId = crypto.randomUUID();
    await admin.from("calls").insert({
      id: newerId,
      workspace_id: workspaceId,
      owner_id: userId,
      title: "Inserted between pages",
      source_mode: "mic",
      status: "ready",
      chunk_prefix: `${workspaceId}/${newerId}/chunks`,
      started_at: new Date(base + total * 60_000).toISOString(),
      recording_attested_by: userId,
      recording_attested_at: new Date(base).toISOString(),
    });
    const droppedId = restartFirst[50]!.id;
    await admin
      .from("calls")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", droppedId);

    const secondPage = await page({
      startedAt: boundary.started_at,
      id: boundary.id,
    });
    // The insert went above the cursor, so it cannot shift page two down...
    expect(secondPage.map((row) => row.id)).not.toContain(newerId);
    // ...and the deleted Call is simply gone rather than leaving a hole.
    expect(secondPage.map((row) => row.id)).not.toContain(droppedId);
    for (const row of secondPage) {
      expect(
        restartFirst.slice(0, 50).map((seenRow) => seenRow.id)
      ).not.toContain(row.id);
    }

    const { error: cleanupError } = await admin
      .from("calls")
      .delete()
      .eq("owner_id", userId);
    if (cleanupError) throw cleanupError;
  });

  it("filters, searches metadata only, and never reads a Transcript", async () => {
    const { client, userId } = await createWorkspaceMember("manager");
    const workspaceAdmin = await createWorkspaceMember("admin");
    const { callId: degradedId } = await createCall(userId, {
      title: "Renewal conversation",
      status: "ready",
      degraded_intervals: [{ source: "mic", startMs: 0, endMs: 10 }],
      started_at: "2026-06-10T10:00:00.000Z",
    });
    const { callId: cleanId } = await createCall(userId, {
      title: "Onboarding walkthrough",
      status: "failed",
      started_at: "2026-06-11T10:00:00.000Z",
    });

    // A Transcript whose text matches nothing in any title.
    const { data: transcript, error: transcriptError } = await admin
      .from("transcripts")
      .insert({
        call_id: cleanId,
        model: "openai/whisper-large-v3-turbo",
        full_text: "the customer mentioned pomegranate pricing",
      })
      .select("id")
      .single();
    if (transcriptError) throw transcriptError;
    expect(transcript.id).toBeTruthy();

    const { data: scorecardVersionId, error: publishError } = await admin.rpc(
      "publish_scorecard",
      {
        target_workspace_id: workspaceId,
        target_template_id: null,
        target_name: "Discovery filter Scorecard",
        target_actor_id: userId,
        target_categories: [
          {
            name: "Quality",
            criteria: [
              {
                label: "Complete the action",
                weight: 1,
                required: true,
              },
            ],
          },
        ],
      }
    );
    if (publishError) throw publishError;
    const { data: scorecardVersion, error: scorecardVersionError } = await admin
      .from("scorecard_versions")
      .select("template_id")
      .eq("id", scorecardVersionId)
      .single();
    if (scorecardVersionError) throw scorecardVersionError;
    createdScorecardTemplateIds.push(scorecardVersion.template_id);

    const { data: category, error: categoryError } = await admin
      .from("scorecard_categories")
      .select("id")
      .eq("version_id", scorecardVersionId)
      .single();
    if (categoryError) throw categoryError;
    const { data: criterion, error: criterionError } = await admin
      .from("scorecard_criteria")
      .select("id")
      .eq("category_id", category.id)
      .single();
    if (criterionError) throw criterionError;

    for (const submission of [
      {
        callId: degradedId,
        summary: "Open tracked Follow-up.",
        followUp: "Complete the open action.",
      },
      {
        callId: cleanId,
        summary: "Resolved tracked Follow-up.",
        followUp: "Complete the resolved action.",
      },
    ]) {
      const { error: submitError } = await workspaceAdmin.client.rpc(
        "submit_call_review_with_follow_up",
        {
          target_call_id: submission.callId,
          target_scorecard_version_id: scorecardVersionId,
          expected_version: 0,
          expected_assignment_version: 0,
          target_status: "needs_follow_up",
          target_summary: submission.summary,
          target_follow_up: submission.followUp,
          target_follow_up_due_date: null,
          target_answers: [
            {
              criterionId: criterion.id,
              value: 3,
              comment: "",
            },
          ],
        }
      );
      if (submitError) throw submitError;
    }

    const { error: assignmentError } = await workspaceAdmin.client.rpc(
      "assign_review",
      {
        target_call_id: degradedId,
        target_assignee_id: userId,
        expected_assignment_version: 0,
      }
    );
    if (assignmentError) throw assignmentError;
    const { data: resolvedFollowUp, error: resolvedFollowUpError } =
      await client
        .from("follow_ups")
        .select("id, version")
        .eq("call_id", cleanId)
        .single();
    if (resolvedFollowUpError) throw resolvedFollowUpError;
    const { error: resolveError } = await client.rpc("resolve_follow_up", {
      target_follow_up_id: resolvedFollowUp.id,
      expected_version: resolvedFollowUp.version,
    });
    if (resolveError) throw resolveError;

    async function search(args: Record<string, unknown>) {
      const { data, error } = await client.rpc("list_calls_page", args);
      if (error) throw error;
      return (data as Array<{ id: string }>).map((row) => row.id);
    }

    expect(await search({ target_search: "renewal" })).toEqual([degradedId]);
    expect(await search({ target_quality: "degraded" })).toEqual([degradedId]);
    expect(await search({ target_quality: "complete" })).toEqual([cleanId]);
    expect(await search({ target_statuses: ["failed"] })).toEqual([cleanId]);
    expect(await search({ target_owner_id: userId })).toEqual([
      cleanId,
      degradedId,
    ]);
    expect(await search({ target_assignee_id: userId })).toEqual([degradedId]);
    expect(await search({ target_unassigned: true })).toEqual([cleanId]);
    expect(await search({ target_follow_up: "open" })).toEqual([degradedId]);
    expect(await search({ target_follow_up: "awaiting_verification" })).toEqual(
      [cleanId]
    );
    const { error: verifyError } = await workspaceAdmin.client.rpc(
      "verify_follow_up",
      {
        target_follow_up_id: resolvedFollowUp.id,
        expected_version: resolvedFollowUp.version + 1,
      }
    );
    if (verifyError) throw verifyError;
    expect(await search({ target_follow_up: "verified" })).toEqual([cleanId]);
    // Metadata search matches the owner too.
    expect(
      (await search({ target_search: "database-contract" })).sort()
    ).toEqual([cleanId, degradedId].sort());
    // Combined filters narrow rather than widen.
    expect(
      await search({ target_search: "renewal", target_statuses: ["failed"] })
    ).toEqual([]);
    // Transcript content is not searchable, and the empty result is the proof.
    expect(await search({ target_search: "pomegranate" })).toEqual([]);

    // Date filters bound both ends.
    expect(await search({ target_from: "2026-06-11T00:00:00.000Z" })).toEqual([
      cleanId,
    ]);
    expect(await search({ target_to: "2026-06-10T23:59:59.000Z" })).toEqual([
      degradedId,
    ]);
  });

  it("bounds and validates every discovery parameter", async () => {
    const { client } = await createWorkspaceMember("manager");

    const { error: longSearch } = await client.rpc("list_calls_page", {
      target_search: "x".repeat(121),
    });
    expect(longSearch?.message).toContain("120 characters");

    const { error: badQuality } = await client.rpc("list_calls_page", {
      target_quality: "excellent",
    });
    expect(badQuality?.message).toContain("complete or degraded");

    const { error: badFollowUp } = await client.rpc("list_calls_page", {
      target_follow_up: "someday",
    });
    expect(badFollowUp?.message).toContain("awaiting_verification");

    const { error: halfCursor } = await client.rpc("list_calls_page", {
      cursor_started_at: new Date().toISOString(),
    });
    expect(halfCursor?.message).toContain("both its parts");

    const { error: backwardsRange } = await client.rpc("list_calls_page", {
      target_from: "2026-06-11T00:00:00.000Z",
      target_to: "2026-06-01T00:00:00.000Z",
    });
    expect(backwardsRange?.message).toContain("starts after it ends");

    // An unknown processing state is refused by the type, not silently ignored.
    const { error: badStatus } = await client.rpc("list_calls_page", {
      target_statuses: ["not_a_status"],
    });
    expect(badStatus).not.toBeNull();
  });

  it("keeps Call access rules and Workspace isolation inside the page", async () => {
    const otherWorkspaceId = crypto.randomUUID();
    const { error: workspaceError } = await admin.from("workspaces").insert({
      id: otherWorkspaceId,
      name: "Other pilot",
      slug: `other-${otherWorkspaceId.slice(0, 8)}`,
    });
    if (workspaceError) throw workspaceError;
    createdWorkspaceIds.push(otherWorkspaceId);

    const { client: memberClient, userId: memberId } =
      await createWorkspaceMember();
    const { userId: colleagueId } = await createWorkspaceMember();
    const { client: managerClient } = await createWorkspaceMember("manager");
    const { userId: outsiderId } = await createWorkspaceMember(
      "admin",
      otherWorkspaceId
    );

    const { callId: ownCallId } = await createCall(memberId, {
      title: "Mine",
      status: "ready",
    });
    const { callId: colleagueCallId } = await createCall(colleagueId, {
      title: "Not mine",
      status: "ready",
    });
    const foreignCallId = crypto.randomUUID();
    createdCallIds.push(foreignCallId);
    await admin.from("calls").insert({
      id: foreignCallId,
      workspace_id: otherWorkspaceId,
      owner_id: outsiderId,
      title: "Another Workspace",
      source_mode: "mic",
      status: "ready",
      chunk_prefix: `${otherWorkspaceId}/${foreignCallId}/chunks`,
      recording_attested_by: outsiderId,
      recording_attested_at: new Date().toISOString(),
    });

    const { data: memberPage, error: memberError } =
      await memberClient.rpc("list_calls_page");
    if (memberError) throw memberError;
    const memberIds = (memberPage as Array<{ id: string }>).map(
      (row) => row.id
    );
    // A Member Role sees only their own Calls, filtered or not.
    expect(memberIds).toContain(ownCallId);
    expect(memberIds).not.toContain(colleagueCallId);
    expect(memberIds).not.toContain(foreignCallId);

    const { data: managerPage } = await managerClient.rpc("list_calls_page");
    const managerIds = (managerPage as Array<{ id: string }>).map(
      (row) => row.id
    );
    expect(managerIds).toEqual(
      expect.arrayContaining([ownCallId, colleagueCallId])
    );
    // Never across the Workspace boundary, whoever is asking.
    expect(managerIds).not.toContain(foreignCallId);

    // Naming another Workspace's Call explicitly does not reveal it either.
    const { data: targeted } = await managerClient.rpc("list_calls_page", {
      target_search: "Another Workspace",
    });
    expect(targeted).toEqual([]);
  });

  it("audits every artifact handover without recording content or a URL", async () => {
    const sinceEventId = await latestAuditEventId();
    const { client, userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId, {
      title: "Renewal with Acme",
      status: "ready",
      source_path: `${workspaceId}/source.webm`,
      mp3_path: `${workspaceId}/recording.mp3`,
    });

    for (const artifact of ["mp3", "source", "transcript_srt"]) {
      const { error } = await client.rpc("authorize_call_download", {
        target_call_id: callId,
        target_artifact: artifact,
      });
      if (error) throw error;
    }
    const { error: playbackError } = await client.rpc(
      "authorize_call_download",
      {
        target_call_id: callId,
        target_artifact: "mp3",
        target_delivery: "playback",
      }
    );
    if (playbackError) throw playbackError;

    const { data: events } = await admin
      .from("audit_events")
      .select("id, action, entity_type, entity_id, metadata, actor_id")
      .gt("id", sinceEventId)
      .in("action", ["call.download.created", "call.playback.created"])
      .order("id");
    expect(events).toHaveLength(4);
    expect(
      events?.map((event) => event.metadata as { artifact_type: string })
    ).toEqual([
      { artifact_type: "mp3" },
      { artifact_type: "source" },
      { artifact_type: "transcript_srt" },
      { artifact_type: "mp3" },
    ]);
    // Taking a copy is distinguishable from pressing play.
    expect(events?.map((event) => event.action)).toEqual([
      "call.download.created",
      "call.download.created",
      "call.download.created",
      "call.playback.created",
    ]);
    for (const event of events ?? []) {
      expect(event.entity_type).toBe("call");
      expect(event.entity_id).toBe(callId);
      expect(event.actor_id).toBe(userId);
      // Never the Call title, never a signed URL, never any content.
      const serialized = JSON.stringify(event.metadata);
      expect(serialized).not.toContain("Acme");
      expect(serialized).not.toMatch(/https?:/);
      expect(Object.keys(event.metadata as object)).toEqual(["artifact_type"]);
    }
  });

  it("binds a Transcript export path to the Call's actual Workspace", async () => {
    const { client, userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId, { status: "ready" });
    const validPath = `${workspaceId}/${callId}/artifacts/transcript.txt`;
    const forgedPath = `${crypto.randomUUID()}/${callId}/artifacts/transcript.txt`;

    try {
      const { error: validError } = await client.storage
        .from("recordings")
        .upload(validPath, new Blob(["safe transcript fixture"]));
      if (validError) throw validError;

      const { error: forgedError } = await client.storage
        .from("recordings")
        .upload(forgedPath, new Blob(["must not be accepted"]));
      expect(forgedError?.message).toMatch(/row-level security|policy/i);
    } finally {
      await admin.storage.from("recordings").remove([validPath, forgedPath]);
    }
  });

  it("fails safely for unauthorized, deleted, and cross-Workspace downloads", async () => {
    const otherWorkspaceId = crypto.randomUUID();
    await admin.from("workspaces").insert({
      id: otherWorkspaceId,
      name: "Other export pilot",
      slug: `export-${otherWorkspaceId.slice(0, 8)}`,
    });
    createdWorkspaceIds.push(otherWorkspaceId);

    const { userId: ownerId } = await createWorkspaceMember();
    const { client: colleagueClient } = await createWorkspaceMember();
    const { client: outsiderClient } = await createWorkspaceMember(
      "admin",
      otherWorkspaceId
    );
    const { callId } = await createCall(ownerId, { status: "ready" });

    // Another Member Role in the same Workspace has no claim on this Call.
    const { error: colleagueDenied } = await colleagueClient.rpc(
      "authorize_call_download",
      { target_call_id: callId, target_artifact: "mp3" }
    );
    expect(colleagueDenied?.message).toContain("Call not found");

    // Neither does an Admin of a different Workspace.
    const { error: outsiderDenied } = await outsiderClient.rpc(
      "authorize_call_download",
      { target_call_id: callId, target_artifact: "mp3" }
    );
    expect(outsiderDenied?.message).toContain("Call not found");

    // A Call that never existed answers the same way, revealing nothing.
    const { error: unknownDenied } = await colleagueClient.rpc(
      "authorize_call_download",
      { target_call_id: crypto.randomUUID(), target_artifact: "mp3" }
    );
    expect(unknownDenied?.message).toContain("Call not found");

    const { data: refusals } = await admin
      .from("audit_events")
      .select("id")
      .eq("action", "call.download.created")
      .eq("entity_id", callId);
    // A refused download is not a handover, so it writes no handover event.
    expect(refusals).toHaveLength(0);
  });

  it("refuses an export for a deleted Call and rate-limits the rest", async () => {
    const { client, userId } = await createWorkspaceMember();
    const { callId: deletedCallId } = await createCall(userId, {
      status: "ready",
      deleted_at: new Date().toISOString(),
    });
    const { error: deletedDenied } = await client.rpc(
      "authorize_call_download",
      { target_call_id: deletedCallId, target_artifact: "mp3" }
    );
    expect(deletedDenied?.message).toContain("Call not found");

    // Ten Transcript exports per Call per hour, shared with retries.
    const { callId } = await createCall(userId, { status: "ready" });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { error } = await client.rpc("authorize_call_download", {
        target_call_id: callId,
        target_artifact: "transcript_txt",
      });
      if (error) throw error;
    }
    const { error: exportLimited } = await client.rpc(
      "authorize_call_download",
      { target_call_id: callId, target_artifact: "transcript_txt" }
    );
    expect(exportLimited?.message).toContain("Too many exports");

    // Sixty signed downloads per Workspace Member per hour, across Calls.
    const { callId: secondCallId } = await createCall(userId, {
      status: "ready",
    });
    let limitedAt = 0;
    for (let attempt = 0; attempt < 60 && limitedAt === 0; attempt += 1) {
      const { error } = await client.rpc("authorize_call_download", {
        target_call_id: secondCallId,
        target_artifact: "mp3",
      });
      if (error) limitedAt = attempt;
    }
    // Ten were already spent above, so the sixty-first overall is refused.
    expect(limitedAt).toBeGreaterThan(0);
    expect(limitedAt).toBeLessThanOrEqual(50);
  });

  it("holds work rather than spending against an unpriced model", async () => {
    const { userId } = await createWorkspaceMember();
    const { callId } = await createCall(userId, {
      status: "queued",
      duration_ms: ms("1h"),
      stopped_at: new Date().toISOString(),
    });
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    await admin.from("processing_jobs").insert({
      id: jobId,
      workspace_id: workspaceId,
      call_id: callId,
      kind: "process_recording",
      status: "queued",
      idempotency_key: `budget-unpriced:${callId}`,
    });

    const { error: pricingError } = await admin
      .from("provider_pricing")
      .update({ is_active: false })
      .neq("model", "");
    if (pricingError) throw pricingError;
    try {
      const { error: assertError } = await admin.rpc(
        "assert_transcription_models_priced",
        { target_models: ["openai/whisper-large-v3-turbo"] }
      );
      expect(assertError?.message).toContain("No active provider pricing");

      const { data: claimed } = await admin.rpc("claim_processing_job", {
        worker_name: "unpriced-worker",
      });
      expect(claimed).toHaveLength(0);
      const { data: heldJob } = await admin
        .from("processing_jobs")
        .select("status, attempts, budget_paused_reason")
        .eq("id", jobId)
        .single();
      expect(heldJob).toEqual({
        status: "budget_paused",
        attempts: 0,
        budget_paused_reason: "pricing_unconfigured",
      });
    } finally {
      await admin
        .from("provider_pricing")
        .update({ is_active: true })
        .neq("model", "");
    }
  });
});
