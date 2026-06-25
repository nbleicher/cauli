# CallLog — Open Source Call Recorder & Transcriber

A Chrome/Edge extension for recording browser calls with **mic + tab audio mixed into one file**, with live speech-to-text transcription.

Built for agencies doing call QA and feedback workflows.

## Features

- 🎙 **Mic only** — just your voice
- 🔊 **Tab audio** — record any browser tab (Zoom, Meet, phone dialers, anything)
- 🎙+🔊 **Both** — mic and tab mixed into a single track
- 📝 **Live transcript** — Web Speech API, no external service needed
- 🗃 **Call log** — timestamped history with full transcripts
- ⬇️ **Download** — exports as `.webm` (plays in Chrome, VLC, ffmpeg-convertible)

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
background.js          — Service worker, handles tabCapture API
sidepanel.html         — Side panel shell
sidepanel.js           — Full app: recording engine, transcript, UI
icons/                 — Extension icons
```

## Notes & Limitations

- **Tab capture** requires the user to be on the tab they want to record when hitting Start. Chrome's `tabCapture` API captures the currently focused tab.
- **Speech recognition** uses the browser's built-in Web Speech API (Chrome only). No API key needed, no data sent externally.
- **Downloads** are `.webm` (Opus codec). Convert to MP3 with: `ffmpeg -i recording.webm -q:a 2 output.mp3`
- Recordings (metadata + transcripts) are saved to `chrome.storage.local`. Audio blobs are in-memory per session — download before closing.

## Roadmap / Ideas

- [ ] Whisper API integration for higher-accuracy transcripts
- [ ] Speaker diarization ("Agent" vs "Customer" labels)
- [ ] Auto-export to Google Drive or Notion
- [ ] Waveform visualizer during recording
- [ ] MP3 export via ffmpeg.wasm

## License

MIT — fork it, ship it, build on it.
