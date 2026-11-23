import { Controller, Get, Inject, Req } from "@nestjs/common";
import { Permissions, type AuthRequest } from "./auth";
import { DatabaseService } from "./database.service";
import { ModuleRef } from "@nestjs/core";
import { shopContext } from "./shop-context";
import { SalesController } from "./sales";
import { PurchasesController } from "./purchases";
import { CustomersController } from "./customers";
import { SuppliersController } from "./suppliers";
import { CatalogController } from "./catalog";
import { ExpensesController } from "./expenses";
import { ReplacementsController } from "./replacements";
import { DashboardService, dhakaDate } from "./dashboard";
import { RecycleBinController } from "./recycle-bin";
import { AccountRecoveryController } from "./account-recovery";
@Controller("mobile")
export class MobileOfflineController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ModuleRef) private readonly modules: ModuleRef,
  ) {}
  @Get("offline-version")
  async version() {
    const [latest, count] = await Promise.all([
      this.db.auditLog.findFirst({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, createdAt: true },
      }),
      this.db.auditLog.count(),
    ]);
    return {
      data: {
        version: `${count}:${latest?.id || "empty"}:${latest?.createdAt.toISOString() || ""}`,
      },
    };
  }
  @Get("offline-bootstrap")
  async bootstrap(@Req() req: AuthRequest) {
    const context = shopContext.getStore();
    return this.db.$transaction(
      async (tx) =>
        shopContext.run({ ...context, transaction: tx }, async () => {
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          const can = (p: string) => req.currentUser!.permissions.includes(p);
          const sales = this.modules.get(SalesController, { strict: false }),
            purchases = this.modules.get(PurchasesController, {
              strict: false,
            }),
            customers = this.modules.get(CustomersController, {
              strict: false,
            }),
            suppliers = this.modules.get(SuppliersController, {
              strict: false,
            }),
            catalog = this.modules.get(CatalogController, { strict: false }),
            expenses = this.modules.get(ExpensesController, { strict: false }),
            replacements = this.modules.get(ReplacementsController, {
              strict: false,
            });
          const views: Record<string, unknown> = {
            "/auth/me": req.currentUser,
          };
          const capture = async (
            route: string,
            value: Promise<{ data: unknown }>,
          ) => {
            const result = await value;
            views[route] = result.data;
            return result.data;
          };
          const list = async (
            route: string,
            load: (
              query: never,
            ) => Promise<{ data: { items: unknown[]; total: number } }>,
          ) => {
            const items: unknown[] = [];
            let result: { items: unknown[]; total: number } = {
              items: [],
              total: 0,
            };
            for (let page = 1; ; page++) {
              result = (
                await load({
                  page,
                  pageSize: 100,
                  status: "all",
                  credit: "all",
                } as never)
              ).data;
              items.push(...result.items);
              if (items.length >= result.total || !result.items.length) break;
            }
            views[route] = {
              ...result,
              items,
              total: items.length,
              page: 1,
              pageSize: 100,
            };
            return items as { id: string }[];
          };
          if (can("sales.manage")) {
            await capture("/sales/options", sales.options());
            await list("/sales", (q) => sales.list(q));
          }
          if (can("purchases.manage")) {
            await capture("/purchases/options", purchases.options());
            await capture("/purchases/recent", purchases.recent());
            await list("/purchases", (q) => purchases.list(q));
          }
          if (
            can("inventory.read") ||
            can("sales.manage") ||
            can("purchases.manage") ||
            can("catalog.write")
          ) {
            await capture(
              "/catalog",
              catalog.options({ status: "all" } as never),
            );
            await list("/products", (q) => catalog.list(q));
            // Sales can use names/quantities offline without gaining catalog cost access.
            if (!can("catalog.read") && !can("finance.read")) {
              const products = views["/products"] as {
                items: Record<string, unknown>[];
              };
              products.items = products.items.map((product) => ({
                ...product,
                latestPurchasePrice: null,
              }));
            }
            await capture("/mobile/facts", this.facts(req));
          }
          if (can("parties.customers") || can("sales.manage")) {
            const contacts = await list("/customers", (q) =>
              customers.list(q, req),
            );
            for (const c of contacts) {
              await capture(
                `/customers/${c.id}/ledger`,
                customers.ledger(c.id, {}, req),
              );
              await list(`/customers/${c.id}/sales`, (q) =>
                customers.salesHistory(c.id, q, req),
              );
            }
          }
          if (can("parties.suppliers")) {
            const contacts = await list("/suppliers", (q) => suppliers.list(q));
            await capture("/suppliers/product-types", suppliers.productTypes());
            if (can("finance.read")) {
              for (const c of contacts)
                await capture(
                  `/suppliers/${c.id}/ledger`,
                  suppliers.ledger(c.id),
                );
              await list("/suppliers/ledger", (q) => suppliers.ledgerList(q));
            }
          }
          if (can("finance.read")) {
            await capture("/expenses/options", expenses.options());
            await list("/expenses", (q) => expenses.list(q));
          }
          if (
            can("replacements.intake.customer") ||
            can("replacements.intake.stock") ||
            can("replacements.resolve")
          ) {
            await list("/replacements", (q) => replacements.list(req, q));
            if (can("replacements.intake.customer"))
              await capture(
                "/replacements/options?source=CUSTOMER_WARRANTY",
                replacements.options(req, {
                  source: "CUSTOMER_WARRANTY",
                } as never),
              );
            if (can("replacements.intake.stock"))
              await capture(
                "/replacements/options?source=BEFORE_SALE",
                replacements.options(req, { source: "BEFORE_SALE" } as never),
              );
          }
          if (can("access.manage")) {
            views["/users"] = await this.db.user.findMany({
              select: {
                id: true,
                name: true,
                login: true,
                active: true,
                version: true,
                email: true,
                roles: {
                  select: { role: { select: { code: true, name: true } } },
                },
              },
              orderBy: { name: "asc" },
            });
            views["/roles"] = await this.db.role.findMany({
              select: { id: true, code: true, name: true },
              orderBy: { name: "asc" },
            });
          }
          const profile = await this.db.applicationSetting.findUnique({
            where: { key: "shop" },
            select: { value: true, version: true },
          });
          views["/shop-profile"] = profile?.value || {};
          await capture(
            "/auth/account",
            this.modules
              .get(AccountRecoveryController, { strict: false })
              .account(req),
          );
          if (can("parties.suppliers") || can("transactions.reverse"))
            await capture(
              "/recycle-bin",
              this.modules
                .get(RecycleBinController, { strict: false })
                .list(req),
            );
          if (can("settings.manage"))
            views["/settings/shop"] = profile || { value: {}, version: 0 };
          if (can("dashboard.read")) {
            const dashboard = this.modules.get(DashboardService, {
                strict: false,
              }),
              today = dhakaDate();
            const first = await this.db.sale.findFirst({
              where: { soldAt: { not: null } },
              orderBy: { soldAt: "asc" },
              select: { soldAt: true },
            });
            let from = first?.soldAt ? dhakaDate(first.soldAt) : today;
            if (from > today) from = today;
            const trend: unknown[] = [];
            let result;
            do {
              const end = new Date(from + "T12:00:00Z");
              end.setUTCDate(end.getUTCDate() + 365);
              const to =
                end.toISOString().slice(0, 10) < today
                  ? end.toISOString().slice(0, 10)
                  : today;
              result = await dashboard.get(can("finance.read"), from, to);
              trend.push(...result.salesTrend);
              end.setTime(Date.parse(to + "T12:00:00Z"));
              end.setUTCDate(end.getUTCDate() + 1);
              from = end.toISOString().slice(0, 10);
            } while (from <= today);
            views["/dashboard"] = { ...result, salesTrend: trend };
          }
          const businessVersion = (await this.version()).data.version;
          return {
            data: {
              views,
              at: new Date().toISOString(),
              version: 1,
              businessVersion,
            },
          };
        }),
      { isolationLevel: "RepeatableRead", timeout: 120000, maxWait: 30000 },
    );
  }
  @Get("offline-facts")
  @Permissions("inventory.read")
  async facts(@Req() req: AuthRequest) {
    const finance = req.currentUser!.permissions.includes("finance.read");
    const batches = await this.db.stockBatch.findMany({
      orderBy: [{ acquiredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        productId: true,
        acquiredAt: true,
        unitCost: finance,
        product: { select: { type: { select: { trackingKind: true } } } },
        balances: {
          where: { location: "SHOP", bucket: "AVAILABLE" },
          select: { quantity: true },
        },
        batteryUnits: {
          where: {
            condition: "GOOD",
            custody: "SHOP",
            ownership: "SHOP",
            commercialState: "AVAILABLE",
            reservedCustomerId: null,
            reservedReplacementId: null,
            saleHistory: { none: { releasedAt: null } },
          },
          select: { id: true },
        },
      },
    });
    const cash = finance
      ? await this.db.payment.findMany({
          where: {
            direction: "INCOMING",
            method: "CASH",
            reversedPaymentId: null,
            reversal: { is: null },
          },
          select: { id: true, occurredAt: true, amount: true },
        })
      : [];
    const purchases = finance
      ? await this.db.purchaseReceiptItem.findMany({
          where: { receipt: { purchase: { status: { not: "CANCELLED" } } } },
          select: {
            netCost: true,
            receipt: { select: { receivedDate: true } },
          },
        })
      : [];
    return {
      data: {
        purchases: purchases.map((p) => ({
          date: p.receipt.receivedDate.toISOString().slice(0, 10),
          amount: String(p.netCost),
        })),
        batches: batches.map((b) => ({
          id: b.id,
          productId: b.productId,
          date: b.acquiredAt.toISOString(),
          unitCost: finance ? String(b.unitCost) : null,
          quantity:
            b.product.type.trackingKind === "BATTERY_UNIT"
              ? b.batteryUnits.length
              : b.balances.reduce((n, r) => n + Number(r.quantity), 0),
          unitIds: b.batteryUnits.map((u) => u.id),
        })),
        cash: cash.map((p) => ({
          id: p.id,
          date: new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Dhaka",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(p.occurredAt),
          amount: String(p.amount),
        })),
      },
    };
  }
}
