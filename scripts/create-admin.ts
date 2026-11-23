import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { hash } from "argon2";
import { DatabaseService } from "../apps/api/src/database.service";
import { passwordOptions } from "../apps/api/src/auth";
import { rolePermissions } from "../apps/api/src/permissions";

async function main() {
  const db = new DatabaseService();
  try {
    const login = (process.env.ERP_ADMIN_LOGIN ?? "owner").trim().toLowerCase();
    if (await db.user.findUnique({ where: { login } })) {
      console.log(
        "Login already exists; password and roles preserved. No records changed.",
      );
      return;
    }
    const production = process.env.NODE_ENV === "production";
    const supplied = process.env.ERP_ADMIN_PASSWORD;
    if (production && !supplied)
      throw new Error(
        "Production requires ERP_ADMIN_PASSWORD from a secure operator environment.",
      );
    const password = supplied ?? randomBytes(18).toString("base64url");
    if (password.length < 6 || password.length > 256)
      throw new Error("Admin password must be 6–256 characters.");
    const passwordHash = await hash(password, passwordOptions);
    await db.$transaction(
      async (tx) => {
        for (const [code, permissions] of Object.entries(rolePermissions)) {
          const role = await tx.role.upsert({
            where: { code },
            update: {},
            create: { code, name: code.replaceAll("_", " ") },
          });
          for (const code of permissions) {
            const permission = await tx.permission.upsert({
              where: { code },
              update: {},
              create: { code, name: code },
            });
            await tx.rolePermission.upsert({
              where: {
                roleId_permissionId: {
                  roleId: role.id,
                  permissionId: permission.id,
                },
              },
              update: {},
              create: { roleId: role.id, permissionId: permission.id },
            });
          }
        }
        const owner = await tx.role.findUniqueOrThrow({
          where: { code: "OWNER" },
        });
        const user = await tx.user.create({
          data: {
            login,
            name: process.env.ERP_ADMIN_NAME ?? "Shop Owner",
            passwordHash,
            roles: { create: { roleId: owner.id } },
          },
        });
        await tx.applicationSetting.create({
          data: {
            key: "shop",
            value: {
              name: "Hawlader Battery House",
              currency: "BDT",
              timezone: "Asia/Dhaka",
              address: "",
              phone: "",
            },
            changedById: user.id,
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
          await tx.account.upsert({
            where: { code },
            update: {},
            create: { code, name, kind, paymentMethod },
          });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: "ADMIN_BOOTSTRAP",
            resourceType: "User",
            resourceId: user.id,
            requestId: randomUUID(),
            reason: "Operator-created initial administrator",
          },
        });
      },
      { timeout: 120_000 },
    );
    if (!production && !supplied) {
      await mkdir(".local", { recursive: true });
      await writeFile(
        ".local/admin-credentials.txt",
        `Local development only\nLogin: ${login}\nPassword: ${password}\n`,
        { mode: 0o600, flag: "wx" },
      );
      console.log(
        "Initial owner created. Random login credentials saved in ignored .local/admin-credentials.txt. No business records seeded.",
      );
    } else
      console.log(
        "Initial owner created with supplied password. No business records seeded.",
      );
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Admin setup failed");
  process.exitCode = 1;
});
