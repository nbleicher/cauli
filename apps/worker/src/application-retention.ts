import { log } from "./log.js";
import { supabase } from "./supabase.js";

/** The application decides what expires; it never carries a VPS credential. */
export async function expireCallsForRetention() {
  const { data, error } = await supabase.rpc("expire_calls_for_retention", {
    batch_size: 100,
  });
  if (error) throw error;
  const expired = Number(data ?? 0);
  if (expired > 0) log.info("calls_expired_by_retention", { expired });
  return expired;
}

export async function reportBackupDeletionBacklog() {
  const { data, error } = await supabase.rpc("backup_deletion_backlog");
  if (error) throw error;
  const backlog = (
    data as { outstanding: number; oldest_seconds: number }[]
  )?.[0];
  if (backlog && backlog.outstanding > 0) {
    log.error("backup_deletion_backlog", {
      outstanding: backlog.outstanding,
      oldestSeconds: backlog.oldest_seconds,
    });
  }
  return backlog ?? { outstanding: 0, oldest_seconds: 0 };
}
