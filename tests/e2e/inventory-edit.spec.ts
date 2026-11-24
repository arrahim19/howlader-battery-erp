import { test, expect } from "@playwright/test";

test("inventory rows edit product details, preserve stock, and keep failed changes reviewable", async ({
  page,
}) => {
  const type = { id: "type-1", name: "Battery", trackingKind: "BATTERY_UNIT" };
  const category = {
    id: "name-1",
    name: "Auto Life",
    typeIds: [type.id],
    productCount: 1,
  };
  let product = {
    id: "product-1",
    version: 1,
    name: "Auto Life",
    model: "200",
    unit: "pcs",
    unitEditable: false,
    active: true,
    type,
    category,
    brand: null,
    defaultSellingPrice: "11000.00",
    latestPurchasePrice: "10500.00",
    lowStockThreshold: "0",
    warrantyMonths: 6,
    capacityAh: "200",
    voltage: null,
    specifications: null,
    stock: {
      total: "13",
      available: "13",
      replaceable: "0",
      reserved: "0",
      sentToCompany: "0",
    },
  };
  let saves = 0;
  let conflict = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const data = (value: unknown) => route.fulfill({ json: { data: value } });
    if (path === "/auth/me")
      return data({
        id: "owner",
        name: "Owner",
        login: "owner",
        roles: ["OWNER"],
        permissions: [
          "dashboard.read",
          "catalog.read",
          "catalog.write",
          "inventory.read",
        ],
      });
    if (path === "/auth/csrf") return data({ token: "test-csrf" });
    if (path === "/catalog")
      return data({
        types: [type],
        categories: [category],
        brands: [],
        totalProducts: 1,
      });
    if (path === "/products")
      return data({ items: [product], total: 1, page: 1, pageSize: 10 });
    if (path === "/products/product-1") {
      if (route.request().method() === "POST") {
        saves++;
        if (conflict)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                message:
                  "Product changed. Reload the product before saving again.",
              },
            },
          });
        const body = route.request().postDataJSON();
        expect(body).toEqual({
          version: 1,
          name: "Auto Life",
          model: "220",
          unit: "pcs",
          defaultSellingPrice: "12500.50",
          warrantyMonths: 12,
        });
        product = { ...product, ...body, version: 2 };
      }
      return data(product);
    }
    return data({});
  });
  await page.goto("/inventory");
  await page
    .getByRole("row")
    .filter({ hasText: "Auto Life" })
    .getByRole("cell", { name: "200", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit Product" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Model")).toHaveValue("200");
  const bounds = await dialog.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(12);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height - 12,
  );
  await page.screenshot({ path: test.info().outputPath("product-editor.png") });
  await dialog.getByLabel("Model").fill("220");
  await expect(dialog.getByLabel("Unit", { exact: false })).toHaveAttribute(
    "readonly",
    "",
  );
  await dialog.getByLabel("Default selling price").fill("12500.50");
  await dialog.getByLabel("Warranty (months)").fill("12");
  conflict = true;
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Product changed");
  await expect(dialog.getByLabel("Model")).toHaveValue("220");
  conflict = false;
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "Auto Life" });
  await expect(
    row.getByRole("cell", { name: "220", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("cell", { name: "13", exact: true }),
  ).toBeVisible();
  expect(product.latestPurchasePrice).toBe("10500.00");
  await row.getByRole("button", { name: "Edit Auto Life 220" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Model")).toHaveValue("220");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(saves).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("inventory-edited.png"),
  });
});

test("inventory readers cannot open the product editor", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const type = { id: "type-1", name: "Parts", trackingKind: "QUANTITY" };
    let data: unknown = {};
    if (path.endsWith("/auth/me"))
      data = {
        id: "reader",
        name: "Reader",
        login: "reader",
        roles: ["SALES_STAFF"],
        permissions: ["catalog.read", "inventory.read"],
      };
    if (path.endsWith("/catalog"))
      data = { types: [type], categories: [], brands: [], totalProducts: 1 };
    if (path.endsWith("/products"))
      data = {
        items: [
          {
            id: "product-1",
            name: "Motor",
            model: "",
            unit: "pcs",
            type,
            warrantyMonths: 0,
            stock: { total: "5" },
            latestPurchasePrice: "100.00",
          },
        ],
        total: 1,
      };
    return route.fulfill({ json: { data } });
  });
  await page.goto("/inventory");
  await page.getByText("Motor", { exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Edit Motor/ })).toHaveCount(0);
});
