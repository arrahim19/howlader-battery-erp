import "reflect-metadata";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseService } from "../apps/api/src/database.service";
import { settings } from "../apps/api/src/config";
import { provisionShop } from "../apps/api/src/shop-provisioning";
import { rolePermissions } from "../apps/api/src/permissions";
import { hashPassword } from "../apps/api/src/auth";

type Identity = {
  id: string;
  name: string;
  login: string;
  email: string | null;
  emailVerifiedAt: string | null;
  passwordHash: string;
  active: boolean;
};
type Source = {
  shop: { name: string; branchName: string; schemaName: string };
  users: Identity[];
};
async function main() {
  const db = new DatabaseService();
  const file = process.argv[2];
  try {
    let sources: Source[] = [];
    try {
      sources = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let generatedPassword: string | null = null;
    if (!sources.length && !(await db.global.user.count())) {
      generatedPassword = randomBytes(18).toString("base64url");
      sources = [
        {
          shop: {
            name: "Howlader Battery House",
            branchName: "Betagi",
            schemaName: "public",
          },
          users: [
            {
              id: randomUUID(),
              name: "Shop Owner",
              login: "owner",
              email: null,
              emailVerifiedAt: null,
              passwordHash: await hashPassword(generatedPassword),
              active: true,
            },
          ],
        },
      ];
    }
    for (const source of sources) {
      let client = db.global;
      if (source.shop.schemaName !== "public") {
        const existing = await db.global.shop.findUnique({
          where: { branchName: source.shop.branchName },
        });
        if (existing) client = db.forSchema(existing.schemaName);
        else {
          const user = source.users.find((user) => user.email);
          if (!user?.email)
            throw new Error("Shop owner email required for account transfer.");
          const shop = await provisionShop({
            connectionString: settings().databaseUrl,
            name: source.shop.name,
            branchName: source.shop.branchName,
            email: user.email,
            userName: user.name,
          });
          client = db.forSchema(shop.schemaName);
        }
      } else {
        await db.global.shop.update({
          where: { schemaName: "public" },
          data: { name: source.shop.name, branchName: source.shop.branchName },
        });
      }
      const owner = await client.role.upsert({
        where: { code: "OWNER" },
        update: {},
        create: { code: "OWNER", name: "Owner" },
      });
      for (const code of rolePermissions.OWNER) {
        const permission = await client.permission.upsert({
          where: { code },
          update: {},
          create: { code, name: code },
        });
        await client.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: owner.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: owner.id, permissionId: permission.id },
        });
      }
      for (const identity of source.users) {
        const { id, emailVerifiedAt, ...fields } = identity;
        const account = {
          ...fields,
          emailVerifiedAt: emailVerifiedAt ? new Date(emailVerifiedAt) : null,
        };
        await client.user.upsert({
          where: { login: identity.login },
          update: account,
          create: { id, ...account, roles: { create: { roleId: owner.id } } },
        });
      }
      const first = source.users[0]
        ? await client.user.findUnique({
            where: { login: source.users[0].login },
          })
        : null;
      if (first)
        await client.applicationSetting.upsert({
          where: { key: "shop" },
          update: {},
          create: {
            key: "shop",
            value: {
              name: source.shop.name,
              address: "",
              phone: "",
              currency: "BDT",
              timezone: "Asia/Dhaka",
            },
            changedById: first.id,
          },
        });
      for (const [code, name, kind, paymentMethod] of [
        ["1100", "Cash on hand", "ASSET", "CASH"],
        ["1110", "bKash", "ASSET", "BKASH"],
        ["1120", "Nagad", "ASSET", "NAGAD"],
        ["1130", "Bank", "ASSET", "BANK_TRANSFER"],
        ["1140", "Other collections", "ASSET", "OTHER"],
        ["1200", "Customer receivables", "ASSET", null],
        ["1300", "Inventory", "ASSET", null],
        ["2100", "Supplier payables", "LIABILITY", null],
        ["2200", "Customer advances", "LIABILITY", null],
        ["4100", "Net sales revenue", "REVENUE", null],
        ["5100", "Cost of goods sold", "EXPENSE", null],
        ["6100", "Operating expenses", "EXPENSE", null],
      ] as const)
        await client.account.upsert({
          where: { code },
          update: {},
          create: { code, name, kind, paymentMethod },
        });
    }
    if (generatedPassword)
      await writeFile(
        ".local/drive-server/owner-login.txt",
        `Login: owner\nPassword: ${generatedPassword}\n`,
        { mode: 0o600, flag: "wx" },
      );
    const owner = await db.global.user.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (owner && !process.env.BACKUP_OWNER_USER_ID) {
      const env = await readFile(".env", "utf8");
      await writeFile(
        ".env",
        env.replace(
          /^BACKUP_OWNER_USER_ID=.*$/m,
          `BACKUP_OWNER_USER_ID="${owner.id}"`,
        ),
        { mode: 0o600 },
      );
    }
    console.log(
      "Shop login accounts and zero-balance accounting definitions ready.",
    );
    if (file) await rm(file, { force: true });
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(
    "Local account setup failed.",
    error instanceof Error
      ? error.message
          .replace(/postgres(?:ql)?:\/\/\S+/g, "[connection redacted]")
          .slice(-500)
      : "Unknown error",
    "Account transfer file retained privately for retry; no business data copied.",
  );
  process.exitCode = 1;
});
