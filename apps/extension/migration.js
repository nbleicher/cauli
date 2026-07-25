const AUDIO_DB_NAME = "calllog-audio";
const AUDIO_STORE = "recording_blobs";

function openAudioDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUDIO_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open legacy audio storage"));
  });
}

async function readAudioRecords() {
  const database = await openAudioDatabase();
  return new Promise((resolve, reject) => {
    if (!database.objectStoreNames.contains(AUDIO_STORE)) {
      database.close();
      resolve([]);
      return;
    }
    const transaction = database.transaction(AUDIO_STORE, "readonly");
    const request = transaction.objectStore(AUDIO_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Unable to read legacy audio"));
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("Legacy audio read was aborted"));
    };
  });
}

function legacyAudioMap(records) {
  const map = new Map();
  for (const record of records) {
    if (!record?.id || !record?.kind || !(record.blob instanceof Blob)) continue;
    map.set(`${String(record.id)}:${record.kind}`, record.blob);
  }
  return map;
}

export async function listLegacyRecordings() {
  const [stored, audioRecords] = await Promise.all([
    chrome.storage.local.get(["recordings_meta"]),
    readAudioRecords(),
  ]);
  const audio = legacyAudioMap(audioRecords);

  return (stored.recordings_meta || []).map((record) => ({
    legacyRecordingId: String(record.id),
    date: new Date(record.date).toISOString(),
    duration: Number(record.duration) || 0,
    source: ["mic", "tab", "both"].includes(record.source) ? record.source : "both",
    transcript: record.transcript || "",
    transcriptStatus: record.transcriptStatus || "none",
    sourceMimeType: record.sourceMimeType || audio.get(`${String(record.id)}:source`)?.type || "",
    convertedMimeType: record.convertedMimeType || audio.get(`${String(record.id)}:converted`)?.type || "",
    hasSource: audio.has(`${String(record.id)}:source`),
    hasConverted: audio.has(`${String(record.id)}:converted`),
  }));
}

function validateUploadUrl(value) {
  const url = new URL(value);
  const allowedOrigin = globalThis.CALLLOG_COMPANION_CONFIG?.supabaseOrigin;
  if (!allowedOrigin || url.origin !== allowedOrigin) {
    throw new Error("Migration upload URL is not the configured Supabase origin");
  }
  if (!url.pathname.includes("/storage/v1/object/upload/sign/")) {
    throw new Error("Migration upload URL is not a signed Storage upload");
  }
  return url.toString();
}

async function uploadSigned(upload, blob) {
  if (!upload || !blob) return false;
  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", blob);
  const response = await fetch(validateUploadUrl(upload.signedUrl), {
    method: "POST",
    headers: { "x-upsert": "true" },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Storage upload failed (${response.status}): ${body.slice(0, 200)}`);
  }
  return true;
}

export async function uploadLegacyRecordings(items) {
  const audio = legacyAudioMap(await readAudioRecords());
  const results = [];

  for (const item of items) {
    if (item.status === "complete") {
      results.push({
        importId: item.importId,
        sourceUploaded: true,
        convertedUploaded: true,
      });
      continue;
    }

    const id = String(item.legacyRecordingId);
    try {
      const sourceUploaded = item.sourceUpload
        ? await uploadSigned(item.sourceUpload, audio.get(`${id}:source`))
        : false;
      const convertedUploaded = item.convertedUpload
        ? await uploadSigned(item.convertedUpload, audio.get(`${id}:converted`))
        : false;
      results.push({
        importId: item.importId,
        sourceUploaded,
        convertedUploaded,
      });
    } catch (error) {
      results.push({
        importId: item.importId,
        sourceUploaded: false,
        convertedUploaded: false,
        error: error.message,
      });
    }
  }
  return results;
}
