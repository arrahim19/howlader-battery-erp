import { expect, type Page, type Route } from "@playwright/test";

export const appURL = process.env.MOBILE_PREVIEW_URL ?? "http://localhost:8081";
const token = "ab".repeat(32);
export const ids = {
  customer: "e2e-customer",
  product: "e2e-product",
  account: "e2e-cash",
};
export async function openApp(
  page: Page,
  failFirstPost = true,
  onData?: (path: string, data: unknown) => void,
  beforeLogin?: () => Promise<void>,
) {
  const requests: {
    path: string;
    body: Record<string, unknown>;
    key?: string;
  }[] = [];
  let saved = false;
  let failed = false;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,Idempotency-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
  const handle = async (route: Route): Promise<void> => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    const fulfill = (data: unknown) => {
      onData?.(path, data);
      return route.fulfill({ headers: cors, json: { data } });
    };
    if (path === "/mobile/offline-bootstrap") {
      const views: Record<string, unknown> = {};
      for (const route of [
        "/auth/me",
        "/dashboard",
        "/catalog",
        "/products",
        "/customers",
        "/suppliers",
        "/sales",
        "/purchases",
        "/sales/options",
        "/purchases/options",
        "/expenses",
        "/expenses/options",
        "/purchases/recent",
        "/shop-profile",
      ])
        views[route] = await fixture(route);
      const options = views["/sales/options"] as {
        customers: Record<string, unknown>[];
        products: Record<string, unknown>[];
      };
      if (!(views["/customers"] as { items: unknown[] }).items.length)
        views["/customers"] = {
          items: options.customers.map((c) => ({
            ...c,
            address: "Mirzaganj",
            active: true,
            due: "0.00",
            totalSales: "0.00",
          })),
          total: options.customers.length,
        };
      views["/mobile/facts"] = {
        batches: [
          {
            id: "test-batch",
            productId: ids.product,
            date: "2020-01-01",
            quantity: 12,
            unitCost: "100.00",
            unitIds: [],
          },
        ],
        cash: [],
      };
      return fulfill({ views, at: new Date().toISOString(), version: 1 });
    }
    if (path === "/auth/mobile/login") {
      expect(route.request().postDataJSON()).toEqual({
        login: "rahim.mugnee@gmail.com",
        password: "739152",
      });
      return fulfill({ accessToken: token, expiresAt: "2099-01-01T00:00:00Z" });
    }
    expect(route.request().headers().authorization).toBe("Bearer " + token);
    if (path === "/auth/me")
      return fulfill({
        id: "mobile-owner",
        name: "Rahim Mugnee",
        login: "rahim.mugnee@gmail.com",
        roles: ["OWNER"],
        permissions: [
          "dashboard.read",
          "sales.manage",
          "inventory.read",
          "parties.customers",
          "payments.customer",
          "finance.read",
          "finance.write",
          "purchases.manage",
          "settings.manage",
          "access.manage",
          "parties.suppliers",
          "catalog.write",
          "inventory.receive",
          "replacements.intake.customer",
          "replacements.intake.stock",
          "replacements.resolve",
          "replacements.dispatch",
          "replacements.receive",
          "replacements.deliver",
          "transactions.reverse",
        ],
        shop: {
          id: "mirzaganj",
          name: "Hawlader Battery House",
          branchName: "Mirzaganj",
        },
      });
    if (path === "/dashboard")
      return fulfill({
        businessDate: "2026-11-21",
        from: "2026-11-21",
        to: "2026-11-21",
        counts: {
          products: 1,
          customers: 1,
          availableStock: "12",
          pendingReplacements: 0,
          sentToCompany: 0,
          replacementsReceived: 0,
          lowStock: 0,
        },
        financials: {
          todaySales: "0.00",
          todayPurchases: "0.00",
          customerDues: "0.00",
          supplierDues: "0.00",
          todayCashReceived: "0.00",
          grossProfit: "0.00",
          availableStockPurchaseValue: "0.00",
        },
        recentSales: [],
        lowStock: [],
        salesTrend: [],
      });
    if (path === "/sales/options")
      return fulfill({
        types: [
          { id: "battery", name: "Battery", trackingKind: "BATTERY_UNIT" },
        ],
        products: [
          {
            id: ids.product,
            name: "Battery A",
            model: "Model M",
            unit: "piece",
            type: {
              id: "battery",
              name: "Battery",
              trackingKind: "BATTERY_UNIT",
            },
            defaultSellingPrice: "150.00",
            availableQuantity: "12",
          },
        ],
        customers: [
          { id: ids.customer, name: "Customer One", phone: "01700000001" },
        ],
        paymentAccounts: [
          { id: ids.account, name: "Cash", paymentMethod: "CASH" },
        ],
      });
    if (path === "/sales/complete") {
      requests.push({
        path,
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"],
      });
      if (failFirstPost && !failed) {
        failed = true;
        return route.fulfill({
          status: 503,
          headers: cors,
          json: {
            error: {
              message: "Temporary network problem. Retry this transaction.",
            },
          },
        });
      }
      saved = true;
      return fulfill({
        id: "saved-sale",
        invoiceNumber: "HB-0001",
        customerId: ids.customer,
        subtotal: "300.00",
        total: "300.00",
        paid: "100.00",
        due: "200.00",
        quantity: 2,
      });
    }
    if (path === "/sales")
      return fulfill({
        items: saved
          ? [
              {
                id: "saved-sale",
                invoiceNumber: "HB-0001",
                customer: {
                  id: ids.customer,
                  name: "Customer One",
                  phone: "01700000001",
                },
                saleDate: "2026-11-21",
                status: "CONFIRMED",
                subtotal: "300.00",
                total: "300.00",
                paid: "100.00",
                due: "200.00",
                quantity: "2",
                itemCount: 1,
              },
            ]
          : [],
        total: saved ? 1 : 0,
        page: 1,
        pageSize: 20,
      });
    if (path === "/catalog")
      return fulfill({
        types: [
          { id: "battery", name: "Battery", trackingKind: "BATTERY_UNIT" },
        ],
        categories: [],
        brands: [],
        units: [],
      });
    if (path === "/shop-profile")
      return fulfill({
        name: "Howlader Battery House",
        address: "Mirzaganj",
        phone: "01700000001",
      });
    if (path.startsWith("/modules/")) return fulfill({ status: "active" });
    if (path === "/products")
      return fulfill({
        items: [
          {
            id: ids.product,
            name: "Battery A",
            model: "Model M",
            unit: "piece",
            active: true,
            type: {
              id: "battery",
              name: "Battery",
              trackingKind: "BATTERY_UNIT",
            },
            brand: null,
            category: null,
            defaultSellingPrice: "150.00",
            lowStockThreshold: "0",
            warrantyMonths: 0,
            stock: {
              total: "12",
              available: "12",
              replaceable: "0",
              reserved: "0",
              sentToCompany: "0",
            },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    return fulfill({ items: [], total: 0, page: 1, pageSize: 20 });
  };
  const fixture = async (path: string): Promise<unknown> => {
    let value: unknown;
    await handle({
      request: () => ({
        url: () => "https://erp.test/api/v1" + path,
        method: () => "GET",
        headers: () => ({ authorization: "Bearer " + token }),
      }),
      fulfill: async (response: { json: { data: unknown } }) => {
        value = response.json.data;
      },
    } as unknown as Route);
    return value;
  };
  await page.route("**/api/v1/**", handle);
  await page.goto(appURL + "/login", { timeout: 120000 });
  await page.getByText("Server connection", { exact: true }).click();
  await page
    .getByLabel("Website address", { exact: true })
    .fill("https://erp.test");
  await page
    .getByLabel("Email or login", { exact: true })
    .fill("rahim.mugnee@gmail.com");
  await page.getByLabel("Password", { exact: true }).fill("739152");
  await beforeLogin?.();
  await page
    .getByRole("button", { name: "Sign in to workspace", exact: true })
    .click();
  await expect(page.locator(".dashboard-intro")).toContainText("Rahim Mugnee");
  return Object.assign(requests, { fixture });
}
