import type { Page } from "@playwright/test";

type BrowserName = "chrome" | "edge" | "firefox" | "safari";
type DesktopPlatform = "macOS" | "windows";

export async function installBrowserIdentity(
  page: Page,
  {
    browser,
    platform,
  }: {
    browser: BrowserName;
    platform: DesktopPlatform;
  }
) {
  const isWindows = platform === "windows";
  const platformName = isWindows ? "Windows" : "macOS";
  const navigatorPlatform = isWindows ? "Win32" : "MacIntel";
  const platformToken = isWindows
    ? "Windows NT 10.0; Win64; x64"
    : "Macintosh; Intel Mac OS X 14_6";
  const userAgents: Record<BrowserName, string> = {
    chrome: `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36`,
    edge: `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0`,
    firefox: `Mozilla/5.0 (${platformToken}; rv:140.0) Gecko/20100101 Firefox/140.0`,
    safari: `Mozilla/5.0 (${platformToken}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15`,
  };
  const brands =
    browser === "chrome"
      ? [
          { brand: "Chromium", version: "138" },
          { brand: "Google Chrome", version: "138" },
        ]
      : browser === "edge"
        ? [
            { brand: "Chromium", version: "138" },
            { brand: "Microsoft Edge", version: "138" },
          ]
        : [];

  await page.addInitScript(
    ({ userAgent, navigatorPlatform, platformName, brands }) => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: userAgent,
      });
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: navigatorPlatform,
      });
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: brands.length ? { brands, platform: platformName } : undefined,
      });
    },
    {
      userAgent: userAgents[browser],
      navigatorPlatform,
      platformName,
      brands,
    }
  );
}

export async function installFakeMediaCapture(
  page: Page,
  { platform = "macOS" }: { platform?: DesktopPlatform } = {}
) {
  await installBrowserIdentity(page, { browser: "chrome", platform });
  await page.addInitScript(() => {
    class FakeTrack extends EventTarget {
      kind: string;
      label: string;
      readyState = "live";

      constructor(kind: string, label: string) {
        super();
        this.kind = kind;
        this.label = label;
      }

      stop() {
        this.readyState = "ended";
      }

      end() {
        if (this.readyState === "ended") return;
        this.readyState = "ended";
        this.dispatchEvent(new Event("ended"));
      }
    }

    class FakeMediaStream {
      tracks: FakeTrack[];

      constructor(tracks: FakeTrack[] = []) {
        this.tracks = tracks;
      }

      getTracks() {
        return this.tracks;
      }

      getAudioTracks() {
        return this.tracks.filter((track) => track.kind === "audio");
      }

      getVideoTracks() {
        return this.tracks.filter((track) => track.kind === "video");
      }
    }

    const mic = new FakeTrack("audio", "Test microphone");
    const tab = new FakeTrack("audio", "Test call tab");
    const video = new FakeTrack("video", "Test call tab");
    const output = new FakeTrack("audio", "Mixed output");
    let recorder: FakeMediaRecorder | null = null;

    class FakeAudioContext {
      createMediaStreamDestination() {
        return { stream: new FakeMediaStream([output]) };
      }

      createMediaStreamSource() {
        return {
          connect() {
            return this;
          },
        };
      }

      createGain() {
        return {
          gain: { value: 1 },
          connect() {
            return this;
          },
        };
      }

      async resume() {}
      async close() {}
    }

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }

      mimeType: string;
      state = "inactive";

      constructor(_stream: FakeMediaStream, options?: { mimeType?: string }) {
        super();
        this.mimeType = options?.mimeType ?? "audio/webm";
        recorder = this;
      }

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.dispatchEvent(
          new MessageEvent("dataavailable", {
            data: new Blob(["recorded audio"], { type: this.mimeType }),
          })
        );
        this.dispatchEvent(new Event("stop"));
      }
    }

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: async () => new FakeMediaStream([tab, video]),
        getUserMedia: async () => new FakeMediaStream([mic]),
      },
    });
    Object.defineProperty(window, "MediaStream", {
      configurable: true,
      value: FakeMediaStream,
    });
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
    Object.defineProperty(window, "__cauliMedia", {
      configurable: true,
      value: {
        end(source: "mic" | "tab") {
          (source === "mic" ? mic : tab).end();
        },
        state() {
          return {
            recorderState: recorder?.state ?? "missing",
            liveAudioTracks: [mic, tab, output].filter(
              (track) => track.readyState === "live"
            ).length,
          };
        },
      },
    });
  });
}
