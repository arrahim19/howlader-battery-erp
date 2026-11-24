import { test, expect } from "@playwright/test";
for (const notes of [
  undefined,
  "Handle with care\nDeliver after 5 PM <b>as text</b>",
  "Long note ".repeat(200),
])
  test(`invoice sale note ${notes === undefined ? "is hidden when absent" : notes.length > 100 ? "wraps long text" : "prints below amount in words"}`, async ({
    page,
  }) => {
    const customer = {
      id: "customer-1",
      name: "Customer One",
      phone: "01700000001",
      address: "Dhaka",
      active: true,
      createdAt: "2026-11-01",
      totalSales: "39500.00",
      due: "4500.00",
    };
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path.endsWith("/auth/me"))
        data = {
          id: "owner",
          name: "Owner",
          login: "owner",
          roles: ["OWNER"],
          permissions: ["dashboard.read", "parties.customers", "sales.manage"],
        };
      else if (path.endsWith("/shop-profile"))
        data = {
          name: "Howlader Battery House",
          address: "Betagi College Road",
          phone: "01799639594",
        };
      else if (path.endsWith("/customers"))
        data = {
          items: [customer],
          total: 1,
          page: 1,
          pageSize: 10,
          summary: {},
        };
      else if (path.endsWith("/sales"))
        data = {
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
              subtotal: "39500.00",
              discount: "0.00",
              total: "39500.00",
              paid: "35000.00",
              due: "4500.00",
              notes,
              products: [
                {
                  id: "line-1",
                  name: "Auto Life",
                  model: "6-EV-220A",
                  quantity: "2",
                  unit: "pcs",
                  unitPrice: "14500.00",
                  amount: "29000.00",
                },
                {
                  id: "line-2",
                  name: "Auto Life",
                  model: "6-EV-200A",
                  quantity: "1",
                  unit: "pcs",
                  unitPrice: "10500.00",
                  amount: "10500.00",
                },
              ],
            },
          ],
        };
      return route.fulfill({ json: { data } });
    });
    await page.goto("/customers");
    await page
      .getByRole("button", { name: customer.name, exact: true })
      .click();
    await page.evaluate(() => {
      window.print = () => {};
    });
    await page
      .getByRole("button", { name: "Print invoice HB-0022", exact: true })
      .click();
    const sheet = page.locator(".sale-invoice-print-sheet");
    await sheet.waitFor({ state: "attached" });
    await page.emulateMedia({ media: "print" });
    const note = sheet.locator(".invoice-note");
    if (notes) {
      await expect(note).toHaveText("NOTE: " + notes.trim());
      await expect(note.locator("b")).toHaveCount(0);
      expect(
        await note.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const words = sheet.locator(".invoice-amount-words > p").first();
      expect((await note.boundingBox())!.y).toBeGreaterThan(
        (await words.boundingBox())!.y,
      );
    } else await expect(note).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("invoice-note.png"),
      fullPage: true,
    });
    const pdf = await page.pdf({
      path: test.info().outputPath("invoice-note.pdf"),
      preferCSSPageSize: true,
      printBackground: true,
    });
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || [])
      .length;
    expect(pages).toBe(notes && notes.length > 100 ? 2 : 1);
  });
