#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import { log, sanitizedError } from "./log.js";
import {
  synchronizePeely,
  synchronizePeelyWithIndependentAlert,
} from "./peely.js";

/**
 * The daily Peely synchronization, run from the operator's own machine by
 * launchd rather than from production. It is a separate entry point on purpose:
 * production never holds the Peely credential, and Peely never runs inside a
 * failure domain it is supposed to survive.
 *
 *   npm run peely:sync -w @calllog/worker
 */

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run() {
  const directory = process.env.PEELY_DIRECTORY?.trim() || "/Volumes/Peely SSD";
  const client = createClient(
    required("SUPABASE_URL"),
    // The Peely credential, which can read opaque names and digests and
    // nothing else.
    required("SUPABASE_PEELY_KEY"),
    { auth: { persistSession: false } }
  );
  const target = {
    baseUrl: required("BACKUP_VPS_URL"),
    clientCertificatePem: required("PEELY_VPS_CLIENT_CERT"),
    clientKeyPem: required("PEELY_VPS_CLIENT_KEY"),
    certificateAuthorityPem: required("BACKUP_VPS_CA_CERT"),
  };

  const sendOperatorEmail = async (alert: {
    subject: string;
    body: string;
  }) => {
    const response = await fetch(required("OPERATOR_ALERT_WEBHOOK"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: required("OPERATOR_ALERT_EMAIL"),
        subject: alert.subject,
        text: alert.body,
      }),
    });
    if (!response.ok) {
      throw new Error(`Operator alert failed (${response.status})`);
    }
  };
  const result = await synchronizePeelyWithIndependentAlert({
    directory,
    synchronize: () =>
      synchronizePeely({
        directory,
        target,
        client,
      }),
    sendOperatorEmail,
  });

  if (result.failures.length) process.exitCode = 1;
}

run().catch((error) => {
  log.error("peely_sync_failed", { error: sanitizedError(error) });
  process.exitCode = 1;
});
