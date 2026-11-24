import { test, expect } from "@playwright/test";

for (const canEdit of [true, false])
  test(`customer history icon ${canEdit ? "opens and saves the customer editor" : "respects customer editing permission"}`, async ({
    page,
  }) => {
    let customer = {
      id: "customer-1",
      version: 1,
      name: "Abu Sayed",
      phone: "01958645425",
      address: "Betagi",
      active: true,
      createdAt: "2026-11-01",
      totalSales: "500.00",
      due: "100.00",
    };
    let fail = false,
      posts = 0;
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1",
        "",
      );
      const data = (value: unknown) => route.fulfill({ json: { data: value } });
      if (path === "/auth/me")
        return data({
          id: "owner",
          name: "Owner",
          login: "owner",
          roles: ["OWNER"],
          permissions: [
            "dashboard.read",
            "sales.manage",
            ...(canEdit ? ["parties.customers"] : []),
          ],
        });
      if (path === "/auth/csrf") return data({ token: "customer-csrf" });
      if (path === "/customers")
        return data({
          items: [customer],
          total: 1,
          page: 1,
          pageSize: 10,
          summary: {},
        });
      if (path === "/customers/customer-1") {
        if (route.request().method() === "POST") {
          posts++;
          if (fail)
            return route.fulfill({
              status: 503,
              json: { error: { message: "Unable to save customer." } },
            });
          const body = route.request().postDataJSON();
          expect(body).toEqual({
            name: "Updated Customer",
            phone: "01712345678",
            address: "Dhaka",
            version: 1,
          });
          customer = { ...customer, ...body, version: 2 };
        }
        return data(customer);
      }
      if (path === "/customers/customer-1/sales")
        return data({
          customer,
          total: 1,
          page: 1,
          pageSize: 50,
          items: [
            {
              id: "sale-1",
              invoiceNumber: "HB-0022",
              soldAt: "2026-11-25",
              status: "CONFIRMED",
              subtotal: "500.00",
              discount: "0.00",
              total: "500.00",
              products: [],
            },
          ],
        });
      return data({});
    });
    await page.goto("/customers");
    await page.getByRole("button", { name: "Abu Sayed", exact: true }).click();
    const history = page.getByRole("dialog", {
      name: "Customer Details",
      exact: true,
    });
    await expect(
      history.getByRole("heading", { name: "HB-0022", exact: true }),
    ).toBeVisible();
    if (!canEdit) {
      await expect(
        history.getByRole("button", { name: "Edit customer", exact: true }),
      ).toHaveCount(0);
      return;
    }
    const icon = history.getByRole("button", {
      name: "Edit customer",
      exact: true,
    });
    await icon.click();
    const editor = page.getByRole("dialog", {
      name: "Edit Customer",
      exact: true,
    });
    await expect(
      editor.getByLabel("Customer name", { exact: true }),
    ).toHaveValue("Abu Sayed");
    await expect(
      editor.getByLabel("Customer mobile number", { exact: true }),
    ).toHaveValue("01958645425");
    await expect(
      editor.getByLabel("Customer address", { exact: true }),
    ).toHaveValue("Betagi");
    const bounds = await editor.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(12);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height - 12,
    );
    await page.screenshot({
      path: test.info().outputPath("customer-editor.png"),
    });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(history).toBeVisible();
    await expect(icon).toBeFocused();
    await page.keyboard.press("Enter");
    await editor
      .getByLabel("Customer name", { exact: true })
      .fill("Updated Customer");
    await editor
      .getByLabel("Customer mobile number", { exact: true })
      .fill("01712345678");
    await editor.getByLabel("Customer address", { exact: true }).fill("Dhaka");
    fail = true;
    await editor
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText("Unable to save");
    await expect(
      editor.getByLabel("Customer name", { exact: true }),
    ).toHaveValue("Updated Customer");
    fail = false;
    await editor
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect(history.locator(".customer-history-name-line")).toContainText(
      "Updated Customer",
    );
    await expect(history.locator(".customer-history-header-phone")).toHaveText(
      "01712345678",
    );
    await expect(
      history.getByRole("heading", { name: "HB-0022", exact: true }),
    ).toBeVisible();
    expect(customer.due).toBe("100.00");
    expect(posts).toBe(2);
    await history
      .getByRole("button", { name: "Close customer details", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Updated Customer", exact: true }),
    ).toBeVisible();
  });
