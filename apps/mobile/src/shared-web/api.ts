export * from "../../../web/src/lib/api";
import {
  ApiError,
  CURRENT_USER_CHANGED_EVENT,
  RESOURCE_CHANGED_EVENT,
  SESSION_EXPIRED_EVENT,
} from "../../../web/src/lib/api";
import type { BridgeRequest, BridgeResult } from "./types";
import { passwordVerifier } from "../lib/offline/password";

let send: ((request: BridgeRequest) => Promise<BridgeResult>) | null = null;
export function connectNativeApi(next: typeof send) {
  send = next;
}
export async function api<T>(route: string, init?: RequestInit): Promise<T> {
  if (!send) throw new Error("Device database is connecting. Try again.");
  const headers = new Headers(init?.headers);
  let body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  if (route === "/auth/login") {
    // Derive in WebView WebCrypto instead of blocking the native Hermes thread.
    // The native challenge exposes only a public salt, never the stored hash/token.
    const challenge = await send({
      route: "/__auth/offline-salt",
      method: "POST",
      body: { login: body.login },
    });
    if (!challenge.ok) throw new ApiError(challenge.status, challenge.message);
    if (challenge.data) {
      const started = Date.now();
      body = {
        ...body,
        offlineVerifier: await passwordVerifier(
          body.password,
          new Uint8Array(challenge.data as number[]),
        ),
      };
      if (process.env.NODE_ENV !== "production")
        console.info(
          `[login] WebView password ready: ${Date.now() - started}ms`,
        );
    }
  }
  const result = await send({
    route,
    method: init?.method ?? "GET",
    body,
    key: headers.get("Idempotency-Key") ?? undefined,
  });
  if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!result.ok) {
    if (result.status === 401 && route !== "/auth/login")
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    if (result.status === 202)
      window.dispatchEvent(new Event("howlader:queued"));
    throw new ApiError(result.status, result.message);
  }
  if (init?.method && init.method.toUpperCase() !== "GET") {
    window.dispatchEvent(new Event(RESOURCE_CHANGED_EVENT));
    window.dispatchEvent(new Event(CURRENT_USER_CHANGED_EVENT));
    window.dispatchEvent(new Event("hawlader:dashboard-update"));
  }
  return result.data as T;
}
export async function csrf() {
  return "";
}
export function post<T>(
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return api<T>(route, { method: "POST", body: JSON.stringify(body), headers });
}
