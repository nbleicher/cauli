import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(extensionRoot, "dist");
const manifest = JSON.parse(
  await readFile(resolve(outputRoot, "manifest.json"), "utf8")
);

assert.deepEqual(manifest.permissions, ["storage", "tabs"]);
assert.equal(manifest.side_panel, undefined);
assert.equal(manifest.content_scripts.length, 1);
assert.deepEqual(manifest.content_scripts[0].js, [
  "companion-config.js",
  "migration-bridge.js",
]);

const serializedManifest = JSON.stringify(manifest);
assert.doesNotMatch(serializedManifest, /groq|sidepanel|tabCapture|offscreen/i);

for (const entry of [
  "content.js",
  "offscreen.html",
  "offscreen.js",
  "permissions.html",
  "permissions.js",
  "recorder.html",
  "recorder.js",
  "sidepanel.html",
  "sidepanel.js",
]) {
  await assert.rejects(access(resolve(outputRoot, entry)));
}

const background = await readFile(resolve(outputRoot, "background.js"), "utf8");
assert.doesNotMatch(
  background,
  /START_SYNC_RECORDING|START_MIC|GET_TAB_CAPTURE_STREAM_ID|api\.groq\.com/
);
