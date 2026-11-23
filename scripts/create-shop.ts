import "reflect-metadata";
import { parseArgs } from "node:util";
import { settings } from "../apps/api/src/config";
import { provisionShop } from "../apps/api/src/shop-provisioning";
async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      branch: { type: "string" },
      name: { type: "string" },
      "user-name": { type: "string" },
    },
  });
  if (!values.email || !values.branch || !values.name)
    throw new Error("Provide --email, --branch, and --name.");
  const shop = await provisionShop({
    connectionString:
      process.env.DATABASE_URL_UNPOOLED || settings().databaseUrl,
    email: values.email,
    branchName: values.branch,
    name: values.name,
    userName: values["user-name"],
  });
  console.log(
    JSON.stringify({
      branch: shop.branchName,
      email: shop.email,
      status: "created; account activation required",
    }),
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Shop provisioning failed.",
  );
  process.exitCode = 1;
});
