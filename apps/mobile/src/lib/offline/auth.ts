import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import type { CurrentUser, Session } from "../client";
import {
  enrollCredential,
  unlockCredential,
  credentialSalt,
  key,
} from "./credentials";
import type { PasswordVerifier } from "./password";
const storage = {
  get: SecureStore.getItemAsync,
  set: SecureStore.setItemAsync,
};
export async function offlineSalt(origin: string, login: string) {
  return Platform.OS === "web"
    ? null
    : ((await credentialSalt(storage, origin, login)) ?? [
        ...Crypto.getRandomBytes(32),
      ]);
}
export async function enrollOffline(
  origin: string,
  login: string,
  password: string,
  session: Session,
  user: CurrentUser,
  prepared?: PasswordVerifier,
) {
  if (Platform.OS !== "web") {
    const salt = prepared
      ? new Uint8Array(prepared.salt)
      : Crypto.getRandomBytes(32);
    await enrollCredential(
      storage,
      salt,
      origin,
      login,
      password,
      session,
      user,
      prepared,
    );
  }
}
export async function unlockOffline(
  origin: string,
  login: string,
  password: string,
  prepared?: PasswordVerifier,
) {
  return Platform.OS === "web"
    ? null
    : unlockCredential(storage, origin, login, password, prepared);
}
export async function revokeOfflineEnrollment() {
  if (Platform.OS !== "web") await SecureStore.deleteItemAsync(key);
}
