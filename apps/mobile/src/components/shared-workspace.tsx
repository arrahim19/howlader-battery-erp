import { useCallback, useEffect, useState } from "react";
import { BackHandler, Linking, Platform } from "react-native";
import { useRouter, useRootNavigationState } from "expo-router";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { queueable } from "../lib/offline/engine";
import { handleDeviceBack } from "../lib/device-back";
import { SafeAreaView } from "react-native-safe-area-context";
import { Loading } from "./ui";
import Workspace from "../shared-web/workspace";
import { useSession } from "../lib/session";
import { ApiError, normalizeOrigin, request } from "../lib/client";
import type { BridgeRequest, BridgeResult } from "../shared-web/types";
import { offlineSalt } from "../lib/offline/auth";
import type { PasswordVerifier } from "../lib/offline/password";

export function SharedWorkspace({ pathname }: { pathname: string }) {
  const auth = useSession();
  const router = useRouter();
  const navigation = useRootNavigationState();
  const [origin, setOrigin] = useState(
    process.env.EXPO_PUBLIC_SERVER_URL ?? "http://10.0.2.2:3000",
  );
  const navigate = useCallback(
    async (href: string, replace = false) => {
      if (href === "__back__") {
        router.back();
        return;
      }
      if (!href.startsWith("/") || href.startsWith("//")) {
        await Linking.openURL(href);
        return;
      }
      const target =
        href === "/device" || href === "/google-sign-in" || href === "/login"
          ? "/login"
          : "/workspace" + href;
      if (replace) router.replace(target as "/login");
      else router.push(target as "/login");
    },
    [router],
  );
  useEffect(() => {
    if (Platform.OS === "web") return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      return handleDeviceBack(pathname, {
        canGoBack: () => router.canGoBack(),
        back: () => router.back(),
        home: () => router.replace("/workspace/dashboard"),
        lock: auth.forget,
        exit: () => BackHandler.exitApp(),
      });
    });
    return () => listener.remove();
  }, [pathname, router, auth.forget]);
  useEffect(() => {
    if (!navigation?.key || auth.loading) return;
    if (!auth.user && pathname !== "/login" && pathname !== "/forgot-password")
      router.replace("/login");
    else if (auth.user && pathname === "/login")
      router.replace("/workspace/dashboard");
  }, [navigation?.key, auth.loading, auth.user, pathname, router]);
  const onRequest = useCallback(
    async ({
      route,
      method,
      body,
      key,
    }: BridgeRequest): Promise<BridgeResult> => {
      try {
        if (route.startsWith("/__local/")) {
          if (!auth.user || !auth.local)
            throw new ApiError(401, "Please sign in.");
          const id = (body as { id?: string } | undefined)?.id;
          if (route.startsWith("/__local/receipt?") && method === "GET")
            return {
              ok: true,
              data: await auth.local.receipt(
                new URLSearchParams(route.split("?")[1]).get("id") || "",
              ),
            };
          if (route === "/__local/commands" && method === "GET")
            return { ok: true, data: await auth.local.commands() };
          if (route === "/__local/sync" && method === "POST")
            await auth.local.sync(true);
          else if (route === "/__local/retry" && method === "POST" && id)
            await auth.local.retry(id);
          else if (route === "/__local/discard" && method === "POST" && id)
            await auth.local.discardRejected(id);
          else throw new Error("Unknown local database action.");
          return { ok: true, data: null };
        }
        if (route === "/__auth/offline-salt") {
          const fields = body as { login: string };
          return {
            ok: true,
            data: await offlineSalt(
              normalizeOrigin(
                origin,
                Constants.expoConfig?.extra?.production === true,
              ),
              fields.login,
            ),
          };
        }
        if (route === "/auth/login") {
          const fields = body as {
            login: string;
            password: string;
            offlineVerifier?: PasswordVerifier;
          };
          await auth.signIn(
            normalizeOrigin(
              origin,
              Constants.expoConfig?.extra?.production === true,
            ),
            fields.login,
            fields.password,
            fields.offlineVerifier,
          );
          return { ok: true, data: null };
        }
        if (route === "/auth/logout") {
          await auth.signOut();
          return { ok: true, data: null };
        }
        if (!auth.user) {
          if (route !== "/auth/forgot-password")
            throw new ApiError(401, "Please sign in.");
          return {
            ok: true,
            data: await request(
              normalizeOrigin(
                origin,
                Constants.expoConfig?.extra?.production === true,
              ),
              "/auth/mobile/forgot-password",
              { method, body },
            ),
          };
        }
        if (method === "GET") {
          if (!auth.local) throw new Error("Local database is not ready.");
          return { ok: true, data: (await auth.local.read(route)).data };
        }
        if (method === "POST" && queueable(route)) {
          const result = await auth.submit(
            route,
            body,
            key || Crypto.randomUUID(),
          );
          if (result.queued) {
            const rejected = (await auth.local?.commands())?.find(
              (command) =>
                command.id === result.id && command.state === "blocked",
            );
            if (rejected)
              return {
                ok: false,
                status: 409,
                message:
                  rejected.error +
                  " Open Sync & local data to review this rejected transaction.",
              };
            return {
              ok: false,
              status: 202,
              message:
                "Saved on this device. Waiting for server confirmation. Open Sync & local data to review; do not create this transaction again.",
            };
          }
          return { ok: true, data: result.data };
        }
        const data = await auth.api(route, { method, body, key });
        if (route === "/auth/change-password") await auth.forget();
        else {
          if (/^\/users\/[^/]+\/profile$/.test(route)) await auth.refreshUser();
          await auth.local?.sync(true);
        }
        return { ok: true, data };
      } catch (error) {
        return {
          ok: false,
          status: error instanceof ApiError ? error.status : 0,
          message:
            error instanceof Error
              ? error.message
              : "Unable to complete this request.",
        };
      }
    },
    [auth, origin],
  );
  if (auth.loading) return <Loading />;
  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      style={{ flex: 1, backgroundColor: "#fafbfe" }}
    >
      <Workspace
        pathname={pathname}
        nativeViewport={Platform.OS !== "web"}
        user={auth.user}
        origin={auth.session?.origin ?? origin}
        pending={auth.syncStatus.pending}
        blocked={auth.syncStatus.blocked}
        offline={auth.syncStatus.offline}
        lastSync={auth.syncStatus.lastSync}
        syncing={auth.syncStatus.syncing}
        transferring={auth.syncStatus.transferring ?? false}
        syncError={auth.syncStatus.error}
        onNavigate={navigate}
        onRequest={onRequest}
        onOriginChange={async (value) => {
          setOrigin(value);
        }}
        dom={{
          scrollEnabled: false,
          automaticallyAdjustContentInsets: false,
          contentInsetAdjustmentBehavior: "never",
          automaticallyAdjustsScrollIndicatorInsets: false,
          style: { flex: 1, backgroundColor: "#fafbfe" },
        }}
      />
    </SafeAreaView>
  );
}
