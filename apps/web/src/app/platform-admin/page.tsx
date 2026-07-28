import { PlatformAdminConsole } from "@/components/PlatformAdminConsole";
import { requirePlatformAdminPageAuth } from "@/lib/server/platform-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PlatformAdminPage() {
  const { environment } = await requirePlatformAdminPageAuth();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("platform_workspace_health");
  if (error) throw error;

  return (
    <main className="platform-page">
      <PlatformAdminConsole environment={environment} workspaces={data ?? []} />
    </main>
  );
}
