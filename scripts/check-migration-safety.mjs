#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const forbidden =
  /\b(?:DROP\s+(?:TABLE|COLUMN|TYPE|FUNCTION)|TRUNCATE|RENAME\s+(?:TO|COLUMN))\b/i;
const baseline = JSON.parse(
  readFileSync("release/migration-contract-baseline.json", "utf8")
);
const files = readdirSync("supabase/migrations").filter((name) =>
  name.endsWith(".sql")
);

for (const file of files) {
  const contents = readFileSync(`supabase/migrations/${file}`, "utf8");
  const acceptedHash = baseline[file];
  if (acceptedHash) {
    const hash = createHash("sha256").update(contents).digest("hex");
    if (hash !== acceptedHash) {
      console.error(
        `${file} changed after the migration-contract baseline; add a new compatible migration instead`
      );
      process.exitCode = 1;
    }
    continue;
  }
  const match = contents.match(forbidden);
  if (match) {
    console.error(
      `${file} contains ${match[0]}; destructive contract changes require a later, separately accepted release`
    );
    process.exitCode = 1;
  }
}

for (const file of Object.keys(baseline)) {
  if (!files.includes(file)) {
    console.error(`${file} was removed from the accepted migration baseline`);
    process.exitCode = 1;
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Expand-migrate-contract safety check passed.");
