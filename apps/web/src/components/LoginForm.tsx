"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, LoaderCircle, Lock, Mail } from "lucide-react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

type Mode = "password" | "link";
type Status = "idle" | "working" | "sent" | "reset-sent";

export function LoginForm() {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const busy = status === "working";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus("working");
    setError("");
    const supabase = createBrowserSupabaseClient();

    if (mode === "password") {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        setError(authError.message);
        setStatus("idle");
        return;
      }
      // Full navigation so the server sees the new cookies. If this account has
      // a second factor, requirePageAuth bounces to /auth/mfa from here.
      window.location.replace("/record");
      return;
    }

    const { error: authError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });
    if (authError) {
      setError(authError.message);
      setStatus("idle");
      return;
    }
    setStatus("sent");
  }

  async function sendReset() {
    if (!email.trim()) {
      setError("Enter your email first, then choose Forgot password.");
      return;
    }
    setStatus("working");
    setError("");
    const supabase = createBrowserSupabaseClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/account`,
    });
    if (resetError) {
      setError(resetError.message);
      setStatus("idle");
      return;
    }
    setStatus("reset-sent");
  }

  if (status === "sent" || status === "reset-sent") {
    return (
      <div className="success-message" role="status">
        <Mail size={20} />
        <div>
          <strong>Check your inbox</strong>
          <p>
            {status === "sent"
              ? `We sent a secure sign-in link to ${email}.`
              : `We sent a password reset link to ${email}. Open it to choose a new password.`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label htmlFor="email">Work email</label>
      <div className="input-with-icon">
        <Mail size={17} />
        <input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          required
        />
      </div>

      {mode === "password" && (
        <>
          <div className="label-row">
            <label htmlFor="password">Password</label>
            <button type="button" className="link-button" onClick={() => void sendReset()}>
              Forgot password?
            </button>
          </div>
          <div className="input-with-icon">
            <Lock size={17} />
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
        </>
      )}

      {error && <p className="form-error">{error}</p>}

      <button className="button button-primary button-full" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
        {mode === "password" ? "Sign in" : "Email me a sign-in link"}
      </button>

      <button
        type="button"
        className="button button-quiet button-full"
        onClick={() => {
          setMode(mode === "password" ? "link" : "password");
          setError("");
        }}
      >
        {mode === "password" ? <Mail size={15} /> : <KeyRound size={15} />}
        {mode === "password" ? "Email me a link instead" : "Use a password instead"}
      </button>
    </form>
  );
}
