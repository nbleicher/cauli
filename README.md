# CallLog — Open Source Call Recorder & Transcriber

A Chrome/Edge extension for recording browser calls with **mic + tab audio mixed into one file**, MP3/WAV downloads, and Groq Whisper transcription.

Built for agencies doing call QA and feedback workflows.

## Features

- 🎙 **Mic only** — just your voice
- 🔊 **Tab audio** — record any browser tab (Zoom, Meet, phone dialers, anything)
- 🎙+🔊 **Both** — mic and tab mixed into a single track
- 📝 **Transcript** — Groq audio transcription with `whisper-large-v3-turbo`
- 🗃 **Call log** — timestamped history with full transcripts
- ⬇️ **Download** — exports as `.mp3` or `.wav`
- 🎚 **Microphone selection** — choose the input device used for mic recording
- 🔐 **Mic permission page** — opens a Chrome extension tab so Chrome can grant microphone access reliably

## Install (Developer Mode)

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge)
3. Enable **Developer Mode** (top right toggle)
4. Click **Load unpacked**
5. Select this folder (`call-recorder-extension/`)
6. Pin the extension → click it to open the side panel

## Usage

1. Navigate to the tab you want to record (Zoom, Google Meet, a softphone, etc.)
2. Click the CallLog icon → side panel opens
3. Choose your audio source: **Mic**, **Tab**, or **Both**
4. Hit **Start Recording**
5. When done → **Stop & Save**
6. View full transcript + download audio in the **Log** tab

## Architecture

```
manifest.json          — MV3 config, permissions
background.js          — Service worker, manages offscreen mic capture
permissions.html/js    — Visible extension page that requests Chrome microphone permission
content.js             — Injects the hidden microphone iframe into the active page
recorder.html/js       — Synchronized mic + tab recorder used for Both mode
offscreen.js/html      — Offscreen helper for microphone device checks
sidepanel.html         — Side panel shell
sidepanel.js           — Full app: recording engine, Groq transcription, MP3/WAV export, UI
icons/                 — Extension icons
```

## Notes & Limitations

- **Tab audio** uses Chrome's screen/tab picker. Select the dialer tab and make sure **Share tab audio** is enabled.
- **Mic capture** runs in a hidden extension iframe injected into the active page. Chrome can suppress native mic prompts from side panels/offscreen documents, so the iframe requests and records the microphone, then relays chunks back to the side panel.
- **Both mode** uses a dedicated extension recorder page so mic and tab audio are mixed in one `AudioContext` and recorded by one `MediaRecorder`.
- **Transcription** sends the recorded audio to Groq's OpenAI-compatible audio transcription endpoint using `whisper-large-v3-turbo`.
- **Downloads** are converted in-browser to `.mp3` or `.wav`. Audio blobs are in-memory per session, so download before closing the side panel.
- Recordings metadata and transcripts are saved to `chrome.storage.local`.

## Roadmap / Ideas

- [ ] Persist audio blobs across side panel/browser restarts
- [ ] Speaker diarization ("Agent" vs "Customer" labels)
- [ ] Auto-export to Google Drive or Notion
- [ ] Waveform visualizer during recording

## License

MIT — fork it, ship it, build on it.
