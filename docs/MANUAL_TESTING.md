# Manual Verification

Run automated checks first:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Browser capture

Verify in current Chrome and Edge:

- Mic: allow permission, speak, stop, and confirm audible playback.
- Tab: choose the call tab, enable tab audio, stop, and confirm playback.
- Both: confirm both sides are audible and synchronized.
- Deny microphone permission and confirm no call draft is created.
- Share a source without tab audio and confirm the recorder rejects it.
- Stop tab sharing or disconnect the microphone and confirm the partial recording finalizes.
- Drop the network during recording, restore it, and confirm IndexedDB chunks upload.
- Refresh with an interrupted draft and use Recover.
- Record silence and confirm processing failure is visible and retryable.

## Processing

- Restart the worker during a job and confirm the retry does not duplicate transcript segments.
- Submit the same finalize request twice and confirm only one processing job exists.
- Request WAV twice and confirm one output artifact is produced.
- Run a three-hour recording soak test while watching browser storage, Supabase storage, worker memory, and final audio duration.

## Authorization

- Member can see, download, review-read, and delete only their own calls.
- Manager can see all calls and submit reviews but cannot delete another user's call.
- Admin can manage roles, publish scorecards, and delete any call.
- Attempt direct table and Storage reads with each role to verify RLS.
- Verify the last admin cannot demote or remove themselves.

## Scorecards

- Publish a new version and confirm old reviews retain the prior criteria.
- Confirm scores map 1 to 0, 3 to 50, and 5 to 100.
- Mark a high-weight criterion N/A and confirm it leaves the denominator.
- Submit from two sessions and confirm the stale session receives a conflict.
- Confirm every submit creates an immutable revision.

## Extension migration

Use a v1.1.8 profile containing source-only, converted, completed-transcript, failed-transcript, and partially saved recordings.

- Confirm the web page detects only the exact-origin companion extension.
- Retry migration and confirm `(workspace, user, legacy ID)` prevents duplicates.
- Confirm existing completed transcripts are preserved without retranscription.
- Confirm recordings without transcripts are processed normally.
- Delete an imported call and confirm source, converted, and generated artifacts are removed.
