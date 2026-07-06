# CallLog First Tester Setup

## Install

1. Download and unzip `calllog-test-v1.1.8.zip`.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the unzipped `calllog-test-v1.1.8` folder.
6. Pin **CallLog** from the Chrome extensions menu.

## First Run

1. Open the browser tab where the call/dialer will run.
2. Click the CallLog extension icon to open the side panel.
3. Go to **Settings** and confirm it says `CallLog v1.1.8`.
4. Choose **Mic** first and start a short test recording.
5. If prompted, allow microphone access.
6. Confirm the mic line shows the expected input and a level above `0.000` while speaking.

## Recording A Call

1. Use **Both** for calls.
2. Optional: before the call starts, click **Set Call Tab**.
3. When Chrome asks what to share, select the dialer tab.
4. Make sure **Share tab audio** is enabled.
5. When the call starts, click **Start Recording**.
6. Click **Stop & Save** in the side panel.

## Transcription

Transcription requires a Groq API key in **Settings**. Without a key, recording and download still work, but transcription will fail.
