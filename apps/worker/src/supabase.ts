import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
