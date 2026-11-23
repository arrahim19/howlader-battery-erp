export type CredentialStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};
import type { CurrentUser, Session } from "../client";
import {
  matchesPassword,
  passwordVerifier,
  sameVerifier,
  validVerifier,
  type PasswordVerifier,
} from "./password";

export const key = "hawlader.offline-login.v1";
type Enrollment = {
  origin: string;
  login: string;
  session: Session;
  user: CurrentUser;
  verifier: PasswordVerifier;
  failures: number;
  retryAt: number;
};
export async function credentialSalt(
  storage: CredentialStorage,
  origin: string,
  login: string,
) {
  const raw = await storage.get(key);
  if (!raw) return null;
  const saved = JSON.parse(raw) as Enrollment;
  return saved.origin === origin &&
    [saved.login, saved.user.login.toLowerCase()].includes(
      login.trim().toLowerCase(),
    ) &&
    validVerifier(saved.verifier)
    ? saved.verifier.salt
    : null;
}
// Device unlock material belongs in encrypted storage, never in the DOM or SQLite.
export async function enrollCredential(
  storage: CredentialStorage,
  salt: Uint8Array,
  origin: string,
  login: string,
  password: string,
  session: Session,
  user: CurrentUser,
  prepared?: PasswordVerifier,
) {
  if (prepared && !validVerifier(prepared))
    throw new Error("Invalid offline credential.");
  const enrollment: Enrollment = {
    origin,
    login: login.trim().toLowerCase(),
    session,
    user,
    verifier: prepared ?? (await passwordVerifier(password, salt)),
    failures: 0,
    retryAt: 0,
  };
  await storage.set(key, JSON.stringify(enrollment));
}
export async function unlockCredential(
  storage: CredentialStorage,
  origin: string,
  login: string,
  password: string,
  prepared?: PasswordVerifier,
) {
  const raw = await storage.get(key);
  if (!raw) return null;
  const saved = JSON.parse(raw) as Enrollment;
  if (
    saved.origin !== origin ||
    ![saved.login, saved.user.login.toLowerCase()].includes(
      login.trim().toLowerCase(),
    )
  )
    return null;
  if (saved.retryAt > Date.now())
    throw new Error("Too many attempts. Wait one minute and try again.");
  if (
    !(prepared
      ? sameVerifier(prepared, saved.verifier)
      : await matchesPassword(password, saved.verifier))
  ) {
    saved.failures++;
    if (saved.failures >= 5) saved.retryAt = Date.now() + 60000;
    await storage.set(key, JSON.stringify(saved));
    throw new Error("Incorrect email or password for this device.");
  }
  saved.failures = 0;
  saved.retryAt = 0;
  await storage.set(key, JSON.stringify(saved));
  return saved;
}
