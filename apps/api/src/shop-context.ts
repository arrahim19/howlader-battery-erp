import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";

export type ShopIdentity = {
  id: string;
  name: string;
  branchName: string;
  schemaName: string;
};

// Only server-side authentication selects a shop, within its own HTTP request.
export const shopContext = new AsyncLocalStorage<{
  shop?: ShopIdentity;
  transaction?: Prisma.TransactionClient;
}>();
export function bindShop(shop: ShopIdentity) {
  const context = shopContext.getStore();
  if (!context)
    throw new Error("Shop selection requires an active request context.");
  context.shop = shop;
}
