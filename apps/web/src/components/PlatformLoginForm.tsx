"use client";

import { ArrowRight, LoaderCircle, Lock, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

export function PlatformLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const { error: authError } =
      await createBrowserSupabaseClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
    if (authError) {
      setError("Platform Admin sign-in failed.");
      setBusy(false);
      return;
    }
    window.location.replace("/platform-admin");
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label htmlFor="platform-email">Platform Admin email</label>
      <div className="input-with-icon">
        <Mail size={17} />
        <input
          id="platform-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
      </div>
      <label htmlFor="platform-password">Password</label>
      <div className="input-with-icon">
        <Lock size={17} />
        <input
          id="platform-password"
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
        Sign in to control plane
      </button>
    </form>
  );
}
