export type Contact = {
  id: string;
  kind: "customer" | "supplier";
  name: string;
  phone: string;
  address: string;
  company: string;
  categoryId: string | null;
  active: boolean;
};
export type Category = {
  id: string;
  name: string;
  trackingKind: "QUANTITY" | "BATTERY_UNIT";
};
export type Product = {
  id: string;
  categoryId: string;
  name: string;
  model: string | null;
  unit: string;
  active: boolean;
  warrantyMonths: number;
};
export type ItemInput = {
  productId: string;
  quantity: number;
  unitPrice: string;
  batteryIdentities?: { serialNumber?: string; productionDate?: string }[];
  unitIds?: string[];
  warrantyMonths?: number;
};
export type DocumentLine = ItemInput & {
  name: string;
  model: string | null;
  total: string;
  cost: string;
  unitIds?: string[];
};
export type Purchase = {
  id: string;
  number: string;
  supplierId: string;
  date: string;
  sequence: number;
  reference: string;
  total: string;
  paid: string;
  transport: string;
  lines: DocumentLine[];
  createdAt: string;
};
export type Sale = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  date: string;
  sequence: number;
  total: string;
  paid: string;
  cost: string;
  lines: DocumentLine[];
  createdAt: string;
};
export type Batch = {
  id: string;
  purchaseId: string;
  productId: string;
  date: string;
  sequence: number;
  received: number;
  available: number;
  unitPrice: string;
};
export type BatteryUnit = {
  id: string;
  productId: string;
  batchId: string;
  serialNumber: string | null;
  productionDate: string | null;
  state: "AVAILABLE" | "SOLD" | "FAULTY" | "SENT" | "READY" | "RETIRED";
  owner: "SHOP" | "CUSTOMER";
  custody: "SHOP" | "CUSTOMER" | "SUPPLIER";
  warrantyMonths: number;
  saleId: string | null;
  customerId: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  replacementId: string | null;
  parentUnitId: string | null;
};
export type Replacement = {
  id: string;
  unitId: string;
  replacementUnitId: string | null;
  supplierId: string;
  source: "BEFORE_SALE" | "CUSTOMER_WARRANTY";
  stage: "FAULTY" | "SENT" | "READY" | "COMPLETED" | "REJECTED" | "CANCELLED";
  date: string;
  lastDate: string;
  reason: string;
  eligible: boolean;
  version: number;
  previousUnit: BatteryUnit;
  createdAt: string;
};
export type Expense = {
  id: string;
  date: string;
  amount: string;
  description: string;
  category?: string;
  paymentAccount: string;
  sequence: number;
  createdAt: string;
};
export type Allocation = { documentId: string; amount: string };
export type Payment = {
  id: string;
  contactId: string;
  direction: "INCOMING" | "OUTGOING";
  date: string;
  sequence: number;
  amount: string;
  allocations: Allocation[];
  createdAt: string;
};
export type JournalLine = {
  account: string;
  debit: string;
  credit: string;
  contactId?: string;
};
export type Journal = {
  id: string;
  date: string;
  kind: string;
  lines: JournalLine[];
};
export type Audit = {
  id: string;
  actorId: string;
  operation: string;
  at: string;
};
export type LedgerRow = {
  id: string;
  date: string;
  description: string;
  sale: string | null;
  paid: string;
  balance: string;
  sequence: number;
};
export type LocalErpState = {
  format: 2;
  shopId: string;
  sequence: number;
  nextSale: number;
  nextPurchase: number;
  contacts: Record<string, Contact>;
  categories: Record<string, Category>;
  products: Record<string, Product>;
  productNames?: Record<
    string,
    { id: string; name: string; categoryId: string }
  >;
  shopProfile?: {
    value: { name: string; address: string; phone: string };
    version: number;
  };
  purchases: Record<string, Purchase>;
  sales: Record<string, Sale>;
  payments: Record<string, Payment>;
  batches: Batch[];
  batteryUnits: Record<string, BatteryUnit>;
  replacements: Record<string, Replacement>;
  expenses: Record<string, Expense>;
  journals: Journal[];
  audit: Audit[];
  commands: Record<string, { fingerprint: string; result: unknown }>;
};
export interface LocalErpStore {
  load(
    shopId: string,
  ): Promise<{ revision: number; state: LocalErpState } | null>;
  commit(
    shopId: string,
    expectedRevision: number | null,
    state: LocalErpState,
  ): Promise<boolean>;
}
export type LocalActor = { id: string; permissions: readonly string[] };
export type PurchaseInput = {
  supplierId: string;
  date: string;
  reference: string;
  items: ItemInput[];
  paid: string;
  transport?: string;
  paymentAccount?: string;
};
export type SaleInput = {
  customerId: string;
  date: string;
  items: ItemInput[];
  paid: string;
  paymentAccount?: string;
};
