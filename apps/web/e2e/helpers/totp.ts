import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.toUpperCase().replaceAll("=", "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

export async function enrollVerifiedTotp(client: SupabaseClient) {
  const { data: enrollment, error: enrollmentError } =
    await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `test-${crypto.randomUUID()}`,
    });
  if (enrollmentError) throw enrollmentError;
  const { data: challenge, error: challengeError } =
    await client.auth.mfa.challenge({ factorId: enrollment.id });
  if (challengeError) throw challengeError;
  const { data: verification, error: verificationError } =
    await client.auth.mfa.verify({
      factorId: enrollment.id,
      challengeId: challenge.id,
      code: totpCode(enrollment.totp.secret),
    });
  if (verificationError) throw verificationError;
  return {
    factorId: enrollment.id,
    secret: enrollment.totp.secret,
    token: verification.access_token,
  };
}
