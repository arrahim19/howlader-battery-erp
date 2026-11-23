export interface CurrentUser {
  shop?: { id: string; name: string; branchName: string };
  id: string;
  name: string;
  login: string;
  roles: string[];
  permissions: string[];
}
export interface SupplierRecord {
  productTypeId: string | null;
  productType: { id: string; name: string } | null;
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  active: boolean;
  createdAt: string;
}
export interface SupplierList {
  items: SupplierRecord[];
  total: number;
  page: number;
  pageSize: number;
}
export interface SupplierLedgerRecord extends SupplierRecord {
  totalPurchases: string;
  due: string;
}
export interface SupplierLedgerList {
  items: SupplierLedgerRecord[];
  total: number;
  page: number;
  pageSize: number;
  summary: { totalPurchases: string; totalDue: string };
}
export interface SupplierLedger {
  supplier: SupplierLedgerRecord;
  items: {
    id: string;
    date: string;
    reference: string;
    description: string;
    debit: string;
    credit: string;
    balance: string;
  }[];
}
export interface CustomerRecord {
  id: string;
  name: string;
  phone: string;
  address: string | null;
  active: boolean;
  createdAt: string;
  totalSales: string;
  due: string;
}
export interface CustomerList {
  items: CustomerRecord[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    total: number;
    active: number;
    credit: number;
    totalSales: string;
    totalDue: string;
  };
}
export interface CustomerSalesHistory {
  customer: CustomerRecord;
  total: number;
  page: number;
  pageSize: number;
  items: {
    id: string;
    invoiceNumber: string | null;
    soldAt: string | null;
    status: string;
    subtotal: string;
    discount: string;
    total: string;
    products: {
      id: string;
      name: string;
      model: string;
      quantity: string;
      unit: string;
      unitPrice: string;
      amount: string;
    }[];
  }[];
}
export interface CustomerLedger {
  customer: CustomerRecord;
  from: string | null;
  to: string | null;
  summary: { opening: string; debit: string; credit: string; closing: string };
  paymentAccounts: { id: string; name: string }[];
  items: {
    id: string;
    date: string;
    reference: string;
    description: string;
    kind: "sale" | "payment" | "return" | "reversal" | "adjustment";
    debit: string;
    credit: string;
    balance: string;
  }[];
}
export type ProductTrackingKind = "BATTERY_UNIT" | "QUANTITY";
export interface ProductTypeRecord {
  id: string;
  name: string;
  trackingKind: ProductTrackingKind;
  productCount: number;
}
export interface CatalogFacet {
  id: string;
  name: string;
  productCount: number;
  typeIds?: string[];
  productCountsByType?: Record<string, number>;
}
export interface CatalogMetadata {
  types: ProductTypeRecord[];
  brands: CatalogFacet[];
  categories: CatalogFacet[];
  totalProducts: number;
}
export interface CatalogProduct {
  id: string;
  name: string;
  model: string;
  unit: string;
  active: boolean;
  type: { id: string; name: string; trackingKind: ProductTrackingKind };
  brand: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  defaultSellingPrice: string;
  latestPurchasePrice?: string | null;
  lowStockThreshold: string;
  warrantyMonths: number;
  capacityAh: string | null;
  voltage: string | null;
  specifications: string | null;
  stock: {
    total: string;
    available: string;
    replaceable: string;
    reserved: string;
    sentToCompany: string;
  };
}
export interface ProductList {
  items: CatalogProduct[];
  total: number;
  page: number;
  pageSize: number;
}
export interface PurchaseOptions {
  productNames?: { id: string; name: string; typeId: string }[];
  types: Pick<ProductTypeRecord, "id" | "name" | "trackingKind">[];
  products: (Pick<CatalogProduct, "id" | "name" | "model" | "unit" | "type"> & {
    capacityAh?: string | null;
    voltage?: string | null;
    specifications?: string | null;
    warrantyMonths?: number;
  })[];
  suppliers: {
    id: string;
    name: string;
    company: string | null;
    productTypeId: string | null;
  }[];
  paymentAccounts: { id: string; name: string; paymentMethod: string | null }[];
}
export interface SalesOptions {
  types: Pick<ProductTypeRecord, "id" | "name" | "trackingKind">[];
  products: (Pick<
    CatalogProduct,
    "id" | "name" | "model" | "unit" | "type" | "defaultSellingPrice"
  > & {
    availableQuantity: string;
  })[];
  customers: CustomerRecord[];
  paymentAccounts: { id: string; name: string; paymentMethod: string | null }[];
}
export interface CompletedSale {
  syncStatus?: "PENDING";
  id: string;
  invoiceNumber: string;
  customerId: string;
  subtotal: string;
  total: string;
  paid: string;
  due: string;
  quantity: number;
}
export interface SalesList {
  items: {
    id: string;
    invoiceNumber: string | null;
    customer: { id: string; name: string; phone: string };
    saleDate: string | null;
    status: string;
    subtotal: string;
    total: string;
    paid: string;
    due: string;
    quantity: string;
    itemCount: number;
  }[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ReceivedPurchase {
  syncStatus?: "PENDING";
  transportAmount?: string;
  id: string;
  number: string;
  receiptId: string;
  status: string;
  total: string;
  paid: string;
  due: string;
  quantity: number;
}
export interface PurchaseList {
  items: {
    id: string;
    number: string;
    supplierReference: string | null;
    supplier: { id: string; name: string; company: string | null };
    items: RecentPurchases["items"][number]["items"];
    purchaseDate: string;
    status: string;
    itemCount: number;
    quantity: string;
    total: string;
    paid: string;
    due: string;
  }[];
  total: number;
  page: number;
  pageSize: number;
}
export interface RecentPurchases {
  items: {
    id: string;
    number: string;
    purchaseDate: string;
    supplierReference: string | null;
    supplier: { name: string; company: string | null };
    items: {
      id: string;
      name: string;
      typeName: string;
      model: string;
      capacityAh: string | null;
      voltage: string | null;
      specifications: string | null;
      warrantyMonths: number;
      quantity: string;
      unitPrice: string;
      total: string;
    }[];
  }[];
}
export interface ExpenseRecord {
  challanNumber?: string | null;
  id: string;
  expenseId: string | null;
  date: string;
  description: string;
  category: string;
  amount: string;
  paymentAccount: string;
  source: "MANUAL" | "PURCHASE_TRANSPORT" | "OTHER";
}
export interface ExpenseList {
  items: ExpenseRecord[];
  total: number;
  page: number;
  pageSize: number;
  summary: { total: string; byCategory: { name: string; amount: string }[] };
}
export interface ExpenseOptions {
  categories: string[];
  cashAvailable: boolean;
  paymentAccounts: { id: string; name: string; paymentMethod: string | null }[];
}

export const replacementStatuses = [
  "FAULTY",
  "SENT",
  "RECEIVED",
  "DELIVERED",
] as const;
export type ReplacementStage = (typeof replacementStatuses)[number];
export interface ReplacementCase {
  id: string;
  source?: "BEFORE_SALE" | "CUSTOMER_WARRANTY";
  number: string;
  status: ReplacementStage;
  version: number;
  product: string;
  serial: string;
  customer: string | null;
  phone: string | null;
  invoice: string | null;
  supplier: string;
  createdAt: string;
  sentAt: string | null;
}
export interface ReplacementList {
  items: ReplacementCase[];
  total: number;
  page: number;
  pageSize: number;
  summary: Record<ReplacementStage, number>;
}
export interface ReplacementOptions {
  units: {
    id: string;
    productId: string;
    saleUnitId: string | null;
    label: string;
    supplierId: string | null;
    customer: string | null;
    invoice: string | null;
  }[];
  suppliers: { id: string; name: string }[];
}

export interface DashboardData {
  businessDate: string;
  from: string;
  to: string;
  counts: {
    products: number;
    customers: number;
    availableStock: string;
    pendingReplacements: number;
    sentToCompany: number;
    replacementsReceived: number;
    lowStock: number;
  };
  financials?: {
    transportExpenses?: string;
    companyTransactionCount?: number;
    companyTransactionAmount?: string;
    companyTransactions?: {
      id: string;
      date: string;
      company: string;
      challanNumber: string | null;
      type: "Payment" | "Refund";
      amount: string;
    }[];
    transportTransactions?: {
      challanNumber?: string | null;
      id: string;
      date: string;
      description: string;
      amount: string;
    }[];
    availableStockPurchaseValue: string;
    todaySales: string;
    salesIncome?: string;
    salesProfit?: string;
    todayPurchases: string;
    todayCashReceived: string;
    grossProfit: string;
    customerDues: string;
    supplierDues: string;
  };
  recentSales: {
    id: string;
    invoiceNumber: string | null;
    soldAt: string | null;
    customer: string;
    customerId?: string;
    customerPhone?: string;
    paid?: string;
    due?: string;
    total: string;
    status: string;
  }[];
  lowStock: { id: string; name: string; quantity: string; threshold: string }[];
  salesTrend: { date: string; amount: string; grossProfit?: string }[];
  stock?: {
    batteriesAvailable: number;
    partsAvailable: string;
    accountedUnits: string;
    replaceable: number;
    reserved: number;
  };
  replacementStages?: {
    total: number;
    pendingReturn: number;
    sentToCompany: number;
    underReview: number;
    received: number;
    readyForDelivery: number;
  };
}
