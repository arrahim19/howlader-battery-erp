// All screens read this device snapshot plus its durable local command journal.
// Cloud acknowledgements replace the base snapshot atomically; pending commands
// are replayed over it, so a restart or a lost upload response cannot lose a sale.
export type Row = Record<string, unknown>;
export type ReplicaSnapshot = {
  views: Record<string, unknown>;
  acknowledged: string[];
  at: string;
  businessVersion?: string;
};
export type LocalCommand = {
  id: string;
  route: string;
  body: unknown;
  localResult?: unknown;
  result?: unknown;
  createdAt: string;
  state: string;
};
export const obj = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const str = (v: unknown) => String(v ?? "");
const cents = (v: unknown) => {
  const text = str(v || "0");
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("Invalid amount.");
  const negative = text.startsWith("-"),
    [whole, fraction = ""] = text.replace("-", "").split(".");
  const result =
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -result : result;
};
const money = (v: bigint) =>
  `${v < 0n ? "-" : ""}${(v < 0n ? -v : v) / 100n}.${String((v < 0n ? -v : v) % 100n).padStart(2, "0")}`;
const add = (v: unknown, delta: bigint) => money(cents(v) + delta);
const total = (items: Row[], field: string) =>
  money(items.reduce((n, r) => n + cents(r[field]), 0n));
const date = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const offlineReference = (id: unknown) =>
  "OFF-" + str(id).replace(/-/g, "").toUpperCase();
