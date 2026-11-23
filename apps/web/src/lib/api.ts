import { randomId } from "@/lib/random-id";
import type {
  CurrentUser,
  DashboardData,
  SupplierList,
  SupplierRecord,
} from "../../../../packages/api-client/src";
export type { CurrentUser, DashboardData, SupplierList, SupplierRecord };
export type {
  SupplierLedger,
  SupplierLedgerList,
  SupplierLedgerRecord,
  CustomerSalesHistory,
  CustomerLedger,
  ReplacementStage,
  ReplacementCase,
  ReplacementList,
  ReplacementOptions,
  CatalogMetadata,
  CatalogProduct,
  ProductList,
  ProductTypeRecord,
  ProductTrackingKind,
  PurchaseOptions,
  PurchaseList,
  RecentPurchases,
  ReceivedPurchase,
  CustomerRecord,
  CustomerList,
  SalesOptions,
  CompletedSale,
  SalesList,
  ExpenseRecord,
  ExpenseList,
  ExpenseOptions,
} from "../../../../packages/api-client/src";
export const SESSION_EXPIRED_EVENT = "hawlader:session-expired";
export const CURRENT_USER_CHANGED_EVENT = "hawlader:current-user-changed";
export const RESOURCE_CHANGED_EVENT = "hawlader:resources-changed";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type DeviceRequest = (route: string, init?: RequestInit) => Promise<unknown>;
let deviceRequest: { request: DeviceRequest } | null = null;
export function connectDeviceApi(request: DeviceRequest) {
  const binding = { request };
  deviceRequest = binding;
  return () => {
    if (deviceRequest === binding) deviceRequest = null;
  };
}
export async function api<T>(route: string, init?: RequestInit): Promise<T> {
  if (deviceRequest) {
    const data = await deviceRequest.request(route, init);
    if (
      init?.method &&
      init.method.toUpperCase() !== "GET" &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event(RESOURCE_CHANGED_EVENT));
      window.dispatchEvent(new Event("hawlader:dashboard-update"));
    }
    return data as T;
  }
  const response = await fetch("/api/v1" + route, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (
    response.status === 401 &&
    route !== "/auth/login" &&
    typeof window !== "undefined"
  )
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  if (!response.ok)
    throw new ApiError(
      response.status,
      result.error?.message ?? "The server could not complete this request.",
    );
  if (
    init?.method &&
    init.method.toUpperCase() !== "GET" &&
    !route.startsWith("/auth/") &&
    typeof window !== "undefined"
  ) {
    window.dispatchEvent(new Event(RESOURCE_CHANGED_EVENT));
    try {
      localStorage.setItem(RESOURCE_CHANGED_EVENT, randomId());
    } catch {
      // In-tab invalidation works even when browser storage is unavailable.
    }
  }
  return result.data as T;
}
export async function csrf() {
  return (await api<{ token: string }>("/auth/csrf")).token;
}
export async function post<T>(
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return api<T>(route, {
    method: "POST",
    headers: { ...headers, "X-CSRF-Token": await csrf() },
    body: JSON.stringify(body),
  });
}
