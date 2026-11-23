import { test, expect, type Page, type Route } from "@playwright/test";
import { openApp, ids } from "./fixtures/mobile";

const typeId = "00000000-0000-4000-8000-000000000001";
const type = { id: typeId, name: "Battery", trackingKind: "BATTERY_UNIT" };
async function features(page: Page) {
  let user: Record<string, unknown> = {};
  const base = await openApp(page, false, (path, data) => {
    if (path === "/auth/me") user = data as Record<string, unknown>;
  });
  const calls: { path: string; body: Record<string, unknown>; key?: string }[] =
    [];
  let shop = {
    value: {
      name: "Howlader Battery House",
      address: "Mirzaganj",
      phone: "01700000001",
    },
    version: 1,
  };
  const customers = [
    {
      id: ids.customer,
      name: "Customer One",
      phone: "01700000001",
      address: "Mirzaganj",
      active: true,
      createdAt: "2026-11-21",
      totalSales: "0.00",
      due: "0.00",
    },
  ];
  const suppliers = [
    {
      id: "supplier-1",
      name: "Supplier One",
      company: "Battery Company",
      phone: "01800000001",
      productTypeId: typeId,
      productType: type,
      active: true,
      createdAt: "2026-11-21",
    },
  ];
  const expenses: Record<string, unknown>[] = [];
  const handler = async (route: Route): Promise<void> => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/api/v1", "");
    const data = (value: unknown) =>
      route.fulfill({
        json: { data: value },
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    if (req.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type,Authorization,Idempotency-Key",
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        },
      });
    if (path === "/mobile/offline-bootstrap") {
      const original = (await base.fixture(path)) as {
        views: Record<string, unknown>;
      };
      const views = { ...original.views };
      for (const path of [
        "/auth/me",
        "/shop-profile",
        "/settings/shop",
        "/auth/account",
        "/users",
        "/customers",
        "/suppliers",
        "/suppliers/product-types",
        "/suppliers/ledger",
        "/expenses/options",
        "/expenses",
        "/recycle-bin",
        "/purchases/recent",
        "/purchases/options",
        "/replacements/options?source=CUSTOMER_WARRANTY",
        "/replacements/options?source=BEFORE_SALE",
        "/replacements",
      ])
        views[path] = await fixture(path);
      const catalog = views["/catalog"] as { types: unknown[] };
      catalog.types = [type];
      const products = views["/products"] as {
        items: Record<string, unknown>[];
      };
      products.items = products.items.map((p) => ({ ...p, type }));
      const salesOptions = views["/sales/options"] as { types: unknown[] };
      salesOptions.types = [type];
      return data({ views, at: new Date().toISOString(), version: 1 });
    }
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      calls.push({ path, body, key: req.headers()["idempotency-key"] });
      if (path === "/customers") {
        const record = { ...customers[0], ...body, id: "customer-2" };
        customers.push(record);
        return data(record);
      }
      if (path === "/suppliers") {
        suppliers.push({ ...suppliers[0], ...body, id: "supplier-2" });
        return data(suppliers.at(-1));
      }
      if (path === "/expenses") {
        const record = { ...body, id: "expense-1", createdAt: "2026-11-21" };
        expenses.push(record);
        return data(record);
      }
      if (path === "/settings/shop") {
        shop = {
          value: { name: body.name, address: body.address, phone: body.phone },
          version: shop.version + 1,
        };
        return data(shop);
      }
      if (path === `/users/${user.id}/profile`) {
        user = { ...user, name: body.name };
        return data({ id: user.id, name: user.name, version: 2 });
      }
      if (path === "/auth/email/request-verification")
        return data({ message: "Verification email sent." });
      if (path === "/auth/change-password")
        return data({ message: "Password changed." });
      if (path === "/purchases/receive")
        return data({
          id: "purchase-1",
          number: "PUR-001",
          receiptId: "receipt-1",
          status: "RECEIVED",
          total: "300.00",
          quantity: 2,
        });
      if (path === "/replacements")
        return data({ id: body.id, number: "REP-001" });
      return route.fallback();
    }
    if (path === "/auth/me") return data(user);
    if (path === "/shop-profile") return data(shop.value);
    if (path === "/settings/shop") return data(shop);
    if (path === "/auth/account")
      return data({ email: "rahim.mugnee@gmail.com", mailConfigured: true });
    if (path === "/users")
      return data([
        {
          ...user,
          active: true,
          version: 1,
          roles: [{ role: { code: "OWNER", name: "Owner" } }],
        },
      ]);
    if (path === "/customers")
      return data({
        items: customers,
        total: customers.length,
        page: 1,
        pageSize: 100,
        summary: {
          total: customers.length,
          active: customers.length,
          credit: 0,
          totalSales: "0",
          totalDue: "0",
        },
      });
    if (path === "/suppliers/product-types") return data([type]);
    if (path === "/suppliers")
      return data({
        items: suppliers,
        total: suppliers.length,
        page: 1,
        pageSize: 100,
      });
    if (path === "/suppliers/ledger")
      return data({
        items: [],
        total: 0,
        page: 1,
        pageSize: 100,
        summary: { totalPurchases: "0", totalDue: "0" },
      });
    if (path === "/expenses/options")
      return data({
        categories: ["Office Expense", "Transport", "Others"],
        cashAvailable: true,
        paymentAccounts: [
          { id: ids.account, name: "Cash", paymentMethod: "CASH" },
        ],
      });
    if (path === "/expenses")
      return data({
        items: expenses,
        total: expenses.length,
        page: 1,
        pageSize: 100,
        summary: {
          total: expenses.length ? "75.25" : "0",
          byCategory: expenses.length
            ? [{ name: "Office Expense", amount: "75.25" }]
            : [],
        },
      });
    if (path === "/recycle-bin") return data([]);
    if (path === "/purchases/recent") return data({ items: [] });
    if (path === "/purchases/options")
      return data({
        types: [type],
        productNames: [{ id: "name-1", name: "Battery A", typeId }],
        products: [
          {
            id: ids.product,
            name: "Battery A",
            model: "Model M",
            unit: "pcs",
            warrantyMonths: 6,
            type,
          },
        ],
        suppliers: [
          {
            id: "supplier-1",
            name: "Supplier One",
            company: "Battery Company",
            productTypeId: typeId,
          },
        ],
        paymentAccounts: [
          { id: ids.account, name: "Cash", paymentMethod: "CASH" },
        ],
      });
    if (path === "/replacements/options")
      return data({
        suppliers: [{ id: "supplier-1", name: "Supplier One" }],
        units: [
          {
            id: "battery-1",
            productId: ids.product,
            saleUnitId: "sale-unit-1",
            label: "Battery A · Model M",
            supplierId: "supplier-1",
            customer: "Customer One",
            invoice: "HB-0001",
          },
        ],
      });
    if (path === "/replacements")
      return data({
        items: [],
        total: 0,
        page: 1,
        pageSize: 100,
        summary: { FAULTY: 0, SENT: 0, RECEIVED: 0, DELIVERED: 0 },
      });
    return route.fallback();
  };
  const fixture = async (path: string): Promise<unknown> => {
    let value: unknown;
    await handler({
      request: () => ({
        url: () => "https://erp.test/api/v1" + path,
        method: () => "GET",
        headers: () => ({}),
      }),
      fulfill: async (response: { json: { data: unknown } }) => {
        value = response.json.data;
      },
      fallback: async () => {
        value = await base.fixture(path);
      },
    } as unknown as Route);
    return value;
  };
  await page.route("**/api/v1/**", handler);
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sync & local data" }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(
    page.getByText("All saved transactions have reached the server.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Dashboard", exact: true })
    .last()
    .click();
  // Use the real in-app menu: page.goto would discard the preview's in-memory login.
  const menu = async (label: string) => {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: label, exact: true })
      .click();
  };
  return { calls, menu };
}

