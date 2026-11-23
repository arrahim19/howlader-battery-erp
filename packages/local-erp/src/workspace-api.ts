import {
  amount,
  money,
  type LocalErpState,
  type Product,
  type Contact,
  type Sale,
  type Purchase,
} from "./index";
import { LocalDevice, localOwnerPermissions } from "./device";
import type {
  CurrentUser,
  CatalogProduct,
  CustomerRecord,
  SupplierRecord,
  DashboardData,
} from "../../api-client/src";

export const devicePermissions = [
  ...localOwnerPermissions,
  "dashboard.read",
  "inventory.read",
  "inventory.receive",
  "finance.write",
  "replacements.read",
  "users.manage",
  "access.manage",
  "settings.manage",
];
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const sum = (values: string[]) =>
  money(values.reduce((n, v) => n + amount(v), 0n));
const due = (d: { total: string; paid: string }) =>
  money(amount(d.total) - amount(d.paid));
const epoch = "2000-01-01T00:00:00.000Z";
export class LocalWorkspaceApi {
  private initializing: Promise<void> | null = null;
  constructor(private readonly device: LocalDevice) {}
  user(): CurrentUser {
    const u = this.device.grant.user;
    return {
      id: u.id,
      name: u.name,
      login: u.email,
      roles: ["OWNER"],
      permissions: devicePermissions,
      shop: u.shop,
    };
  }
  private async defaults() {
    if (!(await this.device.view()).ready) return;
    if (!this.initializing)
      this.initializing = (async () => {
        const s = await this.device.erp.snapshot();
        if (
          !Object.keys(s.categories).length &&
          (await this.device.view()).ready
        ) {
          for (const [i, name] of [
            "Battery",
            "Parts",
            "Easy Bike & Rickshaw",
          ].entries())
            await this.device.command(
              "category",
              `00000000-0000-4000-8000-00000000000${i + 1}`,
              { name, trackingKind: i === 0 ? "BATTERY_UNIT" : "QUANTITY" },
            );
        }
      })().catch((e) => {
        this.initializing = null;
        throw e;
      });
    await this.initializing;
  }
  async request(
    route: string,
    method = "GET",
    body: unknown = undefined,
    key?: string,
  ): Promise<unknown> {
    const url = new URL(route, "https://local.invalid"),
      path = url.pathname,
      q = url.searchParams;
    if (path === "/auth/csrf") return { token: "local-device" };
    if (path === "/auth/me") return this.user();
    if (path === "/backups/status" && method === "GET") {
      const view = await this.device.view();
      return {
        storageMode: "local-drive",
        enabled: true,
        administrator: true,
        running: view.sync.syncing,
        localAt: view.state.audit.at(-1)?.at || view.sync.lastSuccess,
        driveAt: view.sync.lastSuccess,
        pending: view.sync.pending ? 1 : 0,
        error: view.sync.error || null,
        googleConfigured: true,
        driveConnected: view.ready && !view.expired,
      };
    }
    if (path === "/backups/run" && method === "POST") {
      await this.device.sync();
      return this.request("/backups/status");
    }
    if (path.startsWith("/modules/")) return { status: "ready" };
    await this.defaults();
    const s = await this.device.erp.snapshot(),
      categories = Object.values(s.categories),
      products = Object.values(s.products),
      contacts = Object.values(s.contacts);
    const names = [
      ...new Map(
        [...products, ...Object.values(s.productNames || {})].map((p) => [
          p.categoryId + ":" + p.name,
          p,
        ]),
      ).values(),
    ];
    const sales = Object.values(s.sales).sort(
        (a, b) => b.sequence - a.sequence,
      ),
      purchases = Object.values(s.purchases).sort(
        (a, b) => b.sequence - a.sequence,
      );
    const cash = [{ id: "1100", name: "Cash", paymentMethod: "CASH" }];
    const customer = (c: Contact): CustomerRecord => {
      const docs = sales.filter((v) => v.customerId === c.id);
      return {
        ...c,
        createdAt: epoch,
        totalSales: sum(docs.map((v) => v.total)),
        due: sum(docs.map(due)),
      };
    };
    const supplier = (c: Contact): SupplierRecord => ({
      ...c,
      productTypeId: c.categoryId,
      productType: c.categoryId ? s.categories[c.categoryId] : null,
      createdAt: epoch,
    });
    const stock = (id: string) =>
      s.batches
        .filter((b) => b.productId === id)
        .reduce((n, b) => n + b.available, 0);
    const catalog = (p: Product): CatalogProduct => {
      const units = Object.values(s.batteryUnits).filter(
        (u) => u.productId === p.id,
      );
      const type = s.categories[p.categoryId];
      const recent = [...s.batches]
        .filter((b) => b.productId === p.id)
        .sort((a, b) => b.sequence - a.sequence)[0];
      return {
        ...p,
        model: p.model || "N/A",
        type,
        category: { id: p.id, name: p.name },
        brand: null,
        defaultSellingPrice: "0.00",
        latestPurchasePrice: recent?.unitPrice || null,
        lowStockThreshold: "0",
        capacityAh: null,
        voltage: null,
        specifications: null,
        stock: {
          total: String(stock(p.id)),
          available: String(stock(p.id)),
          replaceable: String(units.filter((u) => u.state === "FAULTY").length),
          reserved: "0",
          sentToCompany: String(units.filter((u) => u.state === "SENT").length),
        },
      };
    };
    const sale = (v: Sale) => ({
      ...v,
      customer: s.contacts[v.customerId],
      saleDate: v.date,
      status: "CONFIRMED",
      subtotal: v.total,
      due: due(v),
      quantity: String(v.lines.reduce((n, l) => n + l.quantity, 0)),
      itemCount: v.lines.length,
    });
    const purchase = (v: Purchase) => ({
      ...v,
      supplier: s.contacts[v.supplierId],
      purchaseDate: v.date,
      supplierReference: v.reference,
      status: "RECEIVED",
      due: due(v),
      quantity: String(v.lines.reduce((n, l) => n + l.quantity, 0)),
      itemCount: v.lines.length,
      items: v.lines.map((l, i) => ({
        id: v.id + ":" + i,
        name: l.name,
        model: l.model || "N/A",
        typeName: s.categories[s.products[l.productId].categoryId].name,
        capacityAh: null,
        voltage: null,
        specifications: null,
        warrantyMonths: s.products[l.productId].warrantyMonths,
        quantity: String(l.quantity),
        unitPrice: l.unitPrice,
        total: l.total,
      })),
    });
    const matches = (value: string) =>
      value.toLowerCase().includes((q.get("q") || "").trim().toLowerCase());
    const page = <T>(items: T[]) => {
      const current = Math.max(1, Number(q.get("page")) || 1),
        size = Math.min(100, Math.max(1, Number(q.get("pageSize")) || 20));
      return {
        items: items.slice((current - 1) * size, current * size),
        total: items.length,
        page: current,
        pageSize: size,
      };
    };
    const typeFilter = q.get("typeId") || q.get("productTypeId");
    const selection = products.filter(
      (p) =>
        (!typeFilter || p.categoryId === typeFilter) &&
        matches(p.name + " " + (p.model || "")) &&
        (!q.get("categoryId") ||
          p.name ===
            (s.productNames?.[q.get("categoryId")!]?.name ||
              s.products[q.get("categoryId")!]?.name)),
    );
    const status = (r: LocalErpState["replacements"][string]) =>
      r.stage === "READY"
        ? "RECEIVED"
        : r.stage === "COMPLETED"
          ? "DELIVERED"
          : r.stage;
    const replacement = (r: LocalErpState["replacements"][string]) => {
      const unit = s.batteryUnits[r.unitId];
      return {
        id: r.id,
        number:
          "REP-" +
          String(Object.keys(s.replacements).indexOf(r.id) + 1).padStart(
            4,
            "0",
          ),
        source: r.source,
        status: status(r),
        version: r.version,
        product: s.products[unit.productId].name,
        serial: unit.serialNumber || "N/A",
        customer: unit.customerId ? s.contacts[unit.customerId].name : null,
        phone: unit.customerId ? s.contacts[unit.customerId].phone : null,
        invoice: unit.saleId ? s.sales[unit.saleId].invoiceNumber : null,
        supplier: s.contacts[r.supplierId].name,
        createdAt: r.createdAt,
        sentAt: r.stage === "SENT" ? r.lastDate : null,
      };
    };
    if (method === "GET") {
      if (path === "/suppliers/product-types")
        return categories.map((c) => ({ id: c.id, name: c.name }));
      if (path === "/settings/shop" || path === "/shop-profile") {
        const profile = s.shopProfile || {
          value: { name: "Howlader Battery House", address: "", phone: "" },
          version: 0,
        };
        return path === "/settings/shop" ? profile : profile.value;
      }
      if (path === "/catalog")
        return {
          types: categories.map((c) => ({
            ...c,
            productCount: products.filter((p) => p.categoryId === c.id).length,
          })),
          brands: [],
          categories: [
            ...new Map(
              names.map((p) => [
                p.name,
                {
                  id: p.id,
                  name: p.name,
                  productCount: products.filter((v) => v.name === p.name)
                    .length,
                  typeIds: [
                    ...new Set(
                      products
                        .filter((v) => v.name === p.name)
                        .map((v) => v.categoryId),
                    ),
                  ],
                  productCountsByType: Object.fromEntries(
                    categories.map((c) => [
                      c.id,
                      products.filter(
                        (v) => v.name === p.name && v.categoryId === c.id,
                      ).length,
                    ]),
                  ),
                },
              ]),
            ).values(),
          ],
          totalProducts: products.length,
        };
      if (path === "/products") return page(selection.map(catalog));
      if (path === "/sales/options")
        return {
          types: categories,
          products: products
            .filter((p) => p.active)
            .map((p) => ({
              ...catalog(p),
              availableQuantity: String(stock(p.id)),
            })),
          customers: contacts
            .filter((c) => c.kind === "customer")
            .map(customer),
          paymentAccounts: cash,
        };
      if (path === "/purchases/options")
        return {
          types: categories,
          products: products.map(catalog),
          productNames: [
            ...new Map(
              names.map((p) => [
                p.name + ":" + p.categoryId,
                { id: p.id, name: p.name, typeId: p.categoryId },
              ]),
            ).values(),
          ],
          suppliers: contacts
            .filter((c) => c.kind === "supplier")
            .map(supplier),
          paymentAccounts: cash,
        };
      if (path === "/sales")
        return page(
          sales
            .filter((v) =>
              matches(
                v.invoiceNumber +
                  " " +
                  s.contacts[v.customerId].name +
                  " " +
                  s.contacts[v.customerId].phone,
              ),
            )
            .map(sale),
        );
      if (path === "/purchases" || path === "/purchases/recent")
        return page(
          purchases
            .filter((v) =>
              matches(
                v.number +
                  " " +
                  v.reference +
                  " " +
                  s.contacts[v.supplierId].name,
              ),
            )
            .map(purchase),
        );
      if (path === "/customers") {
        const all = contacts.filter((c) => c.kind === "customer").map(customer),
          filtered = all.filter(
            (c) =>
              matches(c.name + " " + c.phone) &&
              (q.get("credit") !== "due" || amount(c.due) > 0n),
          );
        return {
          ...page(filtered),
          summary: {
            total: all.length,
            active: all.filter((c) => c.active).length,
            credit: all.filter((c) => amount(c.due) > 0n).length,
            totalSales: sum(all.map((c) => c.totalSales)),
            totalDue: sum(all.map((c) => c.due)),
          },
        };
      }
      const customerRoute = path.match(
        /^\/customers\/([^/]+)\/(sales|ledger)$/,
      );
      if (customerRoute) {
        const c = s.contacts[customerRoute[1]];
        if (!c || c.kind !== "customer")
          throw new Error("Customer was not found in this shop.");
        if (customerRoute[2] === "sales")
          return {
            ...page(
              sales
                .filter(
                  (v) =>
                    v.customerId === c.id &&
                    (!q.get("saleId") || v.id === q.get("saleId")),
                )
                .map((v) => ({
                  id: v.id,
                  invoiceNumber: v.invoiceNumber,
                  soldAt: v.date,
                  status: "CONFIRMED",
                  subtotal: v.total,
                  discount: "0.00",
                  total: v.total,
                  products: v.lines.map((l, i) => ({
                    id: v.id + ":" + i,
                    name: l.name,
                    model: l.model || "N/A",
                    quantity: String(l.quantity),
                    unit: s.products[l.productId].unit,
                    unitPrice: l.unitPrice,
                    amount: l.total,
                  })),
                })),
            ),
            customer: customer(c),
          };
        const rows = await this.device.erp.customerLedger(c.id);
        const ascending = [...rows].reverse();
        const from = q.get("from"),
          to = q.get("to");
        const before = ascending.filter((v) => from && v.date < from),
          selected = rows.filter(
            (v) => (!from || v.date >= from) && (!to || v.date <= to),
          );
        const closing =
          ascending.filter((v) => !to || v.date <= to).at(-1)?.balance ||
          "0.00";
        return {
          customer: customer(c),
          from,
          to,
          summary: {
            opening: before.at(-1)?.balance || "0.00",
            debit: sum(selected.map((v) => v.sale || "0.00")),
            credit: sum(selected.map((v) => v.paid)),
            closing,
          },
          paymentAccounts: cash,
          items: selected.map((v) => ({
            ...v,
            reference: v.description,
            description: "",
            kind: v.sale === null ? "payment" : "sale",
            debit: v.sale || "0.00",
            credit: v.paid,
          })),
        };
      }
      if (path === "/suppliers" || path === "/suppliers/ledger") {
        const all = contacts
          .filter((c) => c.kind === "supplier")
          .filter(
            (c) =>
              (!typeFilter || c.categoryId === typeFilter) &&
              matches(c.name + " " + c.phone + " " + c.company),
          )
          .map((c) => ({
            ...supplier(c),
            totalPurchases: sum(
              purchases
                .filter((v) => v.supplierId === c.id)
                .map((v) => v.total),
            ),
            due: sum(purchases.filter((v) => v.supplierId === c.id).map(due)),
          }));
        return {
          ...page(all),
          summary: {
            totalPurchases: sum(all.map((c) => c.totalPurchases)),
            totalDue: sum(all.map((c) => c.due)),
          },
        };
      }
      const supplierLedger = path.match(/^\/suppliers\/([^/]+)\/ledger$/);
      if (supplierLedger) {
        const c = s.contacts[supplierLedger[1]];
        if (!c) throw new Error("Supplier not found.");
        const docs = purchases.filter((v) => v.supplierId === c.id);
        return {
          supplier: {
            ...supplier(c),
            totalPurchases: sum(docs.map((v) => v.total)),
            due: sum(docs.map(due)),
          },
          items: docs.map((v) => ({
            id: v.id,
            date: v.date,
            reference: v.number,
            description: v.reference,
            debit: v.total,
            credit: v.paid,
            balance: due(v),
          })),
        };
      }
      if (path === "/expenses/options")
        return {
          categories: ["Office Expense", "Transport", "Others"],
          cashAvailable: true,
          paymentAccounts: cash,
        };
      if (path === "/expenses") {
        const expenses = [
          ...Object.values(s.expenses).map((v) => ({
            ...v,
            expenseId: v.id,
            category: v.category || "Others",
            source: "MANUAL",
            paymentAccount: "Cash",
          })),
          ...purchases
            .filter((v) => amount(v.transport) > 0n)
            .map((v) => ({
              id: v.id,
              expenseId: null,
              date: v.date,
              description: "Purchase transport",
              category: "Transport",
              source: "PURCHASE_TRANSPORT",
              amount: v.transport,
              paymentAccount: "Cash",
              challanNumber: v.reference,
            })),
        ].sort((a, b) => b.date.localeCompare(a.date));
        return {
          ...page(expenses),
          summary: {
            total: sum(expenses.map((e) => e.amount)),
            byCategory: ["Office Expense", "Transport", "Others"].map(
              (name) => ({
                name,
                amount: sum(
                  expenses
                    .filter((e) => e.category === name)
                    .map((e) => e.amount),
                ),
              }),
            ),
          },
        };
      }
      if (path === "/replacements/options")
        return {
          units: Object.values(s.batteryUnits)
            .filter((u) =>
              q.get("source") === "BEFORE_SALE"
                ? u.state === "AVAILABLE"
                : u.state === "SOLD",
            )
            .filter((u) =>
              matches(
                s.products[u.productId].name +
                  " " +
                  (u.serialNumber || "") +
                  " " +
                  (u.customerId ? s.contacts[u.customerId].name : ""),
              ),
            )
            .map((u) => ({
              id: u.id,
              productId: u.productId,
              saleUnitId: u.saleId ? u.id : null,
              label:
                s.products[u.productId].name +
                " · " +
                (u.serialNumber || "N/A"),
              supplierId:
                s.purchases[
                  s.batches.find((b) => b.id === u.batchId)!.purchaseId
                ].supplierId,
              customer: u.customerId ? s.contacts[u.customerId].name : null,
              invoice: u.saleId ? s.sales[u.saleId].invoiceNumber : null,
            })),
          suppliers: contacts
            .filter((c) => c.kind === "supplier")
            .map(supplier),
        };
      if (path === "/replacements") {
        const all = Object.values(s.replacements)
          .reverse()
          .filter((r) => !["REJECTED", "CANCELLED"].includes(r.stage))
          .map(replacement);
        return {
          ...page(
            all.filter(
              (r) =>
                matches(
                  r.product +
                    " " +
                    r.serial +
                    " " +
                    r.customer +
                    " " +
                    r.invoice,
                ) &&
                (!q.get("status") ||
                  q.get("status") === "all" ||
                  r.status === q.get("status")),
            ),
          ),
          summary: Object.fromEntries(
            ["FAULTY", "SENT", "RECEIVED", "DELIVERED"].map((stage) => [
              stage,
              all.filter((r) => r.status === stage).length,
            ]),
          ),
        };
      }
      if (path === "/dashboard") return this.dashboard(s, q);
      if (path === "/users")
        return [
          {
            ...this.user(),
            roles: [{ role: { code: "OWNER", name: "Owner" } }],
            version: 1,
            active: true,
            email: this.device.grant.user.email,
            createdAt: epoch,
          },
        ];
      if (path === "/recycle-bin") return [];
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<
      string,
      unknown
    >;
    const text = (name: string, fallback = "") => String(b[name] ?? fallback),
      requestKey = key || this.device.newKey();
    if (method === "POST") {
      if (path === "/settings/shop")
        return this.device.command("profile", requestKey, {
          name: text("name"),
          address: text("address"),
          phone: text("phone"),
          version: b.version,
        });
      if (path === "/categories") {
        const result = (await this.device.command("name", requestKey, {
          categoryId: text("typeId"),
          name: text("name"),
        })) as { id: string; name: string; categoryId: string };
        return { id: result.id, name: result.name, typeId: result.categoryId };
      }
      if (path === "/products") {
        const normalize = (v: string) =>
          v.trim().toLowerCase() === "n/a" ? "" : v.trim().toLowerCase();
        const existing = products.find(
          (p) =>
            p.categoryId === text("typeId") &&
            p.name.toLowerCase() === text("name").trim().toLowerCase() &&
            normalize(p.model || "") === normalize(text("model")),
        );
        if (existing) return catalog(existing);
        const result = (await this.device.command("product", requestKey, {
          categoryId: text("typeId"),
          name: text("name"),
          model: text("model"),
          unit: text("unit", "pcs"),
          warrantyMonths: Number(b.warrantyMonths || 0),
        })) as Product;
        return catalog(result);
      }
      if (path === "/customers" || path === "/suppliers") {
        const kind = path === "/customers" ? "customer" : "supplier";
        const result = (await this.device.command("contact", requestKey, {
          kind,
          name: text("name"),
          phone: text("phone"),
          address: text("address"),
          company: text("company"),
          ...(kind === "supplier" ? { categoryId: text("productTypeId") } : {}),
        })) as Contact;
        return kind === "customer" ? customer(result) : supplier(result);
      }
      if (path === "/sales/complete") {
        const result = (await this.device.command("sale", requestKey, {
          customerId: text("customerId"),
          date: text("saleDate"),
          items: b.items,
          paid: text("paidAmount", "0"),
          paymentAccount: text("paymentAccountId", "1100"),
        })) as Sale;
        return {
          ...sale(result),
          quantity: result.lines.reduce((n, l) => n + l.quantity, 0),
        };
      }
      if (path === "/purchases/receive") {
        const result = (await this.device.command("purchase", requestKey, {
          supplierId: text("supplierId"),
          date: text("purchaseDate"),
          reference: text("reference"),
          items: b.items,
          paid: text("paidAmount", "0"),
          transport: text("transportAmount", "0"),
          paymentAccount: text("paymentAccountId", "1100"),
        })) as Purchase;
        return {
          ...purchase(result),
          receiptId: result.id,
          quantity: result.lines.reduce((n, l) => n + l.quantity, 0),
          transportAmount: result.transport,
        };
      }
      const payment = path.match(
        /^\/(customers|suppliers)\/([^/]+)\/payments$/,
      );
      if (payment) {
        const result = (await this.device.command("payment", requestKey, {
          contactId: payment[2],
          date: text("date", today()),
          amount: text("amount"),
          paymentAccount: text("paymentAccountId", "1100"),
        })) as { id: string };
        return { ...result, number: "PAY-" + result.id.slice(0, 8) };
      }
      if (path === "/expenses")
        return this.device.command("expense", requestKey, {
          date: text("expenseDate"),
          amount: text("amount"),
          description: text("description"),
          category: text("category", "Others"),
        });
      if (path === "/replacements") {
        if (Number(b.quantity || 1) !== 1)
          throw new Error(
            "Select one battery per replacement claim so its warranty and serial stay traceable.",
          );
        return this.device.command("replacement", text("id", requestKey), {
          unitId: text("unitId"),
          supplierId: text("supplierId"),
          source: text("source"),
          date: today(),
          reason: text("faultReason"),
        });
      }
      const stage = path.match(/^\/replacements\/([^/]+)\/status$/);
      if (stage) {
        const op = (
          {
            SENT: "dispatch",
            RECEIVED: "receive",
            DELIVERED: "deliver",
          } as const
        )[text("status") as "SENT" | "RECEIVED" | "DELIVERED"];
        if (!op) throw new Error("Unsupported replacement transition.");
        const result = (await this.device.command(op, requestKey, {
          id: stage[1],
          version: Number(b.version),
          date: today(),
        })) as LocalErpState["replacements"][string];
        return {
          id: result.id,
          version: result.version,
          status: status(result),
        };
      }
    }
    throw new Error(
      "This action is not connected to the local database yet. No server request was sent and no data was changed.",
    );
  }
  private dashboard(s: LocalErpState, q: URLSearchParams): DashboardData {
    const date = today(),
      from = q.get("from") || date,
      to = q.get("to") || date,
      inRange = (d: string) => d >= from && d <= to;
    const sales = Object.values(s.sales).sort(
        (a, b) => b.sequence - a.sequence,
      ),
      period = sales.filter((v) => inRange(v.date)),
      purchases = Object.values(s.purchases),
      units = Object.values(s.batteryUnits),
      replacements = Object.values(s.replacements),
      products = Object.values(s.products);
    const stock = s.batches.reduce((n, b) => n + b.available, 0),
      batteries = units.filter((u) => u.state === "AVAILABLE").length;
    const value = money(
      s.journals
        .flatMap((j) => j.lines)
        .filter((l) => l.account === "1300")
        .reduce((n, l) => n + amount(l.debit) - amount(l.credit), 0n),
    );
    const payments = Object.values(s.payments),
      allocations = payments.flatMap((p) => p.allocations);
    const initialPaid = (d: Sale | Purchase) =>
      money(
        amount(d.paid) -
          allocations
            .filter((a) => a.documentId === d.id)
            .reduce((n, a) => n + amount(a.amount), 0n),
      );
    const companyTransactions = [
      ...purchases
        .filter((p) => inRange(p.date) && amount(initialPaid(p)) > 0n)
        .map((p) => ({
          id: p.id,
          date: p.date,
          company:
            s.contacts[p.supplierId].company || s.contacts[p.supplierId].name,
          challanNumber: p.reference,
          type: "Payment" as const,
          amount: initialPaid(p),
        })),
      ...payments
        .filter((p) => p.direction === "OUTGOING" && inRange(p.date))
        .map((p) => ({
          id: p.id,
          date: p.date,
          company:
            s.contacts[p.contactId].company || s.contacts[p.contactId].name,
          challanNumber: null,
          type: "Payment" as const,
          amount: p.amount,
        })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const stages = {
      pendingReturn: replacements.filter((r) => r.stage === "FAULTY").length,
      sentToCompany: replacements.filter((r) => r.stage === "SENT").length,
      received: replacements.filter((r) => r.stage === "READY").length,
    };
    return {
      businessDate: date,
      from,
      to,
      counts: {
        products: products.length,
        customers: Object.values(s.contacts).filter(
          (c) => c.kind === "customer",
        ).length,
        availableStock: String(stock),
        pendingReplacements: stages.pendingReturn,
        sentToCompany: stages.sentToCompany,
        replacementsReceived: stages.received,
        lowStock: 0,
      },
      financials: {
        availableStockPurchaseValue: value,
        todaySales: sum(period.map((v) => v.total)),
        todayPurchases: sum(
          purchases.filter((v) => inRange(v.date)).map((v) => v.total),
        ),
        todayCashReceived: sum([
          ...period.map(initialPaid),
          ...payments
            .filter((p) => p.direction === "INCOMING" && inRange(p.date))
            .map((p) => p.amount),
        ]),
        grossProfit: money(
          period.reduce((n, v) => n + amount(v.total) - amount(v.cost), 0n),
        ),
        customerDues: sum(sales.map(due)),
        supplierDues: sum(purchases.map(due)),
        transportExpenses: sum(
          purchases.filter((v) => inRange(v.date)).map((v) => v.transport),
        ),
        companyTransactions,
        companyTransactionCount: companyTransactions.length,
        companyTransactionAmount: sum(companyTransactions.map((p) => p.amount)),
        transportTransactions: purchases
          .filter((v) => inRange(v.date) && amount(v.transport) > 0n)
          .map((v) => ({
            id: v.id,
            date: v.date,
            description: "Transport",
            amount: v.transport,
            challanNumber: v.reference,
          })),
      },
      recentSales: period.slice(0, 10).map((v) => ({
        id: v.id,
        invoiceNumber: v.invoiceNumber,
        soldAt: v.date,
        customer: s.contacts[v.customerId].name,
        customerId: v.customerId,
        customerPhone: s.contacts[v.customerId].phone,
        paid: v.paid,
        due: due(v),
        total: v.total,
        status: "CONFIRMED",
      })),
      lowStock: [],
      salesTrend: [],
      stock: {
        batteriesAvailable: batteries,
        partsAvailable: String(stock - batteries),
        accountedUnits: String(stock),
        replaceable: stages.pendingReturn,
        reserved: 0,
      },
      replacementStages: {
        ...stages,
        total: replacements.length,
        underReview: 0,
        readyForDelivery: stages.received,
      },
    };
  }
}
