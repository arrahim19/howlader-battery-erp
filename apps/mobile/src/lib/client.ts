import type { CurrentUser } from "../../../../packages/api-client/src";

export type { CurrentUser };
export type Session = {
  origin: string;
  accessToken: string;
  expiresAt: string;
  userId?: string;
  shopId?: string;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class ConnectionError extends Error {}
export function normalizeOrigin(value: string, production = false) {
  const url = new URL(value.trim());
  const host = url.hostname;
  const privateHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "Enter only the website address, without a path or password.",
    );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && privateHost && !production)
  )
    throw new Error(
      "Use an HTTPS website address. A local network HTTP address is allowed in the preview app.",
    );
  return url.origin;
}
export async function request<T>(
  origin: string,
  route: string,
  options: {
    token?: string;
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    route === "/mobile/offline-bootstrap" ? 120000 : 25000,
  );
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort);
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await fetch(origin + "/api/v1" + route, {
      method: options.method ?? "GET",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const result = await response.json().catch(() => null);
    if (!result)
      throw new ApiError(
        response.status,
        "The server did not return ERP data. Check the website address.",
      );
    if (!response.ok)
      throw new ApiError(
        response.status,
        result.error?.message ?? "Unable to complete this request.",
      );
    return result.data as T;
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted)
      throw new ConnectionError(
        "Connection timed out. Check your network and try again.",
      );
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        /network request failed|fetch failed|UnknownHostException|Unable to resolve host|ENOTFOUND|ECONNREFUSED/i.test(
          error.message,
        ))
    )
      throw new ConnectionError(
        "Cannot reach the shop server. Check your connection and website address.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
