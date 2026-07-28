"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

function requireBrowserSupabaseConfig() {
  const root = document.documentElement;
  const url = root.dataset.supabaseUrl?.trim() ?? "";
  const anonKey = root.dataset.supabaseAnonKey?.trim() ?? "";
  if (!url || !anonKey) throw new Error("Supabase is not configured");
  return { url, anonKey };
}

export function createBrowserSupabaseClient() {
  if (client) return client;
  const { url, anonKey } = requireBrowserSupabaseConfig();
  client = createBrowserClient(url, anonKey);
  return client;
}
