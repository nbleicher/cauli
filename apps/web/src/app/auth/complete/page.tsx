"use client";

import { useEffect } from "react";
import { LoaderCircle } from "lucide-react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

// Terminal step for implicit-flow links (admin invites). The session arrives in
// the URL fragment, so only the browser can read it; setSession writes the same
// cookies the server reads on the next request.
export default function AuthCompletePage() {
  useEffect(() => {
    const fail = () => window.location.replace("/login?error=auth_callback");

    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = fragment.get("access_token");
    const refreshToken = fragment.get("refresh_token");
    const nextParam = new URLSearchParams(window.location.search).get("next");
    const next = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/record";

    if (!accessToken || !refreshToken) {
      fail();
      return;
    }

    createBrowserSupabaseClient().auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => {
        if (error) {
          fail();
          return;
        }
        // Drop the tokens out of the URL before moving on, so they never reach
        // session history or a Referer header.
        window.history.replaceState(null, "", window.location.pathname);
        // Full navigation, so the server sees the freshly written cookies.
        window.location.replace(next);
      })
      .catch(fail);
  }, []);

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="audio-pending" role="status">
          <LoaderCircle className="spin" size={18} />
          <span>Signing you in…</span>
        </div>
      </section>
    </main>
  );
}
