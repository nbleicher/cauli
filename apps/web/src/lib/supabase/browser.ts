"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/env";

let client: SupabaseClient | null = null;

export function createBrowserSupabaseClient() {
  if (client) return client;
  const { url, anonKey } = requireSupabaseEnv();
  client = createBrowserClient(url, anonKey);
  return client;
}
