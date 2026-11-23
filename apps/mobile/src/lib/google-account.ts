import * as SecureStore from "expo-secure-store";
import { Linking, Platform } from "react-native";
import {
  GoogleAccountLogin,
  type GoogleLoginGrant,
  type PendingGoogleLogin,
} from "../../../../packages/drive-sync/src";
import deployment from "../../../../google-apps-script/deployment.json";
import { nativeDriveCrypto } from "./drive-crypto";
const prefix = "howlader.google.v1.";
const login = () =>
  new GoogleAccountLogin(deployment.url, fetch, nativeDriveCrypto);
export async function beginGoogleAccountLogin() {
  if (Platform.OS === "web")
    throw new Error(
      "Use the desktop secure-storage adapter for desktop login.",
    );
  let id = await SecureStore.getItemAsync(prefix + "device");
  if (!id) {
    id = nativeDriveCrypto.randomId();
    await SecureStore.setItemAsync(prefix + "device", id);
  }
  const pending = login().prepare(
    id,
    Platform.OS === "android" ? "Android phone" : "Phone",
  );
  await SecureStore.setItemAsync(prefix + "pending", JSON.stringify(pending));
  const start = await login().start(pending);
  // Open Google's own browser surface; never collect a Gmail password in a WebView.
  await Linking.openURL(start.url);
}
export async function finishGoogleAccountLogin(): Promise<GoogleLoginGrant | null> {
  const serialized = await SecureStore.getItemAsync(prefix + "pending");
  if (!serialized) return null;
  const pending = JSON.parse(serialized) as PendingGoogleLogin;
  const result = await login().poll(pending);
  if (result.status !== "complete") return null;
  const { grant } = result;
  await SecureStore.setItemAsync(
    prefix + "secrets",
    JSON.stringify({
      pairing: grant.pairing,
      shopKey: grant.shopKey,
      expiresAt: grant.expiresAt,
      userId: grant.user.id,
    }),
  );
  await SecureStore.setItemAsync(
    prefix + "profile",
    JSON.stringify(grant.user),
  );
  await SecureStore.deleteItemAsync(prefix + "pending");
  await login()
    .acknowledge(pending)
    .catch(() => {});
  return grant;
}
export async function savedGoogleAccount(): Promise<GoogleLoginGrant | null> {
  const [secret, profile] = await Promise.all([
    SecureStore.getItemAsync(prefix + "secrets"),
    SecureStore.getItemAsync(prefix + "profile"),
  ]);
  if (!secret || !profile) return null;
  const keys = JSON.parse(secret),
    user = JSON.parse(profile);
  if (
    keys.userId !== user.id ||
    keys.pairing.shopId !== user.shop?.id ||
    !/^[a-f0-9]{64}$/.test(keys.shopKey)
  )
    throw new Error(
      "Saved Google account does not match its device keys. Sign in again.",
    );
  return {
    pairing: keys.pairing,
    shopKey: keys.shopKey,
    expiresAt: keys.expiresAt,
    user,
  };
}
