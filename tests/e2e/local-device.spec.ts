import { test, expect } from "@playwright/test";

test("retired Google workspace opens password login without contacting Google", async ({
  page,
}) => {
  const googleRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /accounts\.google\.com|script\.google\.com|googleapis\.com/.test(
        request.url(),
      )
    ) {
      googleRequests.push(request.url());
    }
  });
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { message: "Please sign in." } },
    }),
  );
  for (const path of ["/", "/device", "/login"]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Good to see you again." }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Email or login", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Google/ })).toHaveCount(0);
  }
  expect(googleRequests).toEqual([]);
});
