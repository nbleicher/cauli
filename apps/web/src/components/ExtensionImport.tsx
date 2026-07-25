"use client";

import { CheckCircle2, Download, LoaderCircle, PlugZap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface LegacyRecording {
  legacyRecordingId: string;
  date: string;
  duration: number;
  source: "mic" | "tab" | "both";
  transcript: string;
  transcriptStatus: string;
  sourceMimeType: string;
  convertedMimeType: string;
  hasSource: boolean;
  hasConverted: boolean;
}

interface BridgeResponse {
  source: "calllog-extension";
  type: string;
  nonce: string;
  success: boolean;
  recordings?: LegacyRecording[];
  items?: Array<{
    importId: string;
    sourceUploaded: boolean;
    convertedUploaded: boolean;
    error?: string;
  }>;
  error?: string;
}

function nonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function waitForBridge(expectedType: string, expectedNonce: string, timeoutMs = 15_000) {
  return new Promise<BridgeResponse>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("The cauli extension did not respond. Install or update the companion extension."));
    }, timeoutMs);
    function listener(event: MessageEvent<BridgeResponse>) {
      if (
        event.source !== window
        || event.origin !== window.location.origin
        || event.data?.source !== "calllog-extension"
        || event.data.type !== expectedType
        || event.data.nonce !== expectedNonce
      ) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      resolve(event.data);
    }
    window.addEventListener("message", listener);
  });
}

export function ExtensionImport() {
  const router = useRouter();
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<"idle" | "reading" | "uploading" | "complete">("idle");
  const [message, setMessage] = useState("");
  const discovering = useRef(false);

  useEffect(() => {
    if (discovering.current) return;
    discovering.current = true;
    const requestNonce = nonce();
    const response = waitForBridge("CALLLOG_EXTENSION_PONG", requestNonce, 2_000);
    window.postMessage({
      source: "calllog-web",
      type: "CALLLOG_EXTENSION_PING",
      nonce: requestNonce,
    }, window.location.origin);
    response.then(() => setAvailable(true)).catch(() => setAvailable(false));
  }, []);

  async function startImport() {
    setStatus("reading");
    setMessage("");
    const importNonce = nonce();
    try {
      const listResponse = waitForBridge("CALLLOG_EXTENSION_RECORDINGS", importNonce);
      window.postMessage({
        source: "calllog-web",
        type: "CALLLOG_EXTENSION_LIST_RECORDINGS",
        nonce: importNonce,
      }, window.location.origin);
      const listed = await listResponse;
      if (!listed.success) throw new Error(listed.error || "Extension data could not be read");
      if (!listed.recordings?.length) {
        setStatus("complete");
        setMessage("No legacy recordings were found.");
        return;
      }

      const prepare = await fetch("/api/extension-imports/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: importNonce, recordings: listed.recordings }),
      });
      const plan = await prepare.json();
      if (!prepare.ok) throw new Error(plan.error || "Import could not be prepared");

      setStatus("uploading");
      const uploadResponse = waitForBridge("CALLLOG_EXTENSION_UPLOAD_COMPLETE", importNonce, 30 * 60_000);
      window.postMessage({
        source: "calllog-web",
        type: "CALLLOG_EXTENSION_UPLOAD",
        nonce: importNonce,
        items: plan.items,
      }, window.location.origin);
      const uploaded = await uploadResponse;
      if (!uploaded.success) throw new Error(uploaded.error || "Legacy audio upload failed");

      const complete = await fetch("/api/extension-imports/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: importNonce, items: uploaded.items }),
      });
      const completed = await complete.json();
      if (!complete.ok) throw new Error(completed.error || "Import could not be finalized");

      setStatus("complete");
      setMessage(`${completed.completed.length} recording${completed.completed.length === 1 ? "" : "s"} queued for processing.`);
      router.refresh();
    } catch (error) {
      setStatus("idle");
      setMessage(error instanceof Error ? error.message : "Import failed");
    }
  }

  if (!available) return null;

  return (
    <div className="extension-import">
      <div>
        {status === "complete" ? <CheckCircle2 size={18} /> : <PlugZap size={18} />}
        <span>{message || "Legacy extension recordings are available on this browser."}</span>
      </div>
      <button
        className="button button-secondary"
        disabled={status === "reading" || status === "uploading"}
        onClick={() => void startImport()}
      >
        {status === "reading" || status === "uploading"
          ? <LoaderCircle className="spin" size={15} />
          : <Download size={15} />}
        {status === "uploading" ? "Uploading" : status === "reading" ? "Reading" : "Import"}
      </button>
    </div>
  );
}
