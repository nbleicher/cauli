# Manual Verification

Run automated checks first:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Browser capture

Primary release matrix:

- Chrome stable on macOS: complete before this release.
- Chrome stable on Windows 11: complete on the Windows test machine.
- Firefox, Safari, and Edge: confirm recording controls are unavailable with a
  clear Chrome desktop explanation while Calls, Reviews, administration, and
  account settings remain usable.
- SalesGod CRM and Athena Text: full Mic, Tab, and Both coverage.
- Google Meet and Zoom: smoke coverage for capture and playback.

- Confirm Start recording remains disabled until the Recording Attestation is
  checked, and confirm the wording neither claims the checkbox establishes
  lawfulness nor says counsel reviewed it.
- Give one Call a title before capture and leave another blank. Confirm the
  first keeps its title and the second uses its date and time.
- Confirm the capture experience states that Transcript generation is
  English-only.
- Mic: allow permission, speak, stop, and confirm audible playback.
- Tab: choose the call tab, enable tab audio, stop, and confirm playback.
- Both: confirm both sides are audible and synchronized.
- Confirm the visible Stop and save action becomes disabled immediately after
  one click and local durability is confirmed within three seconds.
- Deny microphone permission and confirm no call draft is created.
- Share a source without tab audio and confirm the recorder rejects it.
- In Both mode, stop tab sharing or disconnect the microphone. Confirm the
  surviving source continues, the UI says Degraded, and Call Detail records the
  source-loss interval.
- End the final surviving source and confirm the completed portion is saved.
- Drop the network during recording, restore it, and confirm IndexedDB chunks upload.
- Refresh with an interrupted draft and use Recover.
- Record silence and confirm processing failure is visible and retryable.
- Confirm normal levels are audible without clipping and Both-mode drift stays
  below 250 ms in the three-hour soak.

## Processing

- Restart the worker during a job and confirm the retry does not duplicate transcript segments.
- Confirm completed 10-minute chunks are loaded from checkpoints after restart
  and only unfinished chunks reach OpenRouter.
- Confirm every OpenRouter request uses English, `zdr: true`, and
  `data_collection: deny`.
- Force 401/402 responses and confirm no retry/fallback occurs. Force
  network/408/429/5xx responses and confirm retry/backoff, then Large V3
  fallback after Turbo exhausts its attempts.
- Submit the same finalize request twice and confirm only one processing job exists.
- Request WAV twice and confirm one output artifact is produced.
- Run a three-hour recording soak test while watching browser storage, Supabase storage, worker memory, and final audio duration.

## Authorization

- Member can see, download, review-read, and delete only their own calls.
- A Call owner can rename after capture. A Manager and Admin can see another
  owner’s title but cannot rename it through the UI, API, or database RPC.
- Manager can see all calls and submit reviews but cannot delete another user's call.
- Admin can manage roles, publish scorecards, and delete any call.
- Attempt direct table and Storage reads with each role to verify RLS.
- Verify the last admin cannot demote or remove themselves.

## Scorecards

- Publish a new version and confirm old reviews retain the prior criteria.
- Confirm scores map 1 to 0, 3 to 50, and 5 to 100.
- Mark a high-weight criterion N/A and confirm it leaves the denominator.
- Confirm required criteria do not offer N/A and cannot be omitted from a
  submitted Review.
- Confirm Reviewed requires a summary and Needs Follow-up also requires a
  specific follow-up explanation.
- Submit from two sessions and confirm the stale session receives a conflict.
- Confirm every submit creates an immutable revision.
- Confirm Members cannot read an In Progress draft through either the UI or a
  direct table request.

## Archived extension migration

The legacy extension-import path is unsupported and excluded from production
navigation, deployment, and pilot acceptance. Its retained source is historical
only and must not be included in a production release artifact.
