"use client";

import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { PublicFooter } from "@/components/PublicFooter";

export default function RecoveryPage() {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/auth/recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, code }),
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(result.error ?? "Recovery could not be verified");
      setPassword("");
      setCode("");
      setBusy(false);
      return;
    }
    // A redeemed code buys exactly one thing: the chance to enroll again.
    window.location.replace("/auth/mfa?enroll=required");
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <KeyRound size={30} className="mfa-icon" />
        <h1>Use a Recovery Code</h1>
        <p className="muted">
          Confirm your password and one unused Recovery Code. This replaces your
          authenticator; it does not open the application on its own.
        </p>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="recovery-password">Password</label>
          <input
            id="recovery-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
          <div className="recovery-entry">
            <label htmlFor="recovery-code">Recovery Code</label>
            <input
              id="recovery-code"
              className="mono"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="one-time-code"
              required
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button
            className="button button-primary button-full"
            disabled={busy || !password || !code}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <KeyRound size={17} />
            )}
            Replace my authenticator
          </button>
        </form>
        <form action="/api/auth/signout" method="post" className="mfa-escape">
          <button className="link-button" type="submit">
            Sign out instead
          </button>
        </form>
      </section>
      <PublicFooter />
    </main>
  );
}
