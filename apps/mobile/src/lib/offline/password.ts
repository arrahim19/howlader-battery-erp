import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";
import { utf8 } from "../../../../../packages/drive-sync/src/bytes";

export type PasswordVerifier = {
  salt: number[];
  hash: number[];
  rounds: number;
};
export function validVerifier(value: PasswordVerifier) {
  return (
    value?.rounds === 210000 &&
    Array.isArray(value.hash) &&
    value.hash.length === 32 &&
    Array.isArray(value.salt) &&
    value.salt.length === 32 &&
    [...value.hash, ...value.salt].every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  );
}
export function sameVerifier(
  candidate: PasswordVerifier,
  saved: PasswordVerifier,
) {
  if (!validVerifier(candidate) || !validVerifier(saved)) return false;
  let difference = 0;
  for (let i = 0; i < 32; i++)
    difference |=
      (candidate.hash[i] ^ saved.hash[i]) | (candidate.salt[i] ^ saved.salt[i]);
  return difference === 0;
}
export async function passwordVerifier(
  password: string,
  salt: Uint8Array,
): Promise<PasswordVerifier> {
  const rounds = 210000;
  if (globalThis.crypto?.subtle) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new Uint8Array(salt),
        iterations: rounds,
      },
      key,
      256,
    );
    return { salt: [...salt], hash: [...new Uint8Array(bits)], rounds };
  }
  const hash = await pbkdf2Async(sha256, utf8(password), salt, {
    c: rounds,
    dkLen: 32,
    asyncTick: 8,
  });
  return { salt: [...salt], hash: [...hash], rounds };
}
export async function matchesPassword(
  password: string,
  verifier: PasswordVerifier,
) {
  if (!validVerifier(verifier)) return false;
  return sameVerifier(
    await passwordVerifier(password, new Uint8Array(verifier.salt)),
    verifier,
  );
}
