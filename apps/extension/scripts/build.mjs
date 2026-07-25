import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(extensionRoot, "dist");
const origin = (process.env.CALLLOG_WEB_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
const supabaseOrigin = (
  process.env.CALLLOG_SUPABASE_ORIGIN || "http://127.0.0.1:54321"
).replace(/\/$/, "");
const appUrl = `${origin}/record`;

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const entries = [
  "background.js",
  "companion-config.js",
  "content.js",
  "icons",
  "lib",
  "manifest.json",
  "migration-bridge.js",
  "migration.js",
  "offscreen.html",
  "offscreen.js",
  "permissions.html",
  "permissions.js",
  "recorder.html",
  "recorder.js",
  "sidepanel.html",
  "sidepanel.js",
];

for (const entry of entries) {
  await cp(resolve(extensionRoot, entry), resolve(outputRoot, entry), { recursive: true });
}

const manifestPath = resolve(outputRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.content_scripts = manifest.content_scripts.map((script) => (
  script.js.includes("migration-bridge.js")
    ? { ...script, matches: [`${origin}/*`] }
    : script
));
manifest.content_security_policy.extension_pages = [
  "script-src 'self'",
  "object-src 'self'",
  `connect-src https://api.groq.com ${supabaseOrigin}`,
].join("; ");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const configPath = resolve(outputRoot, "companion-config.js");
await writeFile(
  configPath,
  `globalThis.CALLLOG_COMPANION_CONFIG = Object.freeze(${JSON.stringify({
    webAppOrigin: origin,
    webAppUrl: appUrl,
    supabaseOrigin,
  }, null, 2)});\n`,
);

process.stdout.write(`Built cauli extension for ${origin} at ${outputRoot}\n`);
