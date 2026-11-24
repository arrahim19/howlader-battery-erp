import type {
  Category,
  Contact,
  DocumentLine,
  ItemInput,
  JournalLine,
  LedgerRow,
  LocalActor,
  LocalErpState,
  LocalErpStore,
  Payment,
  Product,
  Purchase,
  PurchaseInput,
  Sale,
  SaleInput,
  BatteryUnit,
  Replacement,
  Expense,
} from "./types";
import { warrantyExpiry } from "./warranty";
export { warrantyExpiry } from "./warranty";
export * from "./types";
export { sqliteErpStore, type LocalSqlDatabase } from "./store";
export { sqliteDriveReplicaStore } from "./drive-store";

export class LocalErpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalErpError";
  }
}
function fail(code: string, message: string): never {
  throw new LocalErpError(code, message);
}
const maximum = 99999999999999999999n;
export function amount(value: string): bigint {
  if (typeof value !== "string" || !/^\d{1,18}(?:\.\d{1,2})?$/.test(value))
    fail(
      "INVALID_AMOUNT",
      "Enter a nonnegative amount with at most two decimal places.",
    );
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > maximum)
    fail("INVALID_AMOUNT", "Amount exceeds the supported limit.");
  return result;
}
export function money(value: bigint) {
  if (value > maximum || value < -maximum)
    fail("INVALID_AMOUNT", "Total exceeds the supported limit.");
  const positive = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${positive / 100n}.${String(positive % 100n).padStart(2, "0")}`;
}
const text = (value: string, limit: number, required = false) => {
  if (
    typeof value !== "string" ||
    value.trim().length > limit ||
    (required && !value.trim())
  )
    fail("INVALID_INPUT", "Missing or invalid text field.");
  return value.trim();
};
function date(value: string) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail("INVALID_DATE", "Enter a valid YYYY-MM-DD date.");
  return value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const due = (document: { total: string; paid: string }) =>
  amount(document.total) - amount(document.paid);
const assetAccounts = new Set(["1100", "1110", "1120", "1130", "1140"]);
function paymentAccount(code: string | undefined) {
  const value = code || "1100";
  if (!assetAccounts.has(value))
    fail("INVALID_ACCOUNT", "Select a supported cash or payment account.");
  return value;
}
function empty(shopId: string): LocalErpState {
  return {
    format: 2,
    shopId,
    sequence: 0,
    nextSale: 1,
    nextPurchase: 1,
    contacts: {},
    categories: {},
    products: {},
    productNames: {},
    purchases: {},
    sales: {},
    payments: {},
    batches: [],
    batteryUnits: {},
    replacements: {},
    expenses: {},
    journals: [],
    audit: [],
    commands: {},
  };
}
function getContact(state: LocalErpState, id: string, kind: Contact["kind"]) {
  const result = state.contacts[id];
  if (!result?.active || result.kind !== kind)
    fail("INVALID_CONTACT", `Select an active ${kind}.`);
  return result;
}
function getProduct(state: LocalErpState, id: string) {
  const result = state.products[id];
  if (!result?.active) fail("INVALID_PRODUCT", "Select an active product.");
  return result;
}
function lines(state: LocalErpState, values: ItemInput[]): DocumentLine[] {
  if (!Array.isArray(values) || !values.length || values.length > 100)
    fail("INVALID_ITEMS", "Enter 1–100 product lines.");
  return values.map((item) => {
    const product = getProduct(state, item.productId);
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10000
    )
      fail(
        "INVALID_QUANTITY",
        "Quantity must be an integer between 1 and 10000.",
      );
    if (
      typeof item.unitPrice !== "string" ||
      !/^\d{1,14}(?:\.\d{1,2})?$/.test(item.unitPrice)
    )
      fail("INVALID_AMOUNT", "Enter a valid unit price.");
    const unitPrice = money(amount(item.unitPrice));
    return {
      productId: product.id,
      quantity: item.quantity,
      unitPrice,
      name: product.name,
      model: product.model,
      total: money(amount(unitPrice) * BigInt(item.quantity)),
      cost: "0.00",
    };
  });
}
function post(
  state: LocalErpState,
  id: string,
  kind: string,
  at: string,
  entries: {
    account: string;
    debit?: bigint;
    credit?: bigint;
    contactId?: string;
  }[],
) {
  const result: JournalLine[] = entries
    .filter(
      (entry) => (entry.debit ?? 0n) !== 0n || (entry.credit ?? 0n) !== 0n,
    )
    .map((entry) => ({
      account: entry.account,
      debit: money(entry.debit ?? 0n),
      credit: money(entry.credit ?? 0n),
      ...(entry.contactId ? { contactId: entry.contactId } : {}),
    }));
  const balance = result.reduce(
    (sum, entry) => sum + amount(entry.debit) - amount(entry.credit),
    0n,
  );
  if (balance !== 0n)
    fail("UNBALANCED_JOURNAL", "Local transaction journal is not balanced.");
  if (result.length) state.journals.push({ id, kind, date: at, lines: result });
}
export function validateLocalState(state: LocalErpState, shopId: string) {
  if (state.format !== 2 || state.shopId !== shopId)
    fail("WRONG_SHOP", "The local database belongs to another shop or format.");
  if (state.shopProfile) {
    const { value, version } = state.shopProfile;
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !value ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 120 ||
      (value.tagLine !== undefined &&
        (typeof value.tagLine !== "string" || value.tagLine.length > 1000)) ||
      (value.tagLine2 !== undefined &&
        (typeof value.tagLine2 !== "string" || value.tagLine2.length > 1000)) ||
      typeof value.address !== "string" ||
      value.address.length > 500 ||
      typeof value.phone !== "string" ||
      value.phone.length > 50
    )
      fail("INVALID_STATE", "Invalid saved shop profile.");
  }
  if (
    !Number.isSafeInteger(state.sequence) ||
    state.sequence < 0 ||
    !Number.isSafeInteger(state.nextSale) ||
    state.nextSale < 1 ||
    !Number.isSafeInteger(state.nextPurchase) ||
    state.nextPurchase < 1
  )
    fail("INVALID_STATE", "Invalid local invoice counter.");
  for (const [id, category] of Object.entries(state.categories)) {
    if (
      category.id !== id ||
      !["QUANTITY", "BATTERY_UNIT"].includes(category.trackingKind)
    )
      fail("INVALID_STATE", "Invalid local category identity.");
  }
  for (const [id, product] of Object.entries(state.products)) {
    if (
      product.id !== id ||
      !Object.hasOwn(state.categories, product.categoryId)
    )
      fail("INVALID_STATE", "Invalid local product identity or category.");
  }
  for (const [id, contact] of Object.entries(state.contacts)) {
    if (
      contact.id !== id ||
      !["customer", "supplier"].includes(contact.kind) ||
      (contact.kind === "supplier" &&
        !Object.hasOwn(state.categories, contact.categoryId || ""))
    )
      fail("INVALID_STATE", "Invalid local contact identity or category.");
  }
  const balances = new Map<string, bigint>();
  for (const [id, name] of Object.entries(state.productNames || {})) {
    if (
      name.id !== id ||
      !state.categories[name.categoryId] ||
      !name.name.trim()
    )
      fail("INVALID_STATE", "Invalid product name or category.");
  }
  for (const journal of state.journals) {
    let check = 0n;
    for (const entry of journal.lines) {
      const debit = amount(entry.debit),
        credit = amount(entry.credit);
      if (debit > 0n && credit > 0n)
        fail(
          "INVALID_STATE",
          "A journal line cannot debit and credit at once.",
        );
      check += debit - credit;
      balances.set(
        entry.account,
        (balances.get(entry.account) ?? 0n) + debit - credit,
      );
    }
    if (check !== 0n)
      fail("UNBALANCED_JOURNAL", "Stored transaction journal is not balanced.");
  }
  const inventory = state.batches.reduce((sum, batch) => {
    if (
      !Number.isSafeInteger(batch.available) ||
      !Number.isSafeInteger(batch.received) ||
      batch.available < 0 ||
      batch.available > batch.received ||
      !state.products[batch.productId] ||
      !state.purchases[batch.purchaseId]
    )
      fail("INVALID_STATE", "Invalid local stock batch.");
    if (
      state.categories[state.products[batch.productId].categoryId]
        .trackingKind === "BATTERY_UNIT"
    ) {
      const units = Object.values(state.batteryUnits).filter(
        (unit) => unit.batchId === batch.id,
      );
      const available = units.filter(
        (unit) =>
          unit.state === "AVAILABLE" &&
          unit.owner === "SHOP" &&
          unit.custody === "SHOP",
      ).length;
      if (available !== batch.available)
        fail(
          "INVALID_STATE",
          "Battery unit availability does not match its batch.",
        );
      return (
        sum +
        BigInt(
          units.filter(
            (unit) => unit.owner === "SHOP" && unit.state !== "RETIRED",
          ).length,
        ) *
          amount(batch.unitPrice)
      );
    }
    return sum + BigInt(batch.available) * amount(batch.unitPrice);
  }, 0n);
  let receivable = 0n,
    payable = 0n;
  for (const sale of Object.values(state.sales)) {
    if (due(sale) < 0n)
      fail("INVALID_STATE", "Sale payment exceeds its total.");
    receivable += due(sale);
  }
  for (const purchase of Object.values(state.purchases)) {
    if (due(purchase) < 0n)
      fail("INVALID_STATE", "Purchase payment exceeds its total.");
    payable += due(purchase);
  }
  if (
    (balances.get("1300") ?? 0n) !== inventory ||
    (balances.get("1200") ?? 0n) !== receivable ||
    (balances.get("2100") ?? 0n) !== -payable
  )
    fail(
      "INVALID_STATE",
      "Stock or party balances do not match the local accounting journal.",
    );
  const serials = new Set<string>();
  for (const [id, unit] of Object.entries(state.batteryUnits)) {
    const batch = state.batches.find((entry) => entry.id === unit.batchId);
    if (
      unit.id !== id ||
      !batch ||
      batch.productId !== unit.productId ||
      state.categories[state.products[unit.productId].categoryId]
        .trackingKind !== "BATTERY_UNIT"
    )
      fail("INVALID_STATE", "Invalid battery identity or batch.");
    if (unit.serialNumber) {
      const serial = unit.serialNumber.toUpperCase();
      if (serials.has(serial))
        fail("INVALID_STATE", "Duplicate battery serial number.");
      serials.add(serial);
    }
    if (
      unit.owner === "CUSTOMER" &&
      (!unit.customerId ||
        !unit.saleId ||
        state.sales[unit.saleId]?.customerId !== unit.customerId)
    )
      fail("INVALID_STATE", "Customer battery is not linked to its invoice.");
  }
}

/** Install a verified/decrypted cloud snapshot into a NEW device database.
 * Google identity/key/hash verification belongs to the trusted sync host before
 * this call. Never use this as an overwrite/reconciliation operation.
 */
export async function restoreNewLocalShop(
  store: LocalErpStore,
  approvedShopId: string,
  snapshot: LocalErpState,
) {
  validateLocalState(snapshot, approvedShopId);
  const existing = await store.load(approvedShopId);
  if (existing) {
    validateLocalState(existing.state, approvedShopId);
    const local = existing.state;
    if (
      local.sequence ||
      local.audit.length ||
      local.batches.length ||
      local.journals.length ||
      [
        local.contacts,
        local.products,
        local.categories,
        local.sales,
        local.purchases,
        local.payments,
        local.commands,
        local.batteryUnits,
        local.replacements,
        local.expenses,
      ].some((records) => Object.keys(records).length)
    )
      fail(
        "LOCAL_NOT_EMPTY",
        "This device already has local records. Retain them and reconcile before restoring.",
      );
  }
  if (
    !(await store.commit(
      approvedShopId,
      existing?.revision ?? null,
      clone(snapshot),
    ))
  )
    fail(
      "LOCAL_CHANGED",
      "Local data changed during recovery. Nothing was overwritten.",
    );
}

/** Local business engine used by the Google-enrolled device workspace.
 * Returns, financial reversals and account adjustments are not implemented;
 * callers must not emulate them by editing stored balances or inventory.
 */
export class LocalErp {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: LocalErpStore,
    readonly shopId: string,
    private readonly actor: LocalActor,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    if (!shopId || !actor.id)
      fail(
        "INVALID_IDENTITY",
        "An approved local shop and actor are required.",
      );
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private async load() {
    let current = await this.store.load(this.shopId);
    if (!current) {
      await this.store.commit(this.shopId, null, empty(this.shopId));
      current = await this.store.load(this.shopId);
    }
    if (!current)
      fail("STORAGE_UNAVAILABLE", "Local database could not be opened.");
    if ((current.state.format as number) === 1) {
      const upgraded = {
        ...current.state,
        format: 2 as const,
        batteryUnits: {},
        replacements: {},
        expenses: {},
        products: Object.fromEntries(
          Object.entries(current.state.products).map(([id, product]) => [
            id,
            { ...product, warrantyMonths: 0 },
          ]),
        ),
      };
      validateLocalState(upgraded, this.shopId);
      if (!(await this.store.commit(this.shopId, current.revision, upgraded)))
        fail("LOCAL_CHANGED", "Local database changed during version upgrade.");
      current = { state: upgraded, revision: current.revision + 1 };
    }
    validateLocalState(current.state, this.shopId);
    return current;
  }
  private execute<T>(
    operation: string,
    key: string,
    input: unknown,
    permission: string,
    apply: (state: LocalErpState, sequence: number, now: string) => T,
  ): Promise<T> {
    return this.serial(async () => {
      if (!this.actor.permissions.includes(permission))
        fail(
          "ACCESS_DENIED",
          "Your account cannot perform this local operation.",
        );
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          key,
        )
      )
        fail("INVALID_KEY", "A stable UUID request key is required.");
      const current = await this.load();
      const fingerprint = stable({ operation, input });
      const recordKey = this.actor.id + ":" + key;
      const previous = current.state.commands[recordKey];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail(
            "KEY_REUSED",
            "This request key already belongs to a different operation.",
          );
        return clone(previous.result as T);
      }
      const draft = clone(current.state);
      if (draft.audit.some((entry) => entry.id === key))
        fail(
          "KEY_REUSED",
          "Another local actor already used this request identifier.",
        );
      const now = this.clock();
      const result = apply(draft, ++draft.sequence, now);
      draft.commands[recordKey] = { fingerprint, result: clone(result) };
      draft.audit.push({ id: key, actorId: this.actor.id, operation, at: now });
      validateLocalState(draft, this.shopId);
      if (!(await this.store.commit(this.shopId, current.revision, draft)))
        fail(
          "LOCAL_CHANGED",
          "Another local window changed the database. Retry using the same request key.",
        );
      return clone(result);
    });
  }
  snapshot() {
    return this.serial(async () => clone((await this.load()).state));
  }
  saveShopProfile(
    key: string,
    input: {
      name: string;
      tagLine?: string;
      tagLine2?: string;
      address: string;
      phone: string;
      version: number;
    },
  ) {
    return this.execute(
      "SHOP_PROFILE_UPDATE",
      key,
      input,
      "settings.manage",
      (state) => {
        if (!Number.isSafeInteger(input.version) || input.version < 0)
          fail("INVALID_INPUT", "Invalid shop profile version.");
        if ((state.shopProfile?.version ?? 0) !== input.version)
          fail(
            "VERSION_CONFLICT",
            "Shop profile changed. Reload the page before saving again.",
          );
        const profile = {
          value: {
            name: text(input.name, 120, true),
            ...(input.tagLine === undefined
              ? state.shopProfile?.value.tagLine === undefined
                ? {}
                : { tagLine: state.shopProfile.value.tagLine }
              : { tagLine: text(input.tagLine, 1000) }),
            ...(input.tagLine2 === undefined
              ? state.shopProfile?.value.tagLine2 === undefined
                ? {}
                : { tagLine2: state.shopProfile.value.tagLine2 }
              : { tagLine2: text(input.tagLine2, 1000) }),
            address: text(input.address, 500),
            phone: text(input.phone, 50),
          },
          version: input.version + 1,
        };
        state.shopProfile = profile;
        return profile;
      },
    );
  }
  createCategory(
    key: string,
    input: { name: string; trackingKind: Category["trackingKind"] },
  ) {
    return this.execute(
      "CATEGORY_CREATE",
      key,
      input,
      "catalog.write",
      (state) => {
        if (
          !["QUANTITY", "BATTERY_UNIT"].includes(input.trackingKind) ||
          state.categories[key]
        )
          fail("INVALID_CATEGORY", "Invalid or duplicate product category.");
        const category: Category = {
          id: key,
          name: text(input.name, 120, true),
          trackingKind: input.trackingKind,
        };
        state.categories[key] = category;
        return category;
      },
    );
  }
  createContact(
    key: string,
    input: {
      kind: Contact["kind"];
      name: string;
      phone: string;
      address?: string;
      company?: string;
      categoryId?: string;
    },
  ) {
    return this.execute(
      "CONTACT_CREATE",
      key,
      input,
      input.kind === "supplier" ? "parties.suppliers" : "parties.customers",
      (state) => {
        if (
          !["customer", "supplier"].includes(input.kind) ||
          state.contacts[key]
        )
          fail("INVALID_CONTACT", "Invalid or duplicate contact.");
        if (
          input.kind === "supplier" &&
          !state.categories[input.categoryId || ""]
        )
          fail("INVALID_CATEGORY", "Select the supplier's product category.");
        const contact: Contact = {
          id: key,
          kind: input.kind,
          name: text(input.name, 120, true),
          phone: text(input.phone, 50, true),
          address:
            input.kind === "customer" ? text(input.address || "", 500) : "",
          company: text(input.company || "", 120),
          categoryId: input.kind === "supplier" ? input.categoryId! : null,
          active: true,
        };
        state.contacts[key] = contact;
        return contact;
      },
    );
  }
  createProduct(
    key: string,
    input: {
      categoryId: string;
      name: string;
      model?: string;
      unit?: string;
      warrantyMonths?: number;
    },
  ) {
    return this.execute(
      "PRODUCT_CREATE",
      key,
      input,
      "catalog.write",
      (state) => {
        if (!state.categories[input.categoryId] || state.products[key])
          fail("INVALID_PRODUCT", "Invalid category or duplicate product.");
        if (
          !Number.isInteger(input.warrantyMonths ?? 0) ||
          (input.warrantyMonths ?? 0) < 0 ||
          (input.warrantyMonths ?? 0) > 120
        )
          fail("INVALID_WARRANTY", "Warranty must be 0–120 months.");
        const product: Product = {
          id: key,
          categoryId: input.categoryId,
          name: text(input.name, 120, true),
          model: text(input.model || "", 120) || null,
          unit: text(input.unit || "pcs", 30, true),
          active: true,
          warrantyMonths: input.warrantyMonths ?? 0,
        };
        state.products[key] = product;
        return product;
      },
    );
  }
  createProductName(key: string, input: { categoryId: string; name: string }) {
    return this.execute(
      "PRODUCT_NAME_CREATE",
      key,
      input,
      "catalog.write",
      (state) => {
        if (!state.categories[input.categoryId])
          fail("INVALID_CATEGORY", "Select a product category.");
        const name = text(input.name, 120, true);
        const names = state.productNames ?? (state.productNames = {});
        const existing = Object.values(names).find(
          (n) =>
            n.categoryId === input.categoryId &&
            n.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing) return existing;
        const entry = { id: key, name, categoryId: input.categoryId };
        names[key] = entry;
        return entry;
      },
    );
  }
  receivePurchase(key: string, input: PurchaseInput) {
    return this.execute(
      "PURCHASE_RECEIVE",
      key,
      input,
      "purchases.manage",
      (state, sequence, now) => {
        if (state.purchases[key])
          fail("KEY_REUSED", "Purchase identifier already exists.");
        const supplier = getContact(state, input.supplierId, "supplier");
        const items = lines(state, input.items);
        if (
          items.some(
            (line) =>
              state.products[line.productId].categoryId !== supplier.categoryId,
          )
        )
          fail(
            "CATEGORY_MISMATCH",
            "All purchase items must match the supplier's category.",
          );
        const total = items.reduce((sum, line) => sum + amount(line.total), 0n),
          paid = amount(input.paid),
          transport = amount(input.transport || "0");
        if (paid > total)
          fail("OVERPAYMENT", "Purchase payment exceeds its item total.");
        if (
          (paid > 0n || transport > 0n) &&
          !this.actor.permissions.includes("finance.read")
        )
          fail(
            "ACCESS_DENIED",
            "Recording payment or transport requires finance permission.",
          );
        const purchase: Purchase = {
          id: key,
          number: "PUR-" + String(state.nextPurchase++).padStart(6, "0"),
          supplierId: supplier.id,
          date: date(input.date),
          sequence,
          reference: text(input.reference, 160, true),
          total: money(total),
          paid: money(paid),
          transport: money(transport),
          lines: items,
          createdAt: now,
        };
        state.purchases[key] = purchase;
        let batteryCount = 0;
        items.forEach((line, index) => {
          const batch = {
            id: key + ":" + index,
            purchaseId: key,
            productId: line.productId,
            date: purchase.date,
            sequence,
            received: line.quantity,
            available: line.quantity,
            unitPrice: line.unitPrice,
          };
          state.batches.push(batch);
          if (
            state.categories[state.products[line.productId].categoryId]
              .trackingKind !== "BATTERY_UNIT"
          )
            return;
          batteryCount += line.quantity;
          if (batteryCount > 500)
            fail("INVALID_QUANTITY", "Receive at most 500 batteries at once.");
          const raw = input.items[index];
          const months =
            raw.warrantyMonths ?? state.products[line.productId].warrantyMonths;
          if (!Number.isInteger(months) || months < 0 || months > 120)
            fail("INVALID_WARRANTY", "Warranty must be 0–120 months.");
          if (
            raw.batteryIdentities &&
            raw.batteryIdentities.length !== line.quantity
          )
            fail(
              "INVALID_IDENTITIES",
              "Battery identities must match the received quantity.",
            );
          for (let unitIndex = 0; unitIndex < line.quantity; unitIndex++) {
            const identity = raw.batteryIdentities?.[unitIndex];
            const serial = text(identity?.serialNumber || "", 120) || null;
            if (
              serial &&
              Object.values(state.batteryUnits).some(
                (unit) =>
                  unit.serialNumber?.toUpperCase() === serial.toUpperCase(),
              )
            )
              fail("DUPLICATE_SERIAL", "Battery serial already exists.");
            const id = batch.id + ":unit:" + unitIndex;
            state.batteryUnits[id] = {
              id,
              batchId: batch.id,
              productId: line.productId,
              serialNumber: serial,
              productionDate: identity?.productionDate
                ? date(identity.productionDate)
                : null,
              state: "AVAILABLE",
              owner: "SHOP",
              custody: "SHOP",
              warrantyMonths: months,
              saleId: null,
              customerId: null,
              coverageStart: null,
              coverageEnd: null,
              replacementId: null,
              parentUnitId: null,
            };
          }
        });
        const asset = paymentAccount(input.paymentAccount);
        post(state, key, "PURCHASE", purchase.date, [
          { account: "1300", debit: total },
          { account: "2100", credit: total, contactId: supplier.id },
          { account: "2100", debit: paid, contactId: supplier.id },
          { account: asset, credit: paid },
          { account: "5200", debit: transport },
          { account: asset, credit: transport },
        ]);
        return purchase;
      },
    );
  }
  completeSale(key: string, input: SaleInput) {
    return this.execute(
      "SALE_COMPLETE",
      key,
      input,
      "sales.manage",
      (state, sequence, now) => {
        if (state.sales[key])
          fail("KEY_REUSED", "Sale identifier already exists.");
        const customer = getContact(state, input.customerId, "customer");
        const items = lines(state, input.items);
        if (items.some((line) => amount(line.unitPrice) === 0n))
          fail("INVALID_AMOUNT", "Sale unit prices must be greater than zero.");
        const total = items.reduce((sum, line) => sum + amount(line.total), 0n),
          paid = amount(input.paid);
        if (paid > total)
          fail("OVERPAYMENT", "Sale payment exceeds its total.");
        if (paid > 0n && !this.actor.permissions.includes("finance.read"))
          fail(
            "ACCESS_DENIED",
            "Recording payment requires finance permission.",
          );
        let cost = 0n;
        const soldDate = date(input.date);
        let batteryCount = 0;
        for (let index = 0; index < items.length; index++) {
          const line = items[index];
          let remaining = line.quantity,
            lineCost = 0n;
          if (
            state.categories[state.products[line.productId].categoryId]
              .trackingKind === "BATTERY_UNIT"
          ) {
            batteryCount += line.quantity;
            if (batteryCount > 500)
              fail("INVALID_QUANTITY", "Sell at most 500 batteries at once.");
            const selected = input.items[index].unitIds;
            if (
              selected &&
              (selected.length !== line.quantity ||
                new Set(selected).size !== selected.length)
            )
              fail(
                "INVALID_IDENTITIES",
                "Select distinct battery units matching quantity.",
              );
            const candidates = Object.values(state.batteryUnits)
              .filter(
                (unit) =>
                  unit.productId === line.productId &&
                  unit.state === "AVAILABLE" &&
                  unit.owner === "SHOP" &&
                  unit.custody === "SHOP" &&
                  state.batches.find((batch) => batch.id === unit.batchId)!
                    .date <= soldDate,
              )
              .sort((a, b) => {
                const x = state.batches.find(
                    (batch) => batch.id === a.batchId,
                  )!,
                  y = state.batches.find((batch) => batch.id === b.batchId)!;
                return (
                  x.date.localeCompare(y.date) ||
                  x.sequence - y.sequence ||
                  a.id.localeCompare(b.id)
                );
              });
            const units = selected
              ? selected.map((id) => candidates.find((unit) => unit.id === id))
              : candidates.slice(0, line.quantity);
            if (units.length !== line.quantity || units.some((unit) => !unit))
              fail(
                "INSUFFICIENT_STOCK",
                "Selected batteries are not available for this sale date.",
              );
            line.unitIds = [];
            for (const unit of units as BatteryUnit[]) {
              const batch = state.batches.find(
                (entry) => entry.id === unit.batchId,
              )!;
              unit.state = "SOLD";
              unit.owner = "CUSTOMER";
              unit.custody = "CUSTOMER";
              unit.saleId = key;
              unit.customerId = customer.id;
              unit.coverageStart = soldDate;
              unit.coverageEnd = warrantyExpiry(soldDate, unit.warrantyMonths);
              batch.available--;
              lineCost += amount(batch.unitPrice);
              line.unitIds.push(unit.id);
            }
            line.cost = money(lineCost);
            cost += lineCost;
            continue;
          }
          const batches = state.batches
            .filter(
              (batch) =>
                batch.productId === line.productId &&
                batch.available > 0 &&
                batch.date <= soldDate,
            )
            .sort(
              (a, b) =>
                a.date.localeCompare(b.date) ||
                a.sequence - b.sequence ||
                a.id.localeCompare(b.id),
            );
          for (const batch of batches) {
            const take = Math.min(remaining, batch.available);
            batch.available -= take;
            remaining -= take;
            lineCost += BigInt(take) * amount(batch.unitPrice);
            if (!remaining) break;
          }
          if (remaining)
            fail(
              "INSUFFICIENT_STOCK",
              "There is not enough stock for this sale. No local transaction was committed.",
            );
          line.cost = money(lineCost);
          cost += lineCost;
        }
        const sale: Sale = {
          id: key,
          invoiceNumber: "HB-" + String(state.nextSale++).padStart(4, "0"),
          notes: text(input.notes ?? "", 2000),
          customerId: customer.id,
          date: date(input.date),
          sequence,
          total: money(total),
          paid: money(paid),
          cost: money(cost),
          lines: items,
          createdAt: now,
        };
        state.sales[key] = sale;
        post(state, key, "SALE", sale.date, [
          { account: "1200", debit: total, contactId: customer.id },
          { account: "4100", credit: total },
          { account: "5100", debit: cost },
          { account: "1300", credit: cost },
          { account: paymentAccount(input.paymentAccount), debit: paid },
          { account: "1200", credit: paid, contactId: customer.id },
        ]);
        return sale;
      },
    );
  }
  recordPayment(
    key: string,
    input: {
      contactId: string;
      date: string;
      amount: string;
      paymentAccount?: string;
    },
  ) {
    return this.execute(
      "PARTY_PAYMENT",
      key,
      input,
      "finance.read",
      (state, sequence, now) => {
        const contact = state.contacts[input.contactId];
        if (!contact?.active)
          fail("INVALID_CONTACT", "Select an active contact.");
        const documents =
          contact.kind === "customer"
            ? Object.values(state.sales).filter(
                (sale) => sale.customerId === contact.id,
              )
            : Object.values(state.purchases).filter(
                (purchase) => purchase.supplierId === contact.id,
              );
        documents.sort(
          (a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence,
        );
        const value = amount(input.amount),
          outstanding = documents.reduce(
            (sum, document) => sum + due(document),
            0n,
          );
        if (value <= 0n || value > outstanding)
          fail(
            "OVERPAYMENT",
            "Enter a positive payment no greater than the current due.",
          );
        const allocations: Payment["allocations"] = [];
        let remaining = value;
        for (const document of documents) {
          const pending = due(document),
            applied = pending < remaining ? pending : remaining;
          if (applied > 0n) {
            document.paid = money(amount(document.paid) + applied);
            allocations.push({
              documentId: document.id,
              amount: money(applied),
            });
            remaining -= applied;
          }
          if (!remaining) break;
        }
        const incoming = contact.kind === "customer";
        const payment: Payment = {
          id: key,
          contactId: contact.id,
          direction: incoming ? "INCOMING" : "OUTGOING",
          date: date(input.date),
          sequence,
          amount: money(value),
          allocations,
          createdAt: now,
        };
        state.payments[key] = payment;
        const asset = paymentAccount(input.paymentAccount);
        post(
          state,
          key,
          "PARTY_PAYMENT",
          payment.date,
          incoming
            ? [
                { account: asset, debit: value },
                { account: "1200", credit: value, contactId: contact.id },
              ]
            : [
                { account: "2100", debit: value, contactId: contact.id },
                { account: asset, credit: value },
              ],
        );
        return payment;
      },
    );
  }
  intakeReplacement(
    key: string,
    input: {
      unitId: string;
      supplierId: string;
      source: Replacement["source"];
      date: string;
      reason: string;
    },
  ) {
    return this.execute(
      "REPLACEMENT_INTAKE",
      key,
      input,
      input.source === "BEFORE_SALE"
        ? "replacements.intake.stock"
        : "replacements.intake.customer",
      (state, _sequence, now) => {
        if (!["BEFORE_SALE", "CUSTOMER_WARRANTY"].includes(input.source))
          fail("INVALID_REPLACEMENT", "Choose the replacement source.");
        const unit = state.batteryUnits[input.unitId];
        if (!unit || unit.state === "RETIRED")
          fail("INVALID_BATTERY", "Select a current battery unit.");
        if (
          Object.values(state.replacements).some(
            (entry) =>
              (entry.unitId === unit.id ||
                entry.replacementUnitId === unit.id) &&
              ["FAULTY", "SENT", "READY"].includes(entry.stage),
          )
        )
          fail(
            "OPEN_REPLACEMENT",
            "This battery already has an open replacement.",
          );
        const batch = state.batches.find((entry) => entry.id === unit.batchId)!;
        getContact(state, input.supplierId, "supplier");
        if (state.purchases[batch.purchaseId].supplierId !== input.supplierId)
          fail(
            "INVALID_SUPPLIER",
            "Use the supplier that supplied this battery.",
          );
        const received = date(input.date);
        if (received < batch.date)
          fail("INVALID_DATE", "Replacement cannot precede the purchase.");
        const previousUnit = clone(unit);
        let eligible = true;
        if (input.source === "BEFORE_SALE") {
          if (
            unit.owner !== "SHOP" ||
            unit.custody !== "SHOP" ||
            unit.state !== "AVAILABLE"
          )
            fail("INVALID_BATTERY", "Select an unsold available shop battery.");
          batch.available--;
        } else {
          if (
            unit.owner !== "CUSTOMER" ||
            unit.custody !== "CUSTOMER" ||
            unit.state !== "SOLD" ||
            !unit.saleId ||
            !unit.coverageStart ||
            !unit.coverageEnd ||
            received < unit.coverageStart
          )
            fail(
              "INVALID_BATTERY",
              "Select a sold customer battery and valid intake date.",
            );
          eligible = unit.warrantyMonths > 0 && received <= unit.coverageEnd;
        }
        const replacement: Replacement = {
          id: key,
          unitId: unit.id,
          replacementUnitId: null,
          supplierId: input.supplierId,
          source: input.source,
          stage: "FAULTY",
          date: received,
          lastDate: received,
          reason: text(input.reason, 2000, true),
          eligible,
          version: 1,
          previousUnit,
          createdAt: now,
        };
        unit.state = "FAULTY";
        unit.custody = "SHOP";
        unit.replacementId = key;
        state.replacements[key] = replacement;
        return replacement;
      },
    );
  }
  dispatchReplacement(
    key: string,
    input: { id: string; version: number; date: string },
  ) {
    return this.execute(
      "REPLACEMENT_DISPATCH",
      key,
      input,
      "replacements.dispatch",
      (state) => {
        const entry = state.replacements[input.id];
        if (
          !entry ||
          entry.stage !== "FAULTY" ||
          entry.version !== input.version
        )
          fail(
            "REPLACEMENT_CHANGED",
            "Reload the replacement before dispatch.",
          );
        if (date(input.date) < entry.lastDate)
          fail("INVALID_DATE", "Dispatch cannot precede intake.");
        const unit = state.batteryUnits[entry.unitId];
        if (unit.state !== "FAULTY" || unit.custody !== "SHOP")
          fail("INVALID_BATTERY", "Battery is not in shop custody.");
        unit.state = "SENT";
        unit.custody = "SUPPLIER";
        entry.stage = "SENT";
        entry.lastDate = input.date;
        entry.version++;
        return entry;
      },
    );
  }
  receiveReplacement(
    key: string,
    input: {
      id: string;
      version: number;
      date: string;
      serialNumber?: string;
      productionDate?: string;
    },
  ) {
    return this.execute(
      "REPLACEMENT_RECEIVE",
      key,
      input,
      "replacements.receive",
      (state) => {
        const entry = state.replacements[input.id];
        if (!entry || entry.stage !== "SENT" || entry.version !== input.version)
          fail(
            "REPLACEMENT_CHANGED",
            "Reload the sent replacement before receiving.",
          );
        if (!entry.eligible)
          fail(
            "WARRANTY_EXPIRED",
            "This claim is outside warranty. Resolve it explicitly rather than issue an automatic free replacement.",
          );
        if (date(input.date) < entry.lastDate)
          fail("INVALID_DATE", "Receipt cannot precede dispatch.");
        const old = state.batteryUnits[entry.unitId];
        if (old.custody !== "SUPPLIER" || old.state !== "SENT")
          fail("INVALID_BATTERY", "Battery is not with the supplier.");
        const serial = text(input.serialNumber || "", 120) || old.serialNumber;
        let unit = old;
        if (
          serial &&
          serial.toUpperCase() !== old.serialNumber?.toUpperCase()
        ) {
          if (
            Object.values(state.batteryUnits).some(
              (battery) =>
                battery.serialNumber?.toUpperCase() === serial.toUpperCase(),
            )
          )
            fail(
              "DUPLICATE_SERIAL",
              "Replacement battery serial already exists.",
            );
          unit = {
            ...clone(old),
            id: key + ":replacement-unit",
            serialNumber: serial,
            productionDate: input.productionDate
              ? date(input.productionDate)
              : null,
            parentUnitId: old.id,
          };
          state.batteryUnits[unit.id] = unit;
          old.state = "RETIRED";
        }
        unit.custody = "SHOP";
        if (entry.source === "BEFORE_SALE") {
          unit.state = "AVAILABLE";
          unit.replacementId = null;
          state.batches.find((batch) => batch.id === unit.batchId)!.available++;
          entry.stage = "COMPLETED";
        } else {
          unit.state = "READY";
          entry.stage = "READY";
        }
        entry.replacementUnitId = unit.id;
        entry.lastDate = input.date;
        entry.version++;
        return entry;
      },
    );
  }
  deliverReplacement(
    key: string,
    input: { id: string; version: number; date: string },
  ) {
    return this.execute(
      "REPLACEMENT_DELIVER",
      key,
      input,
      "replacements.deliver",
      (state) => {
        const entry = state.replacements[input.id];
        if (
          !entry ||
          entry.stage !== "READY" ||
          entry.version !== input.version ||
          !entry.replacementUnitId
        )
          fail(
            "REPLACEMENT_CHANGED",
            "Reload the received customer replacement.",
          );
        if (date(input.date) < entry.lastDate)
          fail("INVALID_DATE", "Delivery cannot precede receipt.");
        const unit = state.batteryUnits[entry.replacementUnitId];
        if (
          unit.state !== "READY" ||
          unit.owner !== "CUSTOMER" ||
          unit.custody !== "SHOP"
        )
          fail(
            "INVALID_BATTERY",
            "Replacement is not reserved for this customer.",
          );
        unit.state = "SOLD";
        unit.custody = "CUSTOMER";
        unit.replacementId = null;
        entry.stage = "COMPLETED";
        entry.lastDate = input.date;
        entry.version++;
        return entry;
      },
    );
  }
  rejectReplacement(
    key: string,
    input: { id: string; version: number; date: string; reason: string },
  ) {
    return this.execute(
      "REPLACEMENT_REJECT",
      key,
      input,
      "replacements.resolve",
      (state) => {
        const entry = state.replacements[input.id];
        if (
          !entry ||
          !["FAULTY", "SENT"].includes(entry.stage) ||
          entry.version !== input.version
        )
          fail(
            "REPLACEMENT_CHANGED",
            "Replacement cannot be rejected in its current state.",
          );
        if (date(input.date) < entry.lastDate)
          fail("INVALID_DATE", "Resolution cannot precede the last action.");
        const unit = state.batteryUnits[entry.unitId];
        unit.custody = unit.owner === "SHOP" ? "SHOP" : "CUSTOMER";
        unit.state = unit.owner === "SHOP" ? "FAULTY" : "SOLD";
        unit.replacementId = null;
        entry.stage = "REJECTED";
        entry.lastDate = input.date;
        entry.reason += "\nRejected: " + text(input.reason, 2000, true);
        entry.version++;
        return entry;
      },
    );
  }
  cancelReplacement(key: string, input: { id: string; version: number }) {
    return this.execute(
      "REPLACEMENT_CANCEL",
      key,
      input,
      "transactions.reverse",
      (state) => {
        const entry = state.replacements[input.id];
        if (
          !entry ||
          entry.stage !== "FAULTY" ||
          entry.version !== input.version
        )
          fail(
            "REPLACEMENT_CHANGED",
            "Only an undispatched intake can be cancelled.",
          );
        const unit = state.batteryUnits[entry.unitId];
        if (
          unit.state !== "FAULTY" ||
          unit.custody !== "SHOP" ||
          unit.replacementId !== entry.id
        )
          fail("INVALID_BATTERY", "Battery has subsequent activity.");
        state.batteryUnits[unit.id] = clone(entry.previousUnit);
        if (entry.source === "BEFORE_SALE")
          state.batches.find((batch) => batch.id === unit.batchId)!.available++;
        entry.stage = "CANCELLED";
        entry.version++;
        return entry;
      },
    );
  }
  recordExpense(
    key: string,
    input: {
      date: string;
      amount: string;
      description: string;
      category?: string;
      paymentAccount?: string;
    },
  ) {
    return this.execute(
      "EXPENSE",
      key,
      input,
      "finance.read",
      (state, sequence, now) => {
        const value = amount(input.amount);
        if (value <= 0n) fail("INVALID_AMOUNT", "Expense must be positive.");
        const expense: Expense = {
          id: key,
          date: date(input.date),
          amount: money(value),
          description: text(input.description, 2000, true),
          category: text(input.category || "Others", 120, true),
          paymentAccount: paymentAccount(input.paymentAccount),
          sequence,
          createdAt: now,
        };
        state.expenses[key] = expense;
        post(state, key, "EXPENSE", expense.date, [
          { account: "6100", debit: value },
          { account: expense.paymentAccount, credit: value },
        ]);
        return expense;
      },
    );
  }
  async customerLedger(customerId: string): Promise<LedgerRow[]> {
    const state = await this.snapshot();
    getContact(state, customerId, "customer");
    const payments = Object.values(state.payments).filter(
      (payment) =>
        payment.contactId === customerId && payment.direction === "INCOMING",
    );
    const allocations = new Map<string, bigint>();
    for (const payment of payments)
      for (const allocation of payment.allocations)
        allocations.set(
          allocation.documentId,
          (allocations.get(allocation.documentId) ?? 0n) +
            amount(allocation.amount),
        );
    const rows = Object.values(state.sales)
      .filter((sale) => sale.customerId === customerId)
      .map((sale) => ({
        id: sale.id,
        date: sale.date,
        description: sale.invoiceNumber,
        sale: sale.total as string | null,
        paid: money(amount(sale.paid) - (allocations.get(sale.id) ?? 0n)),
        balance: "0.00",
        sequence: sale.sequence,
      }));
    rows.push(
      ...payments.map((payment) => ({
        id: payment.id,
        date: payment.date,
        description: "Due collection",
        sale: null,
        paid: payment.amount,
        balance: "0.00",
        sequence: payment.sequence,
      })),
    );
    rows.sort(
      (a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence,
    );
    let balance = 0n;
    for (const row of rows) {
      balance += (row.sale === null ? 0n : amount(row.sale)) - amount(row.paid);
      row.balance = money(balance);
    }
    return rows.reverse();
  }
}
