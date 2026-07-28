import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(
  /\/$/,
  ""
);
const workspaceId = "00000000-0000-0000-0000-000000000001";

if (!url || !serviceKey || !email) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and BOOTSTRAP_ADMIN_EMAIL are required"
  );
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  let userId = "";
  for (let page = 1; page <= 20 && !userId; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw error;
    userId =
      data.users.find((user) => user.email?.toLowerCase() === email)?.id ?? "";
    if (data.users.length < 100) break;
  }

  if (!userId) {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${appUrl}/auth/callback`,
    });
    if (error) throw error;
    userId = data.user.id;
  }

  const { error: membershipError } = await supabase
    .from("workspace_members")
    .upsert(
      {
        workspace_id: workspaceId,
        user_id: userId,
        role: "admin",
        is_initial_admin: true,
        invited_by: userId,
      },
      { onConflict: "workspace_id,user_id" }
    );
  if (membershipError) throw membershipError;

  const { data: existingTemplate, error: templateError } = await supabase
    .from("scorecard_templates")
    .select("id")
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (templateError) throw templateError;

  if (!existingTemplate) {
    const { error } = await supabase.rpc("publish_scorecard", {
      target_workspace_id: workspaceId,
      target_template_id: null,
      target_name: "Call Quality",
      target_actor_id: userId,
      target_categories: [
        {
          name: "Opening",
          criteria: [
            {
              label: "Clear introduction and purpose",
              description:
                "The agent introduced themselves and set a clear reason for the call.",
              weight: 2,
              required: true,
            },
            {
              label: "Established rapport",
              description:
                "The opening was confident, concise, and customer-focused.",
              weight: 1,
              required: true,
            },
          ],
        },
        {
          name: "Discovery",
          criteria: [
            {
              label: "Asked useful discovery questions",
              description:
                "Questions uncovered goals, constraints, and decision criteria.",
              weight: 3,
              required: true,
            },
            {
              label: "Listened and responded accurately",
              description:
                "Responses reflected what the customer actually said.",
              weight: 3,
              required: true,
            },
          ],
        },
        {
          name: "Close",
          criteria: [
            {
              label: "Confirmed next steps",
              description:
                "Ownership and timing for the next action were explicit.",
              weight: 2,
              required: true,
            },
          ],
        },
      ],
    });
    if (error) throw error;
  }

  process.stdout.write(`Bootstrapped ${email} as cauli admin.\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
