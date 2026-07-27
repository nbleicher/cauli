"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

interface RequiredLegalDocument {
  document_type: string;
  slug: string;
  title: string;
  version_id: string;
  version: string;
  content_sha256: string;
  accepted_at: string | null;
}

export function LegalAcceptanceForm({
  documents,
}: {
  documents: RequiredLegalDocument[];
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const missing = documents.filter((document) => !document.accepted_at);

  async function accept() {
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/legal/acceptance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionIds: documents.map((document) => document.version_id),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Legal acceptance could not be saved");
      }
      window.location.replace("/record");
    } catch (acceptanceError) {
      setError(
        acceptanceError instanceof Error
          ? acceptanceError.message
          : "Legal acceptance could not be saved"
      );
      setWorking(false);
    }
  }

  return (
    <>
      <div className="legal-version-list">
        {documents.map((document) => (
          <div key={document.version_id}>
            <a
              href={`/legal/${document.slug}?version=${encodeURIComponent(
                document.version
              )}`}
              target="_blank"
              rel="noreferrer"
            >
              {document.title}
            </a>
            <span>
              Version {document.version} · SHA-256{" "}
              {document.content_sha256.slice(0, 12)}…
              {document.accepted_at ? " · Accepted" : ""}
            </span>
          </div>
        ))}
      </div>
      <p>
        Read the{" "}
        <a href="/legal/security" target="_blank" rel="noreferrer">
          Regulated-Use Disclaimer
        </a>
        . It is a disclosure, not a separate acceptance.
      </p>
      {missing.length > 0 ? (
        <>
          <label className="legal-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>I accept every current document listed above.</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button
            className="button button-primary"
            disabled={!confirmed || working}
            onClick={() => void accept()}
          >
            {working && <LoaderCircle className="spin" size={16} />}
            Accept and continue
          </button>
        </>
      ) : (
        <button
          className="button button-primary"
          onClick={() => window.location.replace("/record")}
        >
          Continue
        </button>
      )}
    </>
  );
}
