import { test, expect } from "@playwright/test";

for (const multipleInvoices of [false, true]) {
  test(`replacement shows each model once and registers the correct invoice (multiple invoices: ${multipleInvoices})`, async ({
    page,
  }) => {
    let saved = false;
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/auth/me"))
        return route.fulfill({
          json: {
            data: {
              id: "owner",
              name: "Owner",
              login: "owner",
              roles: ["OWNER"],
              permissions: [
                "dashboard.read",
                "replacements.intake.customer",
                "replacements.intake.stock",
                "replacements.resolve",
                "replacements.dispatch",
                "replacements.receive",
                "replacements.deliver",
              ],
            },
          },
        });
      if (url.pathname.endsWith("/auth/csrf"))
        return route.fulfill({ json: { data: { token: "test" } } });
      if (url.pathname.includes("/modules/"))
        return route.fulfill({ json: { data: {} } });
      if (url.pathname.endsWith("/replacements/options")) {
        expect(url.searchParams.get("source")).toBe("CUSTOMER_WARRANTY");
        return route.fulfill({
          json: {
            data: {
              suppliers: [{ id: "supplier-1", name: "Test Supplier" }],
              units: ["HWB-000001", "MODEL-1", "Test Customer"].includes(
                url.searchParams.get("q") ?? "",
              )
                ? [
                    {
                      id: "battery-1",
                      productId: "product-1",
                      saleUnitId: "sale-unit-1",
                      label: "Test Battery · MODEL-1",
                      supplierId: "supplier-1",
                      customer: "Test Customer",
                      invoice: "HWB-000001",
                    },
                    {
                      id: "battery-2",
                      productId: "product-1",
                      saleUnitId: "sale-unit-2",
                      label: "Test Battery · MODEL-1",
                      supplierId: "supplier-1",
                      customer: "Test Customer",
                      invoice: "HWB-000001",
                    },
                    {
                      id: "battery-3",
                      productId: "product-1",
                      saleUnitId: "sale-unit-3",
                      label: "Test Battery · MODEL-1",
                      supplierId: "supplier-1",
                      customer: "Test Customer",
                      invoice: multipleInvoices ? "HWB-000002" : "HWB-000001",
                    },
                  ]
                : [],
            },
          },
        });
      }
      if (
        url.pathname.endsWith("/replacements") &&
        route.request().method() === "POST"
      ) {
        const body = route.request().postDataJSON();
        expect(body).toMatchObject({
          source: "CUSTOMER_WARRANTY",
          unitId: multipleInvoices ? "battery-3" : "battery-1",
          saleUnitId: multipleInvoices ? "sale-unit-3" : "sale-unit-1",
          supplierId: "supplier-1",
          faultReason: multipleInvoices ? "" : "Battery not charging",
          quantity: 2,
        });
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
        saved = true;
        return route.fulfill({
          json: { data: { id: body.id, number: "REP-001" } },
        });
      }
      if (url.pathname.endsWith("/replacements"))
        return route.fulfill({
          json: {
            data: {
              items: saved
                ? [
                    {
                      id: "rep-1",
                      number: "REP-001",
                      status: "FAULTY",
                      version: 1,
                      product: "Test Battery",
                      serial: "BAT-1",
                      customer: "Test Customer",
                      phone: null,
                      invoice: multipleInvoices ? "HWB-000002" : "HWB-000001",
                      supplier: "Test Supplier",
                      createdAt: "2026-11-16T12:00:00Z",
                      sentAt: null,
                    },
                  ]
                : [],
              total: saved ? 1 : 0,
              page: 1,
              pageSize: 10,
              summary: {
                FAULTY: saved ? 1 : 0,
                SENT: 0,
                RECEIVED: 0,
                DELIVERED: 0,
              },
            },
          },
        });
      return route.abort();
    });
    await page.goto("/replacements/new");
    await expect(
      page.getByLabel("Replacement Source", { exact: true }),
    ).toHaveValue("CUSTOMER_WARRANTY");
    const search = page.getByLabel("Customer / Invoice / Model Number", {
      exact: true,
    });
    await search.fill("Missing customer");
    await expect(
      page.getByText("No eligible batteries found for this search."),
    ).toBeVisible();
    await page
      .getByLabel("Customer / Invoice / Model Number", { exact: true })
      .fill(multipleInvoices ? "Test Customer" : "HWB-000001");
    const product = page.getByLabel("Product / Model Number", { exact: false });
    await expect(product.locator("option")).toHaveCount(2);
    await expect(product.locator("option").last()).toHaveText(
      "Test Battery · MODEL-1",
    );
    if (multipleInvoices) {
      const results = page.getByRole("list", {
        name: "Replacement search results",
      });
      await expect(results.getByRole("button")).toHaveCount(2);
      await results.getByRole("button", { name: /HWB-000002/ }).click();
      await expect(results).toBeHidden();
      await expect(product).toHaveValue("product-1");
      const invoice = page.getByLabel("Customer / Invoice", { exact: true });
      await expect(invoice.locator("option")).toHaveCount(3);
      await expect(invoice).toHaveValue("HWB-000002");
    } else await product.selectOption("product-1");
    await expect(page.getByLabel("Supplier", { exact: false })).toHaveValue(
      "supplier-1",
    );
    const reason = page.getByLabel("অভিযোগ / Fault reason", { exact: false });
    await expect(reason).not.toHaveAttribute("required");
    if (!multipleInvoices) await reason.fill("Battery not charging");
    const quantity = page.getByRole("spinbutton", { name: "Qty", exact: true });
    await expect(quantity).toHaveValue("1");
    await quantity.fill("0");
    await expect(
      page.getByRole("button", { name: "Register Replacement" }),
    ).toBeDisabled();
    await quantity.fill("2");
    await page.getByRole("button", { name: "Register Replacement" }).click();
    await expect(page).toHaveURL(/\/replacements$/);
    await expect(
      page.getByRole("combobox", { name: "Status for REP-001" }),
    ).toHaveValue("FAULTY");
  });
}