test("all mobile modules open with the persistent shell and no runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { menu } = await features(page);
  for (const [label, heading] of [
    ["Purchase", "Purchase"],
    ["Customers", "Customers"],
    ["Suppliers", "Suppliers"],
    ["Replacement", "Replacement / Warranty"],
    ["Accounts & Expenses", "Accounts & Expenses"],
    ["Users & Permissions", "Users & Permissions"],
    ["Settings", "Settings"],
    ["Recycle Bin", "Recycle Bin"],
  ]) {
    await menu(label);
    await expect(
      page.getByRole("heading", { name: heading, level: 1, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".mobile-quick-access")).toHaveCount(1);
  }
  expect(errors).toEqual([]);
});

test("mobile customer and supplier forms validate and save through the native API bridge", async ({
  page,
}) => {
  const { menu, calls } = await features(page);
  await menu("Customers");
  await page.getByRole("link", { name: "Add Customer", exact: true }).click();
  await page
    .getByLabel("Customer name", { exact: true })
    .fill("Mobile Customer");
  await page.getByLabel("Customer mobile number").fill("01712345678");
  await page.getByLabel("Customer address").fill("Betagi");
  await page
    .getByRole("button", { name: "Save Customer", exact: true })
    .click();
  await expect
    .poll(() => calls.some((c) => c.path === "/customers"))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Mobile Customer", exact: true }),
  ).toBeVisible();
  await menu("Suppliers");
  await page.getByRole("link", { name: "Add Supplier", exact: true }).click();
  await page.getByLabel("Supplier product category").selectOption(typeId);
  await page
    .getByLabel("Supplier name", { exact: true })
    .fill("Mobile Supplier");
  await page.getByLabel("Supplier mobile number").fill("01812345678");
  await page.getByLabel("Supplier company or brand").fill("Battery Company");
  await page.getByRole("button", { name: /Save Supplier|সংরক্ষণ/ }).click();
  await expect
    .poll(() => calls.some((c) => c.path === "/suppliers"))
    .toBe(true);
});

