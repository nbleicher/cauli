"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

// Lives outside the (app) route group on purpose: requirePageAuth redirects
// here when a session is aal1, so this page must not itself be gated on aal2.
export default function MfaChallengePage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const factorId = useRef("");

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    supabase.auth.mfa.listFactors().then(({ data, error: listError }) => {
      const totp = data?.totp?.find((f) => f.status === "verified");
      if (listError || !totp) {
        // Nothing to challenge — don't strand the user on a dead page.
        window.location.replace("/record");
        return;
      }
      factorId.current = totp.id;
      setReady(true);
    });
  }, []);

  const verify = useCallback(async (value: string) => {
    setBusy(true);
    setError("");
    const supabase = createBrowserSupabaseClient();
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: factorId.current,
    });
    if (challengeError || !challenge) {
      setError(challengeError?.message ?? "Could not start verification.");
      setBusy(false);
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: factorId.current,
      challengeId: challenge.id,
      code: value,
    });
    if (verifyError) {
      setError(verifyError.message);
      setCode("");
      setBusy(false);
      return;
    }
    // Session is now aal2; full navigation so the server re-reads it.
    window.location.replace("/record");
  }, []);

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <ShieldCheck size={30} className="mfa-icon" />
        <h1>Two-factor verification</h1>
        <p className="muted">Enter the 6-digit code from your authenticator app.</p>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(code);
          }}
        >
          <label htmlFor="code">Verification code</label>
          <input
            id="code"
            className="mono otp-input"
            value={code}
            onChange={(event) => {
              const next = event.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(next);
              // Authenticator codes are fixed-length; submit as soon as it's complete.
              if (next.length === 6 && !busy) void verify(next);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            disabled={!ready || busy}
            autoFocus
            required
          />
          {error && <p className="form-error">{error}</p>}
          <button className="button button-primary button-full" disabled={!ready || busy || code.length !== 6}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
            Verify
          </button>
        </form>

        <form action="/api/auth/signout" method="post" className="mfa-escape">
          <button className="link-button" type="submit">Sign out instead</button>
        </form>
      </section>
    </main>
  );
}
