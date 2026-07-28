"use client";

import { Check, Copy, Download, KeyRound } from "lucide-react";
import { useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * The one and only screen that shows Recovery Codes in plaintext. They are held
 * in component state and never persisted, so navigating away loses them for
 * good — which is why the continue action is explicit.
 */
export function RecoveryCodes({
  codes,
  onContinue,
  continueLabel = "I have saved these codes",
}: {
  codes: string[];
  onContinue: () => void;
  continueLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function auditDownload() {
    const supabase = createBrowserSupabaseClient();
    await supabase.rpc("record_current_user_mfa_event", {
      target_action: "auth.mfa.recovery_codes_downloaded",
    });
  }

  async function copyCodes() {
    await navigator.clipboard.writeText(codes.join("\n"));
    setCopied(true);
    await auditDownload();
  }

  async function downloadCodes() {
    const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cauli-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
    await auditDownload();
  }

  return (
    <section className="recovery-codes">
      <KeyRound size={26} className="mfa-icon" />
      <h2>Save your Recovery Codes</h2>
      <p className="muted">
        Each code works once, and this is the only time they are shown. Use one
        to replace your authenticator if you ever lose access to it.
      </p>
      <ul className="recovery-code-list mono">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mfa-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void copyCodes()}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void downloadCodes()}
        >
          <Download size={16} />
          Download
        </button>
      </div>
      <button
        type="button"
        className="button button-primary button-full"
        onClick={onContinue}
      >
        {continueLabel}
      </button>
    </section>
  );
}
