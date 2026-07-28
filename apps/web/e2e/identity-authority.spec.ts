import { createClient, type User } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const localUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-test-anon-key";
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-test-service-key";
const primaryWorkspaceId = "00000000-0000-0000-0000-000000000001";
const identityUrl = `${localUrl}/functions/v1/identity-admin`;
const admin = createClient(localUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

test.skip(
  process.env.RUN_DATABASE_INTEGRATION !== "1" ||
    process.env.RUN_IDENTITY_INTEGRATION !== "1" ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
  "requires local Supabase and the identity Edge Function"
);

async function createUser(
  workspaceId: string,
  role: "admin" | "manager" | "member"
) {
  const email = `identity-${role}-${crypto.randomUUID()}@example.com`;
  const password = `Identity-${crypto.randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  const { error: membershipError } = await admin
    .from("workspace_members")
    .insert({ workspace_id: workspaceId, user_id: data.user.id, role });
  if (membershipError) throw membershipError;

  const client = createClient(localUrl, anonKey, {
    auth: { persistSession: false },
  });
  const { data: signIn, error: signInError } =
    await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { user: data.user, token: signIn.session.access_token };
}

async function invoke(body: Record<string, unknown>, token: string = anonKey) {
  return fetch(identityUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function removeUsers(users: User[]) {
  for (const user of users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error && !/not found/i.test(error.message)) throw error;
  }
}

test("identity endpoint denies neighboring and cross-Workspace authority", async () => {
  const users: User[] = [];
  const otherWorkspaceId = crypto.randomUUID();
  let otherInviteId: string | undefined;

  try {
    const { error: workspaceError } = await admin.from("workspaces").insert({
      id: otherWorkspaceId,
      name: "Identity boundary fixture",
      slug: `identity-${crypto.randomUUID()}`,
    });
    if (workspaceError) throw workspaceError;

    const primaryAdmin = await createUser(primaryWorkspaceId, "admin");
    const primaryMember = await createUser(primaryWorkspaceId, "member");
    const otherAdmin = await createUser(otherWorkspaceId, "admin");
    users.push(primaryAdmin.user, primaryMember.user, otherAdmin.user);

    expect(
      (
        await invoke(
          {
            action: "invite",
            inviteId: crypto.randomUUID(),
            redirectTo: "http://127.0.0.1:3102/auth/callback",
          },
          primaryMember.token
        )
      ).status
    ).toBe(403);

    for (const action of [
      "read_call_content",
      "process_call",
      "write_backup",
      "delete_retained_content",
      "run_migration",
      "platform_admin",
    ]) {
      expect((await invoke({ action }, primaryAdmin.token)).status).toBe(400);
    }

    expect(
      (
        await invoke(
          {
            action: "invite",
            inviteId: crypto.randomUUID(),
            redirectTo: "https://attacker.example/auth/callback",
          },
          primaryAdmin.token
        )
      ).status
    ).toBe(400);

    const { data: invite, error: inviteError } = await admin
      .from("workspace_invites")
      .insert({
        workspace_id: otherWorkspaceId,
        email: `cross-workspace-${crypto.randomUUID()}@example.com`,
        role: "member",
        invited_by: otherAdmin.user.id,
      })
      .select("id")
      .single();
    if (inviteError) throw inviteError;
    otherInviteId = invite.id;

    expect(
      (
        await invoke(
          {
            action: "invite",
            inviteId: otherInviteId,
            redirectTo: "http://127.0.0.1:3102/auth/callback",
          },
          primaryAdmin.token
        )
      ).status
    ).toBe(404);
    expect(
      (
        await invoke(
          { action: "reset_mfa", userId: otherAdmin.user.id },
          primaryAdmin.token
        )
      ).status
    ).toBe(404);
    expect(
      (
        await invoke({
          action: "invite",
          inviteId: crypto.randomUUID(),
          redirectTo: "http://127.0.0.1:3102/auth/callback",
        })
      ).status
    ).toBe(401);
  } finally {
    if (otherInviteId) {
      await admin.from("workspace_invites").delete().eq("id", otherInviteId);
    }
    await removeUsers(users);
    await admin.from("workspaces").delete().eq("id", otherWorkspaceId);
  }
});
