import type { CaptureSource, SourceMode } from "@calllog/shared";

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    brands: Array<{ brand: string; version: string }>;
    platform: string;
  };
}

export type RecordingSupport =
  { supported: true; platform: "macOS" | "Windows" } | { supported: false };

export function detectRecordingSupport(): RecordingSupport {
  const browserNavigator = navigator as NavigatorWithUserAgentData;
  const userAgent = browserNavigator.userAgent;
  const brands = browserNavigator.userAgentData?.brands ?? [];
  const hasUserAgentData = brands.length > 0;
  const isGoogleChrome = hasUserAgentData
    ? brands.some(({ brand }) => brand === "Google Chrome")
    : /\bChrome\//.test(userAgent) &&
      !/\b(?:Edg|OPR|Vivaldi|Brave)\//.test(userAgent);

  const platformValue = [
    browserNavigator.userAgentData?.platform,
    browserNavigator.platform,
    userAgent,
  ]
    .filter(Boolean)
    .join(" ");
  const platform = /Mac|macOS/i.test(platformValue)
    ? "macOS"
    : /Win|Windows/i.test(platformValue)
      ? "Windows"
      : null;

  return isGoogleChrome && platform
    ? { supported: true, platform }
    : { supported: false };
}

export interface ActiveCapture {
  outputStream: MediaStream;
  sourceStreams: Array<{
    source: CaptureSource;
    stream: MediaStream;
  }>;
  audioContext: AudioContext | null;
  micLabel: string;
  tabLabel: string;
}

export function supportedRecordingMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/webm"];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export async function closeActiveCapture(capture: ActiveCapture | null) {
  capture?.sourceStreams.forEach(({ stream }) => {
    stream.getTracks().forEach((track) => track.stop());
  });
  capture?.outputStream.getTracks().forEach((track) => track.stop());
  await capture?.audioContext?.close().catch(() => undefined);
}

export async function acquireCapture(mode: SourceMode): Promise<ActiveCapture> {
  let micStream: MediaStream | null = null;
  let displayStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;

  try {
    if (mode === "tab" || mode === "both") {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      if (displayStream.getAudioTracks().length === 0) {
        throw new Error(
          "No tab audio was shared. Choose the call tab and enable Share tab audio."
        );
      }
    }

    if (mode === "mic" || mode === "both") {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    }

    const micLabel = micStream?.getAudioTracks()[0]?.label ?? "";
    const tabLabel =
      displayStream?.getVideoTracks()[0]?.label ||
      displayStream?.getAudioTracks()[0]?.label ||
      "";

    displayStream?.getVideoTracks().forEach((track) => track.stop());
    const sourceStreams: ActiveCapture["sourceStreams"] = [
      ...(micStream ? [{ source: "mic" as const, stream: micStream }] : []),
      ...(displayStream
        ? [{ source: "tab" as const, stream: displayStream }]
        : []),
    ];

    if (mode !== "both") {
      const stream = mode === "mic" ? micStream : displayStream;
      if (!stream) {
        throw new Error("The selected audio source was unavailable.");
      }
      return {
        outputStream: new MediaStream(stream.getAudioTracks()),
        sourceStreams,
        audioContext: null,
        micLabel,
        tabLabel,
      };
    }

    if (!micStream || !displayStream) {
      throw new Error("Both audio sources are required.");
    }
    audioContext = new AudioContext();
    await audioContext.resume();
    const destination = audioContext.createMediaStreamDestination();
    const tabSource = audioContext.createMediaStreamSource(
      new MediaStream(displayStream.getAudioTracks())
    );
    const micSource = audioContext.createMediaStreamSource(micStream);
    const tabGain = audioContext.createGain();
    const micGain = audioContext.createGain();
    tabGain.gain.value = 0.75;
    micGain.gain.value = 0.9;
    tabSource.connect(tabGain).connect(destination);
    micSource.connect(micGain).connect(destination);

    return {
      outputStream: destination.stream,
      sourceStreams,
      audioContext,
      micLabel,
      tabLabel,
    };
  } catch (error) {
    micStream?.getTracks().forEach((track) => track.stop());
    displayStream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => undefined);
    throw error;
  }
}
