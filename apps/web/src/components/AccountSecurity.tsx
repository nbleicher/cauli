"use client";

import type { Role } from "@calllog/shared";
import { useCallback, useState } from "react";
import {
  Check,
  LoaderCircle,
  Lock,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from "lucide-react";
import { RecoveryCodes } from "@/components/RecoveryCodes";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

const MIN_PASSWORD_LENGTH = 12;

interface Enrolling {
  factorId: string;
  qr: string;
  secret: string;
}

export function AccountSecurity({
  initialFactorId,
  role,
}: {
  initialFactorId: string | null;
  role: Role;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwDone, setPwDone] = useState(false);

  // Seeded from the server, then kept in step by the enroll/remove handlers.
  const [factorId, setFactorId] = useState<string | null>(initialFactorId);
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null);
  const [code, setCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const refreshFactors = useCallback(async () => {
    const supabase = createBrowserSupabaseClient();
    const { data } = await supabase.auth.mfa.listFactors();
    setFactorId(data?.totp?.find((f) => f.status === "verified")?.id ?? null);
  }, []);

  const auditMfa = useCallback(async (action: string) => {
    const supabase = createBrowserSupabaseClient();
    await supabase.rpc("record_current_user_mfa_event", {
      target_action: action,
    });
  }, []);

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setPwError("");
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPwError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setPwError("The two passwords do not match.");
      return;
    }
    setPwBusy(true);
    const supabase = createBrowserSupabaseClient();
    const { error } = await supabase.auth.updateUser({ password });
    setPwBusy(false);
    if (error) {
      // Supabase rejects breached passwords here when HIBP checking is on.
      setPwError(error.message);
      return;
    }
    setPassword("");
    setConfirm("");
    setPwDone(true);
  }

  async function startEnroll() {
    setMfaBusy(true);
    setMfaError("");
    const supabase = createBrowserSupabaseClient();
    await auditMfa("auth.mfa.enrollment_started");
    // Clear out any half-finished factor, otherwise enroll trips the name/limit check.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of existing?.all ?? []) {
      if (f.status === "unverified")
        await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `authenticator-${Date.now()}`,
    });
    setMfaBusy(false);
    if (error || !data) {
      setMfaError(error?.message ?? "Could not start enrollment.");
      return;
    }
    setEnrolling({
      factorId: data.id,
      qr: data.totp.qr_code,
      secret: data.totp.secret,
    });
  }

  async function confirmEnroll(event: React.FormEvent) {
    event.preventDefault();
    if (!enrolling) return;
    setMfaBusy(true);
    setMfaError("");
    const supabase = createBrowserSupabaseClient();
    const { data: challenge, error: challengeError } =
      await supabase.auth.mfa.challenge({
        factorId: enrolling.factorId,
      });
    if (challengeError || !challenge) {
      setMfaError(challengeError?.message ?? "Could not start verification.");
      setMfaBusy(false);
      return;
    }
    const { error } = await supabase.auth.mfa.verify({
      factorId: enrolling.factorId,
      challengeId: challenge.id,
      code,
    });
    setMfaBusy(false);
    if (error) {
      await auditMfa("auth.mfa.verification_failed");
      setMfaError(error.message);
      setCode("");
      return;
    }
    await auditMfa("auth.mfa.enrolled");
    setEnrolling(null);
    setCode("");
    await refreshFactors();
    await issueRecoveryCodes();
  }

  // Every verified enrollment issues a fresh set and retires the previous one,
  // so the codes on paper always belong to the factor in use.
  async function issueRecoveryCodes() {
    setMfaBusy(true);
    setMfaError("");
    const response = await fetch("/api/auth/recovery-codes", {
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as {
      codes?: string[];
      error?: string;
    };
    setMfaBusy(false);
    if (!response.ok || !result.codes) {
      setMfaError(result.error ?? "Could not issue Recovery Codes.");
      return;
    }
    setRecoveryCodes(result.codes);
  }

  async function removeFactor() {
    if (!factorId) return;
    setMfaBusy(true);
    setMfaError("");
    const supabase = createBrowserSupabaseClient();
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    setMfaBusy(false);
    if (error) {
      setMfaError(error.message);
      return;
    }
    await refreshFactors();
  }

  return (
    <>
      <section className="section">
        <div className="section-heading">
          <div>
            <h2>Password</h2>
            <p>
              Set a password to sign in without waiting for an email link.
              Saving a new one replaces any existing password.
            </p>
          </div>
        </div>

        {pwDone ? (
          <div className="success-message" role="status">
            <Check size={18} />
            <div>
              <strong>Password updated</strong>
              <p>Use it next time you sign in.</p>
            </div>
          </div>
        ) : (
          <form className="auth-form security-form" onSubmit={savePassword}>
            <label htmlFor="new-password">New password</label>
            <div className="input-with-icon">
              <Lock size={17} />
              <input
                id="new-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            <label htmlFor="confirm-password">Confirm password</label>
            <div className="input-with-icon">
              <Lock size={17} />
              <input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            <p className="field-hint">
              At least {MIN_PASSWORD_LENGTH} characters. Passwords found in
              known breaches are rejected.
            </p>
            {pwError && <p className="form-error">{pwError}</p>}
            <button className="button button-primary" disabled={pwBusy}>
              {pwBusy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Lock size={16} />
              )}
              Save password
            </button>
          </form>
        )}
      </section>

      <section className="section">
        <div className="section-heading">
          <div>
            <h2>Two-factor authentication</h2>
            <p>
              Require a code from an authenticator app in addition to your
              password.
            </p>
          </div>
          {factorId && !enrolling && (
            <span className="status-pill status-ready">
              <ShieldCheck size={12} /> Enabled
            </span>
          )}
        </div>

        {recoveryCodes && (
          <RecoveryCodes
            codes={recoveryCodes}
            onContinue={() => setRecoveryCodes(null)}
            continueLabel="Done"
          />
        )}

        {factorId && !enrolling && !recoveryCodes && (
          <div className="mfa-enabled">
            <p className="muted">
              Two-factor authentication is on. You will be asked for a code each
              time you sign in.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void issueRecoveryCodes()}
              disabled={mfaBusy}
            >
              {mfaBusy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <ShieldCheck size={16} />
              )}
              Generate new Recovery Codes
            </button>
            {role === "member" ? (
              <button
                className="button button-danger"
                onClick={() => void removeFactor()}
                disabled={mfaBusy}
              >
                {mfaBusy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <ShieldOff size={16} />
                )}
                Turn off
              </button>
            ) : (
              <p className="field-hint">
                Your Workspace role requires two-factor authentication.
              </p>
            )}
          </div>
        )}

        {!factorId && !enrolling && (
          <button
            className="button button-secondary"
            onClick={() => void startEnroll()}
            disabled={mfaBusy}
          >
            {mfaBusy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Smartphone size={16} />
            )}
            Set up authenticator app
          </button>
        )}

        {enrolling && (
          <form className="mfa-enroll" onSubmit={confirmEnroll}>
            <ol className="mfa-steps">
              <li>
                Scan this code with Google Authenticator, 1Password, or Authy.
              </li>
              <li>Enter the 6-digit code it shows to confirm.</li>
            </ol>
            {/* Supabase returns the QR as an SVG data URI, so no QR dependency. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrolling.qr}
              alt="Two-factor setup QR code"
              className="mfa-qr"
              width={200}
              height={200}
            />
            <details className="mfa-secret">
              <summary>Can&rsquo;t scan? Enter this key manually</summary>
              <code className="mono">{enrolling.secret}</code>
            </details>
            <label htmlFor="enroll-code">Verification code</label>
            <input
              id="enroll-code"
              className="mono otp-input"
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              required
            />
            {mfaError && <p className="form-error">{mfaError}</p>}
            <div className="mfa-actions">
              <button
                className="button button-primary"
                disabled={mfaBusy || code.length !== 6}
              >
                {mfaBusy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
                Confirm and enable
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setEnrolling(null);
                  setCode("");
                  setMfaError("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