test("mobile purchase and expense transactions use durable idempotency keys", async ({
  page,
}) => {
  const { menu, calls } = await features(page);
  await page.getByRole("link", { name: "New Purchase", exact: true }).click();
  await page.getByLabel("Purchase product type").selectOption(typeId);
  await page
    .getByLabel("Purchase supplier", { exact: true })
    .selectOption("supplier-1");
  await page
    .getByLabel("Purchase product", { exact: true })
    .selectOption("Battery A");
  await page.getByLabel("Purchase product model number").fill("Model M");
  await page.getByLabel("Purchase product warranty").fill("6");
  await page.getByLabel("Purchase quantity", { exact: true }).fill("2");
  await page.getByLabel("Unit purchase price", { exact: true }).fill("150.00");
  await page.getByLabel("Invoice / Challan No.").fill("MOBILE-001");
  await page.getByLabel("Purchase transport amount").fill("0");
  await page
    .getByRole("button", { name: "Confirm Purchase", exact: true })
    .click();
  await expect
    .poll(() => calls.some((c) => c.path === "/purchases/receive"))
    .toBe(true);
  const purchase = calls.find((c) => c.path === "/purchases/receive")!;
  expect(purchase.key).toMatch(/^[a-f0-9-]{36}$/);
  expect(purchase.body).toMatchObject({
    supplierId: "supplier-1",
    reference: "MOBILE-001",
    items: [{ productId: ids.product, quantity: 2, unitPrice: "150.00" }],
  });
  await menu("Accounts & Expenses");
  await page.getByRole("button", { name: "Add Expense", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Expense", exact: true });
  await dialog.getByLabel("Expense category").selectOption("Office Expense");
  await dialog.getByLabel("Expense amount").fill("75.25");
  await dialog
    .getByRole("button", { name: "Save Expense", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => calls.find((c) => c.path === "/expenses")?.key || "")
    .toMatch(/^[a-f0-9-]{36}$/);
  const expense = calls.find((c) => c.path === "/expenses")!;
  expect(expense.key).toMatch(/^[a-f0-9-]{36}$/);
  expect(expense.body.amount).toBe("75.25");
});

test("mobile settings, own profile, email and password forms work", async ({
  page,
}) => {
  const { menu, calls } = await features(page);
  await menu("Settings");
  await page
    .getByLabel("Shop name", { exact: true })
    .fill("Howlader Mobile Test");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("saved");
  await menu("Users & Permissions");
  await page
    .getByRole("button", { name: "Edit Rahim Mugnee", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Rahim Updated");
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Name updated." }),
  ).toBeVisible();
  await dialog.getByLabel("Email address").fill("new-account@example.com");
  await dialog.getByLabel("Password to confirm email change").fill("739152");
  await dialog
    .getByRole("button", { name: "Send verification email", exact: true })
    .click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "Verification email sent." }),
  ).toBeVisible();
  await dialog.getByLabel("Current password", { exact: true }).fill("739152");
  await dialog.getByLabel("New password", { exact: true }).fill("123456");
  await dialog
    .getByLabel("Confirm new password", { exact: true })
    .fill("654321");
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("do not match");
  expect(calls.some((c) => c.path === "/auth/change-password")).toBe(false);
  await dialog
    .getByLabel("Confirm new password", { exact: true })
    .fill("123456");
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login/);
  expect(
    calls.find((c) => c.path === "/auth/change-password")?.body,
  ).toMatchObject({ currentPassword: "739152", newPassword: "123456" });
});

