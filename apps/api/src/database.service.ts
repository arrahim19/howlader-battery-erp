import { Injectable } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { settings } from "./config";
import { shopContext, type ShopIdentity } from "./shop-context";

const delegates = new Set(
  Prisma.dmmf.datamodel.models.map(
    (model) => model.name[0].toLowerCase() + model.name.slice(1),
  ),
);
const operations = new Set([
  "$transaction",
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
]);

@Injectable()
export class DatabaseService extends PrismaClient {
  readonly global: PrismaClient;
  private readonly clients = new Map<string, PrismaClient>();

  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: settings().databaseUrl }),
    });
    this.global = this.forSchema("public");
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (
          typeof property === "string" &&
          (delegates.has(property) || operations.has(property))
        ) {
          const transaction = shopContext.getStore()?.transaction;
          if (transaction && property === "$transaction")
            return (
              work:
                | ((tx: Prisma.TransactionClient) => Promise<unknown>)
                | Promise<unknown>[],
            ) =>
              typeof work === "function"
                ? work(transaction)
                : Promise.all(work);
          const client =
            transaction ??
            target.forSchema(
              shopContext.getStore()?.shop?.schemaName ?? "public",
            );
          const value = Reflect.get(client, property);
          return typeof value === "function" ? value.bind(client) : value;
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  forSchema(schemaName: string) {
    if (schemaName !== "public" && !/^shop_[a-f0-9]{32}$/.test(schemaName))
      throw new Error("Invalid shop database schema.");
    let client = this.clients.get(schemaName);
    if (!client) {
      client = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString:
              schemaName === "public"
                ? settings().databaseUrl
                : (process.env.DATABASE_URL_UNPOOLED ?? settings().databaseUrl),
            // Raw SQL and Prisma use the same schema, with no fallback to another shop.
            options:
              schemaName === "public"
                ? "-c timezone=UTC"
                : `-c timezone=UTC -c search_path=${schemaName}`,
            max: 5,
            connectionTimeoutMillis: 30000,
          },
          { schema: schemaName },
        ),
      });
      this.clients.set(schemaName, client);
    }
    return client;
  }

  async shopClients() {
    const shops = await this.global.shop.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, branchName: true, schemaName: true },
    });
    return shops.map((shop: ShopIdentity) => ({
      shop,
      client: this.forSchema(shop.schemaName),
    }));
  }

  async findAcrossShops<T>(
    lookup: (client: PrismaClient) => Promise<T | null>,
  ) {
    for (const scope of await this.shopClients()) {
      const record = await lookup(scope.client);
      if (record) return { ...scope, record };
    }
    return null;
  }

  async $connect() {
    await this.global.$connect();
  }
  async $disconnect() {
    await Promise.all(
      [...this.clients.values()].map((client) => client.$disconnect()),
    );
  }
  async onModuleDestroy() {
    await this.$disconnect();
    await super.$disconnect();
  }
}
