"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle, Lock, Mail } from "lucide-react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

type Status = "idle" | "working" | "reset-sent";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const busy = status === "working";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus("working");
    setError("");
    const { error: authError } =
      await createBrowserSupabaseClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
    if (authError) {
      setError(authError.message);
      setStatus("idle");
      return;
    }
    window.location.replace("/record");
  }

  async function sendReset() {
    if (!email.trim()) {
      setError("Enter your email first, then choose Forgot password.");
      return;
    }
    setStatus("working");
    setError("");
    const response = await fetch("/api/auth/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    if (!response.ok) {
      setError("Password reset is temporarily unavailable.");
      setStatus("idle");
      return;
    }
    setStatus("reset-sent");
  }

  if (status === "reset-sent") {
    return (
      <div className="success-message" role="status">
        <Mail size={20} />
        <div>
          <strong>Check your inbox</strong>
          <p>
            If an account exists for {email}, a time-limited password reset link
            is on its way.
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

      <div className="label-row">
        <label htmlFor="password">Password</label>
        <button
          type="button"
          className="link-button"
          onClick={() => void sendReset()}
        >
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

      {error && <p className="form-error">{error}</p>}

      <button className="button button-primary button-full" disabled={busy}>
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <ArrowRight size={17} />
        )}
        Sign in
      </button>
    </form>
  );
}
