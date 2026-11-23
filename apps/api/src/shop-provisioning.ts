import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { hashPassword } from "./auth";
import { rolePermissions } from "./permissions";

// The registry belongs to public; every other historical migration runs per shop.
const sharedMigrations = new Set(["202611210001_shop_registry"]);
const migrationsDirectory = path.resolve(
  __dirname,
  "../../../packages/database/prisma/migrations",
);
export function shopIdentifier(schema: string) {
  if (schema !== "public" && !/^shop_[a-f0-9]{32}$/.test(schema))
    throw new Error("Invalid shop schema.");
  return `"${schema}"`;
}

async function applyShopMigrations(client: pg.Client, schema: string) {
  const identifier = shopIdentifier(schema);
  await client.query(`SET LOCAL search_path TO ${identifier}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${identifier}."_shop_migrations" ("name" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  );
  const applied = await client.query<{ name: string; checksum: string }>(
    `SELECT "name", "checksum" FROM ${identifier}."_shop_migrations"`,
  );
  const checksums = new Map(
    applied.rows.map((row) => [row.name, row.checksum]),
  );
  for (const migration of (
    await readdir(migrationsDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    if (sharedMigrations.has(migration)) continue;
    const sql = (
      await readFile(
        path.join(migrationsDirectory, migration, "migration.sql"),
        "utf8",
      )
    ).replace(/\r\n/g, "\n");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (checksums.has(migration)) {
      if (checksums.get(migration) !== checksum)
        throw new Error(`Applied shop migration was modified: ${migration}`);
      continue;
    }
    // Historical files wrap themselves in BEGIN/COMMIT. The provisioning runner
    // owns the transaction; nested COMMIT would reset SET LOCAL search_path.
    const statements = sql.replace(
      /^[\t ]*(?:BEGIN|COMMIT)[\t ]*;[\t ]*\r?$/gm,
      "",
    );
    await client.query(statements);
    // Reproduce each file's commit-time checks and temporary-table cleanup,
    // without committing the containing provisioning transaction.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const temporary = await client.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind IN ('r','p')",
    );
    for (const table of temporary.rows) {
      await client.query(
        `DROP TABLE pg_temp."${table.relname.replaceAll('"', '""')}"`,
      );
    }
    const scope = await client.query<{ schema: string }>(
      'SELECT current_schema() AS "schema"',
    );
    if (scope.rows[0]?.schema !== schema)
      throw new Error("Shop migration changed the active schema.");
    await client.query(
      `INSERT INTO ${identifier}."_shop_migrations" ("name", "checksum") VALUES ($1,$2)`,
      [migration, checksum],
    );
  }
}

export async function migrateShopDatabases(connectionString: string) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 30000,
  });
  await client.connect();
  try {
    const shops = await client.query<{ schemaName: string }>(
      'SELECT "schemaName" FROM public."Shop" WHERE "schemaName"<>$1',
      ["public"],
    );
    for (const shop of shops.rows) {
      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          ["shop-migrations:" + shop.schemaName],
        );
        await applyShopMigrations(client, shop.schemaName);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return shops.rowCount;
  } finally {
    await client.end();
  }
}

export async function provisionShop(input: {
  connectionString: string;
  name: string;
  branchName: string;
  email: string;
  userName?: string;
}) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120)
    throw new Error("A valid email is required.");
  if (!input.name.trim() || !input.branchName.trim())
    throw new Error("Shop and branch names are required.");
  const shopId = randomUUID();
  const userId = randomUUID();
  const schema = "shop_" + shopId.replaceAll("-", "");
  const identifier = shopIdentifier(schema);
  // The recipient chooses their own password through an emailed activation link.
  const passwordHash = await hashPassword(
    randomBytes(48).toString("base64url"),
  );
  const client = new pg.Client({
    connectionString: input.connectionString,
    connectionTimeoutMillis: 30000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["account-email:" + email],
      );
      const existing = await client.query<{ schemaName: string }>(
        'SELECT "schemaName" FROM public."Shop"',
      );
      for (const shop of existing.rows) {
        const conflict = await client.query(
          `SELECT "id" FROM ${shopIdentifier(shop.schemaName)}."User" WHERE "login"=$1 OR "email"=$1`,
          [email],
        );
        if (conflict.rowCount)
          throw new Error(
            "This email is already registered. No shop was created.",
          );
      }
      await client.query(
        'INSERT INTO public."Shop" ("id", "name", "branchName", "schemaName", "active") VALUES ($1,$2,$3,$4,false)',
        [shopId, input.name.trim(), input.branchName.trim(), schema],
      );
      await client.query(`CREATE SCHEMA ${identifier}`);
      await applyShopMigrations(client, schema);
      const roleId = randomUUID();
      await client.query(
        'INSERT INTO "Role" ("id","updatedAt","code","name") VALUES ($1,NOW(),$2,$3)',
        [roleId, "OWNER", "Owner"],
      );
      for (const code of rolePermissions.OWNER) {
        const permissionId = randomUUID();
        await client.query(
          'INSERT INTO "Permission" ("id","updatedAt","code","name") VALUES ($1,NOW(),$2,$2)',
          [permissionId, code],
        );
        await client.query(
          'INSERT INTO "RolePermission" ("id","updatedAt","roleId","permissionId") VALUES ($1,NOW(),$2,$3)',
          [randomUUID(), roleId, permissionId],
        );
      }
      await client.query(
        'INSERT INTO "User" ("id","updatedAt","name","login","email","passwordHash") VALUES ($1,NOW(),$2,$3,$3,$4)',
        [userId, input.userName?.trim() || "Shop Owner", email, passwordHash],
      );
      await client.query(
        'INSERT INTO "UserRole" ("id","updatedAt","userId","roleId") VALUES ($1,NOW(),$2,$3)',
        [randomUUID(), userId, roleId],
      );
      await client.query(
        'INSERT INTO "ApplicationSetting" ("id","updatedAt","key","value","changedById") VALUES ($1,NOW(),$2,$3::jsonb,$4)',
        [
          randomUUID(),
          "shop",
          JSON.stringify({
            name: input.name.trim(),
            currency: "BDT",
            timezone: "Asia/Dhaka",
            address: "",
            phone: "",
          }),
          userId,
        ],
      );
      for (const [code, name, kind, method] of [
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
      ])
        await client.query(
          'INSERT INTO "Account" ("id","updatedAt","code","name","kind","paymentMethod") VALUES ($1,NOW(),$2,$3,$4,$5)',
          [randomUUID(), code, name, kind, method],
        );
      await client.query(
        'INSERT INTO "AuditLog" ("id","updatedAt","action","resourceType","resourceId","requestId","actorId") VALUES ($1,NOW(),$2,$3,$4::text,$5,$4::uuid)',
        [randomUUID(), "SHOP_PROVISIONED", "User", userId, randomUUID()],
      );
      await client.query(
        'UPDATE public."Shop" SET "active"=true WHERE "id"=$1',
        [shopId],
      );
      await client.query("COMMIT");
      return {
        shopId,
        userId,
        schemaName: schema,
        branchName: input.branchName.trim(),
        email,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}
