import "reflect-metadata";
import { settings } from "../apps/api/src/config";
import { migrateShopDatabases } from "../apps/api/src/shop-provisioning";
async function main() {
  const count = await migrateShopDatabases(
    process.env.DATABASE_URL_UNPOOLED || settings().databaseUrl,
  );
  console.log(`Shop migrations applied: ${count ?? 0} additional shops.`);
}
main().catch(() => {
  console.error(
    "Shop migration failed. Inspect the migration and database configuration before retrying.",
  );
  process.exitCode = 1;
});