const day = (v: unknown) => str(v).slice(0, 10);
const micro = (v: unknown) => {
  const [w, f = ""] = str(v || "0").split(".");
  return BigInt(w) * 1000000n + BigInt(f.padEnd(6, "0").slice(0, 6));
};
function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function projectReplica(
  snapshot: ReplicaSnapshot,
  commands: LocalCommand[],
) {
  const views = copy(snapshot.views);
  const list = (path: string) => rows(obj(views[path]).items);
  const setList = (path: string, items: Row[]) => {
    views[path] = {
      ...obj(views[path]),
      items,
      total: items.length,
      page: 1,
      pageSize: items.length || 20,
    };
  };
  const acknowledged = new Set(snapshot.acknowledged);
  const applied = commands.filter(
    (c) => c.localResult && !acknowledged.has(c.id) && c.state !== "blocked",
  );
  for (const command of commands.filter(
    (c) => c.state === "done" && acknowledged.has(c.id),
  )) {
    const path =
      command.route === "/sales/complete"
        ? "/sales"
        : command.route === "/purchases/receive"
          ? "/purchases"
          : null;
    if (path) {
      const row = list(path).find(
        (r) =>
          r.id === obj(command.localResult).id ||
          r.id === obj(command.result).id,
      );
      if (row) row.localReference = offlineReference(command.id);
    }
  }
  const stock = new Map(
    list("/products").map((p) => [
      str(p.id),
      Number(obj(p.stock).available || 0),
    ]),
  );
  const totalDelta = new Map<string, number>();
  const batches = rows(obj(views["/mobile/facts"]).batches);
  const customerDelta = new Map<string, bigint>(),
    supplierDelta = new Map<string, bigint>();
  const deltas: {
    date: string;
    sale: bigint;
    purchase: bigint;
    cash: bigint;
    cost: bigint;
    transport: bigint;
  }[] = [];
  for (const command of applied) {
    const b = obj(command.body),
      result = obj(command.localResult),
      path = command.route;
    if (path === "/settings/shop") {
      views[path] = result;
      views["/shop-profile"] = result.value;
    }
    if (["/customers", "/suppliers", "/products"].includes(path)) {
      setList(path, [result, ...list(path).filter((r) => r.id !== result.id)]);
      if (path === "/products") stock.set(str(result.id), 0);
      if (path === "/customers") {
        views[`/customers/${result.id}/ledger`] = {
          customer: result,
          items: [],
          summary: {
            opening: "0.00",
            debit: "0.00",
            credit: "0.00",
            closing: "0.00",
          },
          paymentAccounts: obj(views["/sales/options"]).paymentAccounts || [],
        };
        views[`/customers/${result.id}/sales`] = {
          customer: result,
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
        };
      }
      if (path === "/suppliers")
        views[`/suppliers/${result.id}/ledger`] = {
          supplier: { ...result, totalPurchases: "0.00", due: "0.00" },
          items: [],
        };
    }
    if (path === "/categories") {
      const catalog = obj(views["/catalog"]);
      catalog.categories = [
        result,
        ...rows(catalog.categories).filter((c) => c.id !== result.id),
      ];
    }
    if (path === "/sales/complete" || path === "/purchases/receive") {
      const sale = path === "/sales/complete",
        items = rows(b.items),
        paid = cents(b.paidAmount),
        value = cents(result.total),
        when = day(b.saleDate || b.purchaseDate);
      for (const item of items)
        stock.set(
          str(item.productId),
          (stock.get(str(item.productId)) || 0) +
            (sale ? -1 : 1) * Number(item.quantity),
        );
      for (const item of items)
        totalDelta.set(
          str(item.productId),
          (totalDelta.get(str(item.productId)) || 0) +
            (sale ? -1 : 1) * Number(item.quantity),
        );
      if (sale)
        for (const allocation of rows(result.localAllocations)) {
          const batch = batches.find((r) => r.id === allocation.batchId);
          if (batch)
            batch.quantity =
              Number(batch.quantity) - Number(allocation.quantity);
        }
      else batches.push(...rows(result.localBatches));
      if (sale) {
        const customer =
          list("/customers").find((c) => c.id === b.customerId) ||
          rows(obj(views["/sales/options"]).customers).find(
            (c) => c.id === b.customerId,
          ) ||
          {};
        setList("/sales", [
          {
            ...result,
            customer,
            saleDate: when,
            status: "LOCAL",
            syncStatus: "PENDING",
            quantity: str(result.quantity),
            itemCount: items.length,
          },
          ...list("/sales"),
        ]);
        customerDelta.set(
          str(b.customerId),
          (customerDelta.get(str(b.customerId)) || 0n) + value - paid,
        );
        const history = `/customers/${b.customerId}/sales`;
        setList(history, [
          {
            ...result,
            soldAt: when,
            status: "LOCAL",
            discount: "0.00",
            products: items.map((item) => {
              const p =
                list("/products").find((p) => p.id === item.productId) || {};
              return {
                id: `${command.id}:${item.productId}`,
                name: p.name,
                model: p.model,
                unit: p.unit,
                quantity: str(item.quantity),
                unitPrice: item.unitPrice,
                amount: money(
                  cents(item.unitPrice) * BigInt(Number(item.quantity)),
                ),
              };
            }),
          },
          ...list(history),
        ]);
      } else {
        const supplier =
          list("/suppliers").find((c) => c.id === b.supplierId) || {};
        const details = items.map((item) => {
          const p =
            list("/products").find((p) => p.id === item.productId) || {};
          return {
            ...item,
            id: `${command.id}:${item.productId}`,
            name: p.name,
            model: p.model,
            typeName: obj(p.type).name,
            total: money(cents(item.unitPrice) * BigInt(Number(item.quantity))),
          };
        });
        setList("/purchases", [
          {
            ...result,
            supplier,
            items: details,
            purchaseDate: when,
            supplierReference: b.reference,
            status: "LOCAL",
            syncStatus: "PENDING",
            quantity: str(result.quantity),
            itemCount: items.length,
          },
          ...list("/purchases"),
        ]);
        supplierDelta.set(
          str(b.supplierId),
          (supplierDelta.get(str(b.supplierId)) || 0n) + value - paid,
        );
        if (cents(b.transportAmount) > 0n)
          setList("/expenses", [
            {
              id: command.id + ":transport",
              expenseId: null,
              date: when,
              description: "Purchase transport",
              category: "Transport",
              amount: b.transportAmount,
              source: "PURCHASE_TRANSPORT",
              paymentAccount: "Cash",
              challanNumber: b.reference,
              syncStatus: "PENDING",
            },
            ...list("/expenses"),
          ]);
      }
      deltas.push({
        date: when,
        sale: sale ? value : 0n,
        purchase: sale ? 0n : value,
        cash: sale ? paid : 0n,
        cost: sale ? cents(result.localCost) : 0n,
        transport: sale ? 0n : cents(b.transportAmount),
      });
    }
    const payment = path.match(/^\/customers\/([^/]+)\/payments$/);
    if (payment) {
      customerDelta.set(
        payment[1],
        (customerDelta.get(payment[1]) || 0n) - cents(b.amount),
      );
      deltas.push({
        date: day(b.date),
        sale: 0n,
        purchase: 0n,
        cash: cents(b.amount),
        cost: 0n,
        transport: 0n,
      });
      let remaining = cents(b.amount);
      const ordered = list("/sales")
        .filter((s) => obj(s.customer).id === payment[1])
        .sort(
          (a, z) =>
            str(a.saleDate).localeCompare(str(z.saleDate)) ||
            str(a.id).localeCompare(str(z.id)),
        );
      for (const sale of ordered) {
        const due = cents(sale.due),
          paid = remaining < due ? remaining : due;
        if (paid > 0n) {
          sale.due = add(sale.due, -paid);
          sale.paid = add(sale.paid, paid);
          remaining -= paid;
        }
        if (remaining <= 0n) break;
      }
    }
    if (path === "/expenses")
      setList("/expenses", [
        {
          ...result,
          expenseId: result.id,
          date: b.expenseDate,
          description: b.description,
          category: b.category,
          amount: b.amount,
          source: "MANUAL",
          paymentAccount: "Cash",
          syncStatus: "PENDING",
        },
        ...list("/expenses"),
      ]);
    if (path === "/replacements") {
      setList("/replacements", [{ ...result }, ...list("/replacements")]);
      const used = new Set(rows(result.localUnits).map((u) => str(u.id)));
      for (const source of ["BEFORE_SALE", "CUSTOMER_WARRANTY"]) {
        const options = obj(views[`/replacements/options?source=${source}`]);
        options.units = rows(options.units).filter((u) => !used.has(str(u.id)));
      }
      if (b.source === "BEFORE_SALE")
        for (const unit of rows(result.localUnits)) {
          stock.set(
            str(unit.productId),
            (stock.get(str(unit.productId)) || 0) - 1,
          );
          const batch = batches.find(
            (r) =>
              Array.isArray(r.unitIds) &&
              (r.unitIds as string[]).includes(str(unit.id)),
          );
          if (batch) batch.quantity = Number(batch.quantity) - 1;
        }
    }
    const replacementStatus = path.match(/^\/replacements\/([^/]+)\/status$/);
    if (replacementStatus)
      setList(
        "/replacements",
        list("/replacements").map((r) =>
          r.id === replacementStatus[1] ? { ...r, ...result } : r,
        ),
      );
  }
  for (const path of ["/products", "/customers", "/suppliers"]) {
    setList(
      path,
      list(path).map((r) =>
        path === "/products"
          ? {
              ...r,
              stock: {
                ...obj(r.stock),
                available: str(stock.get(str(r.id)) || 0),
                total: str(
                  Number(obj(r.stock).total || 0) +
                    (totalDelta.get(str(r.id)) || 0),
                ),
              },
            }
          : path === "/customers"
            ? {
                ...r,
                due: add(r.due, customerDelta.get(str(r.id)) || 0n),
                totalSales: add(
                  r.totalSales,
                  applied
                    .filter(
                      (c) =>
                        c.route === "/sales/complete" &&
                        obj(c.body).customerId === r.id,
                    )
                    .reduce((n, c) => n + cents(obj(c.localResult).total), 0n),
                ),
              }
            : { ...r, due: add(r.due, supplierDelta.get(str(r.id)) || 0n) },
      ),
    );
  }
  if (views["/sales/options"]) {
    const options = obj(views["/sales/options"]);
    options.products = list("/products")
      .filter((p) => p.active !== false)
      .map((p) => ({
        ...p,
        availableQuantity: str(stock.get(str(p.id)) || 0),
      }));
    options.customers = list("/customers").filter((c) => c.active !== false);
  }
  if (views["/purchases/options"]) {
    const options = obj(views["/purchases/options"]);
    options.suppliers = list("/suppliers").filter((c) => c.active !== false);
    options.products = list("/products").filter((p) => p.active !== false);
  }
  if (views["/purchases/recent"])
    views["/purchases/recent"] = { items: list("/purchases").slice(0, 10) };
  for (const [customerId, delta] of customerDelta) {
    const key = `/customers/${customerId}/ledger`,
      ledger = obj(views[key]);
    if (views[key]) {
      const pending = applied
        .filter(
          (c) =>
            obj(c.body).customerId === customerId ||
            c.route === `/customers/${customerId}/payments`,
        )
        .map((c) => ({
          id: c.id,
          date: new Date(
            day(obj(c.body).saleDate || obj(c.body).date) + "T12:00:00+06:00",
          ).toISOString(),
          description: obj(c.localResult).invoiceNumber || "Offline collection",
          reference:
            obj(c.localResult).invoiceNumber ||
            obj(c.body).reference ||
            "Offline collection",
          kind: c.route === "/sales/complete" ? "sale" : "payment",
          debit:
            c.route === "/sales/complete" ? obj(c.localResult).total : "0.00",
          credit: obj(c.body).paidAmount || obj(c.body).amount || "0.00",
          balance: "0.00",
          syncStatus: "PENDING",
        }));
      const entries = [...rows(ledger.items), ...pending].sort(
        (a, b) =>
          str(a.date).localeCompare(str(b.date)) ||
          str(a.id).localeCompare(str(b.id)),
      );
      let balance = cents(obj(ledger.summary).opening);
      ledger.items = entries.map((r) => {
        balance += cents(r.debit) - cents(r.credit);
        return { ...r, balance: money(balance) };
      });
      ledger.summary = {
        ...obj(ledger.summary),
        debit: total(entries, "debit"),
        credit: total(entries, "credit"),
        closing: money(balance),
      };
      ledger.customer = list("/customers").find((c) => c.id === customerId) || {
        ...obj(ledger.customer),
        due: add(obj(ledger.customer).due, delta),
      };
      const history = obj(views[`/customers/${customerId}/sales`]);
      history.customer = ledger.customer;
    }
  }
  for (const [supplierId, delta] of supplierDelta) {
    const key = `/suppliers/${supplierId}/ledger`,
      ledger = obj(views[key]);
    const pending = applied
      .filter(
        (c) =>
          c.route === "/purchases/receive" &&
          obj(c.body).supplierId === supplierId,
      )
      .map((c) => ({
        id: c.id,
        date: new Date(
          day(obj(c.body).purchaseDate) + "T12:00:00+06:00",
        ).toISOString(),
        reference: obj(c.body).reference || obj(c.localResult).number,
        description: "Offline purchase",
        credit: obj(c.localResult).total,
        debit: obj(c.body).paidAmount || "0.00",
        syncStatus: "PENDING",
      }));
    if (views[key]) {
      let balance = 0n;
      ledger.items = [...rows(ledger.items), ...pending]
        .sort(
          (a, b) =>
            str(a.date).localeCompare(str(b.date)) ||
            str(a.id).localeCompare(str(b.id)),
        )
        .map((r) => {
          balance += cents(r.credit) - cents(r.debit);
          return { ...r, balance: money(balance) };
        });
      ledger.supplier = {
        ...obj(ledger.supplier),
        due: add(obj(ledger.supplier).due, delta),
        totalPurchases: add(
          obj(ledger.supplier).totalPurchases,
          cents(total(pending, "credit")),
        ),
      };
    }
  }
  if (views["/suppliers/ledger"]) {
    const existing = list("/suppliers/ledger");
    setList(
      "/suppliers/ledger",
      list("/suppliers").map((s) => ({
        ...s,
        ...(existing.find((r) => r.id === s.id) || {}),
        ...obj(obj(views[`/suppliers/${s.id}/ledger`]).supplier),
      })),
    );
  }
  return { views, deltas, customerDelta, supplierDelta };
}

