import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const localUrl = "http://127.0.0.1:54321";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
const workspaceId = "00000000-0000-0000-0000-000000000001";

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
      "create_call_for_current_user",
      {
        target_call_id: callId,
        target_source_mode: "both",
        target_mic_label: "Microphone",
        target_tab_label: "Browser tab",
      }
    );
    expect(createError).toBeNull();
    expect(createdCall).toMatchObject({
      id: callId,
      workspace_id: workspaceId,
      owner_id: userId,
      status: "recording",
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
});
