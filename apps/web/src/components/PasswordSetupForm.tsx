"use client";

import { LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

export function PasswordSetupForm({
  inviteId,
  mfaRequired = false,
  reset = false,
}: {
  inviteId?: string;
  mfaRequired?: boolean;
  reset?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 12) {
      setError("Use at least 12 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setWorking(true);
    setError("");
    const supabase = createBrowserSupabaseClient();
    const { error: passwordError } = await supabase.auth.updateUser({
      password,
    });
    if (passwordError) {
      setError(passwordError.message);
      setWorking(false);
      return;
    }

    if (reset) {
      await supabase.rpc("record_password_reset_for_current_user");
      window.location.replace("/record");
      return;
    }
    if (mfaRequired) {
      window.location.replace(
        `/auth/mfa?enroll=required&invite=${encodeURIComponent(inviteId ?? "")}`
      );
      return;
    }
    const response = await fetch("/api/auth/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(result.error || "Invitation activation failed");
      setWorking(false);
      return;
    }
    window.location.replace("/legal/acceptance");
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label htmlFor="new-password">New password</label>
      <input
        id="new-password"
        type="password"
        minLength={12}
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />
      <label htmlFor="confirm-password">Confirm password</label>
      <input
        id="confirm-password"
        type="password"
        minLength={12}
        autoComplete="new-password"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        required
      />
      {error && <p className="form-error">{error}</p>}
      <button className="button button-primary button-full" disabled={working}>
        {working && <LoaderCircle className="spin" size={16} />}
        {reset ? "Save new password" : "Create password and continue"}
      </button>
    </form>
  );
}