export function readReplica(
  snapshot: ReplicaSnapshot,
  commands: LocalCommand[],
  route: string,
): unknown | undefined {
  const url = new URL(route, "https://local.invalid"),
    path = url.pathname,
    q = url.searchParams;
  const { views, deltas, supplierDelta } = projectReplica(snapshot, commands);
  if (path.startsWith("/modules/"))
    return {
      module: path.split("/")[2],
      status: "FOUNDATION_ONLY",
      message: "Local workspace",
      rows: [],
    };
  if (/^\/(customers|suppliers)\/[^/]+\/ledger$/.test(path)) {
    const ledger = obj(views[path]);
    if (!views[path]) return;
    const from = q.get("from"),
      to = q.get("to"),
      supplier = path.startsWith("/suppliers/");
    let opening = cents(obj(ledger.summary).opening);
    const entries: Row[] = [];
    for (const entry of rows(ledger.items)) {
      const change = supplier
        ? cents(entry.credit) - cents(entry.debit)
        : cents(entry.debit) - cents(entry.credit);
      if (from && day(entry.date) < from) {
        opening += change;
        continue;
      }
      if (to && day(entry.date) > to) continue;
      entries.push(entry);
    }
    let balance = opening;
    const items = entries.map((e) => {
      balance += supplier
        ? cents(e.credit) - cents(e.debit)
        : cents(e.debit) - cents(e.credit);
      return { ...e, balance: money(balance) };
    });
    return {
      ...ledger,
      from: from || null,
      to: to || null,
      items,
      summary: {
        opening: money(opening),
        debit: total(entries, "debit"),
        credit: total(entries, "credit"),
        closing: money(balance),
      },
    };
  }
  if (path === "/replacements/options") {
    const options = obj(
      views[`${path}?source=${q.get("source") || "CUSTOMER_WARRANTY"}`],
    );
    const search = (q.get("q") || "").toLowerCase();
    return {
      ...options,
      units: rows(options.units).filter(
        (u) =>
          !search ||
          [u.label, u.customer, u.invoice]
            .map(str)
            .join(" ")
            .toLowerCase()
            .includes(search),
      ),
    };
  }
  if (path === "/dashboard" || path === "/reports/financial-summary") {
    const base = obj(views["/dashboard"]);
    if (!views["/dashboard"]) return;
    const from = q.get("from") || date(),
      to = q.get("to") || date(),
      inRange = (d: string) => d >= from && d <= to;
    const result = copy(base),
      finances = obj(result.financials);
    const trend = rows(base.salesTrend).filter((p) => inRange(str(p.date)));
    const changes = deltas.filter((d) => inRange(d.date));
    if (result.financials) {
      finances.todaySales = add(
        total(trend, "amount"),
        changes.reduce((n, d) => n + d.sale, 0n),
      );
      finances.grossProfit = add(
        total(trend, "grossProfit"),
        changes.reduce((n, d) => n + d.sale - d.cost, 0n),
      );
      finances.todayPurchases = add(
        Array.isArray(obj(views["/mobile/facts"]).purchases)
          ? total(
              rows(obj(views["/mobile/facts"]).purchases).filter((p) =>
                inRange(day(p.date)),
              ),
              "amount",
            )
          : total(
              rows(obj(views["/purchases"]).items).filter(
                (p) =>
                  p.syncStatus !== "PENDING" && inRange(day(p.purchaseDate)),
              ),
              "total",
            ),
        changes.reduce((n, d) => n + d.purchase, 0n),
      );
      if (views["/customers"])
        finances.customerDues = money(
          rows(obj(views["/customers"]).items).reduce(
            (n, c) => n + (cents(c.due) > 0n ? cents(c.due) : 0n),
            0n,
          ),
        );
      finances.supplierDues = add(
        finances.supplierDues,
        [...supplierDelta.values()].reduce((n, d) => n + d, 0n),
      );
      finances.salesIncome = add(
        finances.salesIncome,
        deltas.reduce((n, d) => n + d.sale, 0n),
      );
      finances.salesProfit = add(
        finances.salesProfit,
        deltas.reduce((n, d) => n + d.sale - d.cost, 0n),
      );
      if (views["/mobile/facts"])
        finances.availableStockPurchaseValue = money(
          (rows(obj(views["/mobile/facts"]).batches).reduce(
            (n, b) =>
              n +
              (micro(b.unitCost) *
                BigInt(Math.round(Number(b.quantity) * 1000))) /
                1000n,
            0n,
          ) +
            5000n) /
            10000n,
        );
      // Server snapshot carries dated cash/transport facts, independent of UI filters.
      if (views["/mobile/facts"])
        finances.todayCashReceived = add(
          total(
            rows(obj(views["/mobile/facts"]).cash).filter((r) =>
              inRange(day(r.date)),
            ),
            "amount",
          ),
          changes.reduce((n, d) => n + d.cash, 0n),
        );
      if (views["/expenses"])
        finances.transportExpenses = add(
          total(
            rows(obj(views["/expenses"]).items).filter(
              (r) =>
                r.source === "PURCHASE_TRANSPORT" &&
                r.syncStatus !== "PENDING" &&
                inRange(day(r.date)),
            ),
            "amount",
          ),
          changes.reduce((n, d) => n + d.transport, 0n),
        );
    }
    const products = rows(obj(views["/products"]).items),
      counts = obj(result.counts),
      stock = obj(result.stock);
    if (views["/customers"])
      counts.customers = rows(obj(views["/customers"]).items).length;
    if (views["/products"]) {
      counts.products = products.filter((p) => p.active !== false).length;
      counts.availableStock = str(
        products.reduce((n, p) => n + Number(obj(p.stock).available || 0), 0),
      );
      const low = products.filter(
        (p) =>
          p.active !== false &&
          Number(obj(p.stock).available) <= Number(p.lowStockThreshold || 0),
      );
      counts.lowStock = low.length;
      result.lowStock = low.slice(0, 5).map((p) => ({
        id: p.id,
        name: p.name,
        quantity: str(obj(p.stock).available),
        threshold: str(p.lowStockThreshold || 0),
      }));
      stock.batteriesAvailable = products
        .filter((p) => obj(p.type).trackingKind === "BATTERY_UNIT")
        .reduce((n, p) => n + Number(obj(p.stock).available || 0), 0);
      stock.partsAvailable = str(
        products
          .filter((p) => obj(p.type).trackingKind !== "BATTERY_UNIT")
          .reduce((n, p) => n + Number(obj(p.stock).available || 0), 0),
      );
    }
    result.businessDate = date();
    result.from = from;
    result.to = to;
    if (views["/sales"])
      result.recentSales = rows(obj(views["/sales"]).items)
        .filter((s) => inRange(day(s.saleDate)))
        .slice(0, 5)
        .map((s) => ({
          ...s,
          soldAt: s.saleDate,
          customer: obj(s.customer).name,
          customerId: obj(s.customer).id,
          customerPhone: obj(s.customer).phone,
        }));
    return path === "/reports/financial-summary" ? finances : result;
  }
  if (
    [
      "/products",
      "/customers",
      "/suppliers",
      "/sales",
      "/purchases",
      "/expenses",
      "/replacements",
    ].includes(path) ||
    /^\/customers\/[^/]+\/sales$/.test(path) ||
    path === "/suppliers/ledger"
  ) {
    if (!views[path]) return;
    let items = rows(obj(views[path]).items);
    const search = (q.get("q") || "").trim().toLowerCase();
    items = items.filter(
      (r) =>
        !search ||
        [
          r.name,
          r.localReference,
          r.model,
          r.phone,
          r.invoiceNumber,
          obj(r.customer).name,
          obj(r.customer).phone,
          r.number,
          r.description,
        ]
          .map(str)
          .join(" ")
          .toLowerCase()
          .includes(search),
    );
    const type = q.get("typeId") || q.get("productTypeId"),
      category = q.get("categoryId"),
      status = q.get("status");
    if (type)
      items = items.filter(
        (r) => obj(r.type).id === type || r.productTypeId === type,
      );
    if (category) items = items.filter((r) => obj(r.category).id === category);
    if (q.get("saleId")) items = items.filter((r) => r.id === q.get("saleId"));
    if (path === "/customers" && q.get("credit") === "due")
      items = items.filter((r) => cents(r.due) > 0n);
    if (path === "/customers" && q.get("credit") === "clear")
      items = items.filter((r) => cents(r.due) <= 0n);
    if (q.get("brandIds")) {
      const brands = new Set(q.get("brandIds")!.split(","));
      items = items.filter((r) => brands.has(str(obj(r.brand).id)));
    }
    if (status && status !== "all")
      items = items.filter((r) =>
        status === "active"
          ? r.active !== false
          : status === "inactive"
            ? r.active === false
            : status === "due"
              ? cents(r.due) > 0n
              : status === "paid"
                ? cents(r.due) === 0n
                : r.status === status,
      );
    const from = q.get("from"),
      to = q.get("to");
    if (from || to)
      items = items.filter((r) => {
        const when = day(r.date || r.saleDate || r.purchaseDate);
        return (!from || when >= from) && (!to || when <= to);
      });
    const page = Math.max(1, Number(q.get("page")) || 1),
      size = Math.min(100, Math.max(1, Number(q.get("pageSize")) || 20));
    const result = {
      ...obj(views[path]),
      items: items.slice((page - 1) * size, page * size),
      total: items.length,
      page,
      pageSize: size,
    };
    if (path === "/customers") {
      const all = rows(obj(views[path]).items);
      Object.assign(result, {
        summary: {
          ...obj(obj(views[path]).summary),
          total: all.length,
          active: all.filter((c) => c.active !== false).length,
          credit: all.filter((c) => cents(c.due) > 0n).length,
          totalSales: total(all, "totalSales"),
          totalDue: money(
            all.reduce(
              (n, c) => n + (cents(c.due) > 0n ? cents(c.due) : 0n),
              0n,
            ),
          ),
        },
      });
    }
    if (path === "/expenses")
      Object.assign(result, {
        summary: {
          total: total(items, "amount"),
          byCategory: [...new Set(items.map((r) => str(r.category)))].map(
            (name) => ({
              name,
              amount: total(
                items.filter((r) => r.category === name),
                "amount",
              ),
            }),
          ),
        },
      });
    return result;
  }
  return views[route] ?? views[path];
}

