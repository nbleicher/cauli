import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "recordings";

/** Narrow Source Audio read for the isolated backup-writer principal. */
export async function downloadBackupSource(
  client: SupabaseClient,
  storagePath: string
) {
  const { data, error } = await client.storage
    .from(BUCKET)
    .download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}
