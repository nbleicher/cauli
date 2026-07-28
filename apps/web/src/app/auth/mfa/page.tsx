"use client";

import { LoaderCircle, ShieldCheck, Smartphone } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { RecoveryCodes } from "@/components/RecoveryCodes";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

interface Enrollment {
  factorId: string;
  qr: string;
  secret: string;
}

function MfaGate() {
  const searchParams = useSearchParams();
  const inviteId = searchParams.get("invite");
  const enrollmentRequired = searchParams.get("enroll") === "required";
  const verificationUnavailable =
    searchParams.get("verification") === "unavailable";
  const [code, setCode] = useState("");
  const [error, setError] = useState(
    verificationUnavailable
      ? "We could not verify your session security. Try again, or sign out and sign back in."
      : ""
  );
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const factorId = useRef("");
  const enrollmentStarted = useRef(false);
  const destination = useRef("/record");

  const audit = useCallback(
    async (action: string) => {
      const supabase = createBrowserSupabaseClient();
      await supabase.rpc("record_current_user_mfa_event", {
        target_action: action,
        target_invite_id: inviteId,
      });
    },
    [inviteId]
  );

  const beginEnrollment = useCallback(async () => {
    if (enrollmentStarted.current) return;
    enrollmentStarted.current = true;
    setBusy(true);
    setError("");
    const supabase = createBrowserSupabaseClient();
    await audit("auth.mfa.enrollment_started");
    const { data: existing, error: listError } =
      await supabase.auth.mfa.listFactors();
    if (listError) {
      setError("Could not inspect existing authenticators.");
      setBusy(false);
      enrollmentStarted.current = false;
      return;
    }
    for (const factor of existing?.all ?? []) {
      if (factor.status === "unverified") {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `authenticator-${Date.now()}`,
    });
    setBusy(false);
    if (enrollError || !data) {
      setError(enrollError?.message ?? "Could not start enrollment.");
      return;
    }
    factorId.current = data.id;
    setEnrollment({
      factorId: data.id,
      qr: data.totp.qr_code,
      secret: data.totp.secret,
    });
    setReady(true);
  }, [audit]);

  useEffect(() => {
    if (verificationUnavailable) return;
    const supabase = createBrowserSupabaseClient();
    supabase.auth.mfa.listFactors().then(({ data, error: listError }) => {
      const verified = data?.totp?.find(
        (factor) => factor.status === "verified"
      );
      if (verified) {
        factorId.current = verified.id;
        setReady(true);
        return;
      }
      if (!listError && enrollmentRequired) {
        void beginEnrollment();
        return;
      }
      window.location.replace(inviteId ? "/login" : "/account");
    });
  }, [beginEnrollment, enrollmentRequired, inviteId, verificationUnavailable]);

  const verify = useCallback(
    async (value: string) => {
      if (!factorId.current) return;
      setBusy(true);
      setError("");
      const supabase = createBrowserSupabaseClient();
      const { data: challenge, error: challengeError } =
        await supabase.auth.mfa.challenge({
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
        await audit("auth.mfa.verification_failed");
        setError("That verification code was not accepted.");
        setCode("");
        setBusy(false);
        return;
      }

      const wasEnrollment = Boolean(enrollment);
      await audit(wasEnrollment ? "auth.mfa.enrolled" : "auth.mfa.verified");
      setEnrollment(null);
      setCode("");

      if (inviteId) {
        const response = await fetch("/api/auth/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviteId }),
        });
        if (!response.ok) {
          const result = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(result.error ?? "Invitation activation failed.");
          setBusy(false);
          return;
        }
        destination.current = "/legal/acceptance";
      }

      if (wasEnrollment) {
        const response = await fetch("/api/auth/recovery-codes", {
          method: "POST",
        });
        const result = (await response.json().catch(() => ({}))) as {
          codes?: string[];
        };
        if (response.ok && result.codes) {
          setBusy(false);
          setRecoveryCodes(result.codes);
          return;
        }
        // The factor is verified either way, so a failed issue does not strand
        // the account here; Account settings can generate a set later.
      }
      window.location.replace(destination.current);
    },
    [audit, enrollment, inviteId]
  );

  if (recoveryCodes) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <RecoveryCodes
            codes={recoveryCodes}
            onContinue={() => window.location.replace(destination.current)}
            continueLabel="I have saved these codes, continue"
          />
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        {enrollment ? (
          <>
            <Smartphone size={30} className="mfa-icon" />
            <h1>Set up two-factor authentication</h1>
            <p className="muted">
              Your role requires a verified authenticator before access.
            </p>
            <ol className="mfa-steps">
              <li>Scan this code with your authenticator app.</li>
              <li>Enter the 6-digit code it shows to confirm.</li>
            </ol>
            {/* Supabase returns the QR as a local SVG data URI. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrollment.qr}
              alt="Two-factor setup QR code"
              className="mfa-qr"
              width={200}
              height={200}
            />
            <details className="mfa-secret">
              <summary>Can&rsquo;t scan? Enter this key manually</summary>
              <code className="mono">{enrollment.secret}</code>
            </details>
          </>
        ) : (
          <>
            <ShieldCheck size={30} className="mfa-icon" />
            <h1>Two-factor verification</h1>
            <p className="muted">
              Enter the 6-digit code from your authenticator app.
            </p>
          </>
        )}

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
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            disabled={!ready || busy}
            autoFocus
            required
          />
          {error && <p className="form-error">{error}</p>}
          <button
            className="button button-primary button-full"
            disabled={!ready || busy || code.length !== 6}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ShieldCheck size={17} />
            )}
            {enrollment ? "Confirm and continue" : "Verify"}
          </button>
        </form>

        {!enrollment && (
          <a className="link-button" href="/auth/recovery">
            Can&rsquo;t use your authenticator?
          </a>
        )}

        <form action="/api/auth/signout" method="post" className="mfa-escape">
          <button className="link-button" type="submit">
            Sign out instead
          </button>
        </form>
      </section>
    </main>
  );
}

export default function MfaChallengePage() {
  return (
    <Suspense>
      <MfaGate />
    </Suspense>
  );
}