export function localResult(
  snapshot: ReplicaSnapshot,
  commands: LocalCommand[],
  route: string,
  body: unknown,
  id: string,
): Row {
  const b = obj(body),
    { views } = projectReplica(snapshot, commands),
    records = (path: string) => rows(obj(views[path]).items);
  const grants = new Set(
    Array.isArray(obj(views["/auth/me"]).permissions)
      ? (obj(views["/auth/me"]).permissions as string[])
      : [],
  );
  const replacementStage = route.match(/^\/replacements\/([^/]+)\/status$/);
  const permission =
    route === "/settings/shop"
      ? "settings.manage"
      : route === "/replacements"
        ? b.source === "BEFORE_SALE"
          ? "replacements.intake.stock"
          : "replacements.intake.customer"
        : replacementStage
          ? (
              {
                FAULTY: "replacements.resolve",
                SENT: "replacements.dispatch",
                RECEIVED: "replacements.receive",
                DELIVERED: "replacements.deliver",
              } as Record<string, string>
            )[str(b.status)]
          : route === "/sales/complete"
            ? "sales.manage"
            : route === "/purchases/receive"
              ? "purchases.manage"
              : route === "/products" || route === "/categories"
                ? "catalog.write"
                : route === "/suppliers"
                  ? "parties.suppliers"
                  : route === "/customers"
                    ? "parties.customers"
                    : route === "/expenses"
                      ? "finance.write"
                      : "payments.customer";
  if (
    !grants.has(permission) &&
    !(route === "/customers" && grants.has("sales.manage"))
  )
    throw new Error("You do not have permission for this operation.");
  if (route === "/settings/shop") {
    const profile = obj(views[route]);
    if (Number(profile.version) !== b.version)
      throw new Error("Shop profile changed. Reload before saving.");
    if (
      !str(b.name).trim() ||
      str(b.name).length > 120 ||
      str(b.address).length > 500 ||
      str(b.phone).length > 50
    )
      throw new Error("Enter valid shop details.");
    return {
      value: {
        ...obj(profile.value),
        name: b.name,
        address: b.address,
        phone: b.phone,
      },
      version: Number(b.version) + 1,
    };
  }
  if (["/customers", "/suppliers"].includes(route)) {
    if (
      !str(b.name).trim() ||
      str(b.name).length > 160 ||
      !/^\+?[0-9][0-9 ()-]{5,29}$/.test(str(b.phone))
    )
      throw new Error("Enter a valid contact name and phone.");
    if (route === "/customers" && !str(b.address).trim())
      throw new Error("Customer address is required.");
    return {
      ...b,
      id,
      active: true,
      createdAt: new Date().toISOString(),
      due: "0.00",
      totalSales: "0.00",
      productType:
        rows(views["/suppliers/product-types"]).find(
          (t) => t.id === b.productTypeId,
        ) || null,
    };
  }
  if (route === "/categories") {
    if (
      !rows(obj(views["/catalog"]).types).some((t) => t.id === b.typeId) ||
      !str(b.name).trim()
    )
      throw new Error("Select a category and enter a product name.");
    const existing = rows(obj(views["/catalog"]).categories).find(
      (c) =>
        str(c.name).trim().toLowerCase() === str(b.name).trim().toLowerCase(),
    );
    return {
      id: existing?.id || id,
      name: str(b.name).trim(),
      typeIds: [
        ...new Set([
          ...(Array.isArray(existing?.typeIds) ? existing.typeIds : []),
          b.typeId,
        ]),
      ],
      productCount: 0,
    };
  }
  if (route === "/products") {
    const type = rows(obj(views["/catalog"]).types).find(
      (t) => t.id === b.typeId,
    );
    if (!type || !str(b.name).trim())
      throw new Error("Select a product category and enter a product name.");
    return {
      ...b,
      id,
      type,
      model: b.model || "",
      category: { id: b.categoryId || id, name: b.category || b.name },
      brand: null,
      active: true,
      stock: {
        available: "0",
        total: "0",
        reserved: "0",
        replaceable: "0",
        sentToCompany: "0",
      },
    };
  }
  if (route === "/sales/complete" || route === "/purchases/receive") {
    const sale = route === "/sales/complete",
      items = rows(b.items);
    if (!items.length) throw new Error("Add at least one product.");
    const when = day(b.saleDate || b.purchaseDate);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(when) ||
      !Number.isFinite(Date.parse(when)) ||
      new Date(when).toISOString().slice(0, 10) !== when
    )
      throw new Error("Enter a valid transaction date.");
    if (!sale && !str(b.reference).trim())
      throw new Error("Purchase reference is required.");
    const contacts = sale ? records("/customers") : records("/suppliers");
    if (
      !contacts.some(
        (c) =>
          c.id === (sale ? b.customerId : b.supplierId) && c.active !== false,
      )
    )
      throw new Error("Select an active contact.");
    let value = 0n,
      quantity = 0;
    const required = new Map<string, number>();
    for (const item of items) {
      const qty = Number(item.quantity);
      if (
        !Number.isInteger(qty) ||
        qty < 1 ||
        qty > 10000 ||
        cents(item.unitPrice) < 0n
      )
        throw new Error("Enter valid quantities and prices.");
      const p = records("/products").find((p) => p.id === item.productId);
      if (!p || p.active === false) throw new Error("Product is unavailable.");
      required.set(
        str(item.productId),
        (required.get(str(item.productId)) || 0) + qty,
      );
      value += cents(item.unitPrice) * BigInt(qty);
      quantity += qty;
    }
    if (sale)
      for (const [product, qty] of required) {
        const available = Number(
          obj(records("/products").find((p) => p.id === product)?.stock)
            .available || 0,
        );
        if (qty > available)
          throw new Error(
            "Not enough stock on this device. Sync or reduce the quantity.",
          );
      }
    const paid = cents(b.paidAmount);
    if (paid < 0n || paid > value)
      throw new Error("Payment must be between zero and the total.");
    if (
      (paid > 0n || cents(b.transportAmount) > 0n) &&
      !grants.has("finance.write")
    )
      throw new Error("Recording a payment requires finance permission.");
    if (required.size !== items.length)
      throw new Error("Combine the same product into one line.");
    const allocations: Row[] = [],
      localBatches: Row[] = [];
    let cost = 0n;
    for (const item of items) {
      let remaining = Number(item.quantity);
      if (sale) {
        if (cents(item.unitPrice) <= 0n)
          throw new Error("Sale price must be positive.");
        for (const batch of rows(obj(views["/mobile/facts"]).batches).filter(
          (r) => r.productId === item.productId && day(r.date) <= when,
        )) {
          const used = Math.min(remaining, Number(batch.quantity));
          if (used <= 0) continue;
          allocations.push({ batchId: batch.id, quantity: used });
          cost += micro(batch.unitCost) * BigInt(used);
          remaining -= used;
          if (!remaining) break;
        }
        if (remaining)
          throw new Error(
            "Not enough dated stock on this device. Sync stock before this sale.",
          );
      } else
        localBatches.push({
          id: `${id}:${item.productId}`,
          productId: item.productId,
          date: when,
          unitCost: item.unitPrice,
          quantity: remaining,
        });
    }
    const reference = offlineReference(id);
    return {
      id,
      ...(sale
        ? {
            invoiceNumber: reference,
            customerId: b.customerId,
            subtotal: money(value),
          }
        : {
            number: reference,
            receiptId: id,
            status: "LOCAL",
            transportAmount: b.transportAmount || "0.00",
          }),
      total: money(value),
      paid: money(paid),
      due: money(value - paid),
      quantity,
      syncStatus: "PENDING",
      localCost: money((cost + 5000n) / 10000n),
      localAllocations: allocations,
      localBatches,
    };
  }
  if (route === "/expenses" || /^\/customers\/[^/]+\/payments$/.test(route)) {
    if (cents(b.amount) <= 0n) throw new Error("Amount must be positive.");
    return { id, ...b, amount: money(cents(b.amount)), syncStatus: "PENDING" };
  }
  if (route === "/replacements") {
    const options = obj(views[`/replacements/options?source=${str(b.source)}`]),
      available = rows(options.units),
      selected = available.find((u) => u.id === b.unitId);
    const quantity = Number(b.quantity || 1);
    if (
      !selected ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100
    )
      throw new Error("Select available battery units for this claim.");
    if (!rows(options.suppliers).some((s) => s.id === b.supplierId))
      throw new Error("Select a supplier.");
    const units = [
      selected,
      ...available.filter(
        (u) => u.id !== selected.id && u.productId === selected.productId,
      ),
    ].slice(0, quantity);
    if (units.length !== quantity)
      throw new Error("Not enough eligible units on this device.");
    return {
      id: b.id,
      number: offlineReference(b.id),
      source: b.source,
      status: "FAULTY",
      version: 1,
      product: selected.label,
      serial: selected.label,
      customer: selected.customer || null,
      phone: null,
      invoice: selected.invoice || null,
      supplier: rows(options.suppliers).find((s) => s.id === b.supplierId)
        ?.name,
      createdAt: new Date().toISOString(),
      sentAt: null,
      localUnits: units,
      syncStatus: "PENDING",
    };
  }
  if (replacementStage) {
    const current = records("/replacements").find(
      (r) => r.id === replacementStage[1],
    );
    if (!current || current.version !== b.version)
      throw new Error("This replacement changed. Reload before editing.");
    return {
      id: current.id,
      status: b.status,
      version: Number(current.version) + (current.status === b.status ? 0 : 1),
      syncStatus: "PENDING",
    };
  }
  throw new Error("This operation has not been enabled for local posting.");
}