test("native forgot password uses the anonymous recovery endpoint", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/mobile/forgot-password", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
      });
    expect(route.request().postDataJSON()).toEqual({
      email: "recovery@example.com",
    });
    return route.fulfill({
      json: {
        data: {
          message:
            "If this email is linked to an active account, a password reset link will be sent.",
        },
      },
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.goto("http://localhost:8081/login");
  await page
    .getByRole("link", { name: "Forgot password?", exact: true })
    .click();
  await page
    .getByLabel("Email address", { exact: true })
    .fill("recovery@example.com");
  await page.getByRole("button", { name: /Send reset link/ }).click();
  await expect(page.getByRole("status")).toContainText("password reset link");
});

test("a server-rejected offline transaction shows the real error and remains reviewable without a fake invoice", async ({
  page,
}) => {
  await openApp(page, false);
  let attempts = 0;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,Idempotency-Key",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };
  await page.route("**/api/v1/sales/complete", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    attempts++;
    return route.fulfill({
      status: 409,
      headers: cors,
      json: { error: { message: "Insufficient stock for this sale." } },
    });
  });
  await page.getByRole("link", { name: "New Sale", exact: true }).click();
  await page.getByLabel("Select customer").selectOption(ids.customer);
  await page.getByLabel("Sales product category").selectOption("battery");
  await page
    .getByLabel("Sales product", { exact: true })
    .selectOption(ids.product);
  await page.getByLabel("Sales quantity").fill("1");
  await page.getByRole("button", { name: "Confirm Sale", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Insufficient stock");
  await expect(page.getByRole("alert")).not.toContainText(
    "Waiting for server confirmation",
  );
  await page.getByRole("button", { name: /need review.*Sync/ }).click();
  await expect(
    page.getByRole("heading", { name: "Needs review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("All saved transactions have reached the server.", {
      exact: true,
    }),
  ).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Remove rejected entry", exact: true })
    .click();
  await expect(
    page.getByText("All saved transactions have reached the server.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(attempts).toBe(1);
});

test("an expired cloud session preserves local work and asks for online sign-in to sync", async ({
  page,
}) => {
  await openApp(page, false);
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { message: "Please sign in." } },
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sync & local data" }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(/Local work is available/)).toBeVisible();
  await page
    .getByRole("navigation", { name: "Quick access" })
    .getByRole("link", { name: "Inventory", exact: true })
    .click();
  await expect(
    page.getByText("Battery A", { exact: true }).first(),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/\/login$/);
});
