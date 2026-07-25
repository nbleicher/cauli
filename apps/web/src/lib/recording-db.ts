"use client";

import type { DegradedInterval, SourceMode } from "@calllog/shared";

const DB_NAME = "calllog-recorder";
const DB_VERSION = 1;
const DRAFT_STORE = "drafts";
const CHUNK_STORE = "chunks";

export interface RecordingDraft {
  callId: string;
  workspaceId: string;
  storagePrefix: string;
  sourceMode: SourceMode;
  mimeType: string;
  startedAt: number;
  durationMs: number;
  finalChunkSequence: number;
  micLabel: string;
  tabLabel: string;
  stopped: boolean;
  degradedIntervals: DegradedInterval[];
  updatedAt: number;
}

interface StoredChunk {
  key: string;
  callId: string;
  sequence: number;
  blob: Blob;
  createdAt: number;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        database.createObjectStore(DRAFT_STORE, { keyPath: "callId" });
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = database.createObjectStore(CHUNK_STORE, {
          keyPath: "key",
        });
        chunks.createIndex("callId", "callId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open recording storage"));
  });
}

function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
) {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(
            request.error ?? new Error("Recording storage request failed")
          );
        transaction.oncomplete = () => database.close();
        transaction.onabort = () => {
          database.close();
          reject(
            transaction.error ??
              new Error("Recording storage transaction aborted")
          );
        };
      })
  );
}

export function saveDraft(draft: RecordingDraft) {
  return runTransaction(DRAFT_STORE, "readwrite", (store) => store.put(draft));
}

export function deleteDraft(callId: string) {
  return runTransaction(DRAFT_STORE, "readwrite", (store) =>
    store.delete(callId)
  );
}

export function listDrafts() {
  return runTransaction<RecordingDraft[]>(DRAFT_STORE, "readonly", (store) =>
    store.getAll()
  );
}

export function saveChunk(callId: string, sequence: number, blob: Blob) {
  const chunk: StoredChunk = {
    key: `${callId}:${sequence.toString().padStart(10, "0")}`,
    callId,
    sequence,
    blob,
    createdAt: Date.now(),
  };
  return runTransaction(CHUNK_STORE, "readwrite", (store) => store.put(chunk));
}

export function deleteChunk(callId: string, sequence: number) {
  return runTransaction(CHUNK_STORE, "readwrite", (store) =>
    store.delete(`${callId}:${sequence.toString().padStart(10, "0")}`)
  );
}

export async function listChunks(callId: string) {
  const database = await openDatabase();
  return new Promise<StoredChunk[]>((resolve, reject) => {
    const transaction = database.transaction(CHUNK_STORE, "readonly");
    const index = transaction.objectStore(CHUNK_STORE).index("callId");
    const request = index.getAll(IDBKeyRange.only(callId));
    request.onsuccess = () => {
      resolve(request.result.sort((a, b) => a.sequence - b.sequence));
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to restore recording chunks"));
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Recording chunk read aborted"));
    };
  });
}

export async function deleteCallDraft(callId: string) {
  const chunks = await listChunks(callId);
  await Promise.all(chunks.map((chunk) => deleteChunk(callId, chunk.sequence)));
  await deleteDraft(callId);
}
