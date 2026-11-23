"use client";
import { randomId } from "@/lib/random-id";
import Link from "@/components/workspace-link";
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CreditCard,
  List,
  LoaderCircle,
  PackageOpen,
  Plus,
  ShoppingCart,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  ModuleTabs,
  Panel,
  SummaryRows,
} from "@/components/reference-ui";
import { useSession } from "@/components/session-provider";
import {
  post,
  type PurchaseOptions,
  type PurchaseList,
  type ReceivedPurchase,
  type CatalogProduct,
} from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { notifyDashboardUpdate } from "@/lib/use-dashboard";
import { useLocalReceipt } from "@/lib/use-local-receipt";
import { useBusinessDate } from "@/lib/use-business-date";
import { cents, decimalAmount } from "@/lib/purchase-amounts";
import { money, shortBusinessDate } from "@/lib/utils";
import { PurchaseDetailsDialog, PurchaseQuickAdd } from "./purchase-quick-add";
import { TransactionDeleteButton } from "./transaction-delete-button";
type CartItem = {
  productId: string;
  name: string;
  typeName: string;
  model: string;
  capacityAh?: string | null;
  voltage?: string | null;
  specifications?: string | null;
  warrantyMonths: number;
  quantity: number;
  unitPrice: string;
};
type PurchaseDraft = {
  cart: CartItem[];
  supplierId: string;
  productTypeId: string;
  purchaseDate: string;
  reference: string;
  paymentType: string;
  partialPaid: string;
  transportAmount?: string;
  requestKey: string | null;
  requestBody?: string;
};
function purchaseDisplayNumber(number: string) {
  return /^PUR-\d+$/.test(number) ? String(Number(number.slice(4))) : number;
}
function purchaseListMoney(value?: string | null) {
  const formatted = money(value);
  return value != null && Number(value) !== 0
    ? formatted.replace(/\.00$/, "")
    : formatted;
}
function readPurchaseDraft(key: string): PurchaseDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const draft = JSON.parse(
      sessionStorage.getItem(key) ?? "null",
    ) as PurchaseDraft | null;
    if (
      !draft ||
      !Array.isArray(draft.cart) ||
      !draft.cart.length ||
      draft.cart.length > 100 ||
      !draft.cart.every(
        (item) =>
          typeof item.productId === "string" &&
          Number.isInteger(item.quantity) &&
          item.quantity > 0 &&
          /^\d{1,14}(?:\.\d{1,2})?$/.test(item.unitPrice),
      )
    )
      return null;
    return draft;
  } catch {
    return null;
  }
}
export function PurchasesView({
  preview,
  view = "",
  loading = false,
  moduleError = "",
}: {
  preview: boolean;
  view?: string;
  loading?: boolean;
  moduleError?: string;
}) {
  const user = useSession();
  const canPay =
    preview || Boolean(user?.permissions.includes("finance.write"));
  const draftKey = "hawlader:purchase-draft:" + (user?.id ?? "preview");
  const [draft] = useState(() =>
    preview ? null : readPurchaseDraft(draftKey),
  );
  const [revision, setRevision] = useState(0);
  const [quickAdd, setQuickAdd] = useState<"product" | "supplier" | null>(null);
  const [addedSuppliers, setAddedSuppliers] = useState<
    PurchaseOptions["suppliers"]
  >([]);
  const [addedProductNames, setAddedProductNames] = useState<
    NonNullable<PurchaseOptions["productNames"]>
  >([]);
  const [mobileSection, setMobileSection] = useState(0);
  const formGrid = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [purchaseDetails, setPurchaseDetails] = useState<
    PurchaseList["items"][number] | null
  >(null);
  const detailsRow = useRef<HTMLTableRowElement | null>(null);
  const options = useCatalogResource<PurchaseOptions>(
    preview || loading || view === "list" ? null : "/purchases/options",
    revision,
  );
  const listing = useCatalogResource<PurchaseList>(
    !preview && !loading && view === "list" ? `/purchases?page=${page}` : null,
    revision,
  );
  const [supplierId, setSupplierId] = useState(draft?.supplierId ?? "");
  const today = useBusinessDate();
  const [purchaseDateValue, setPurchaseDate] = useState<string | null>(
    draft?.purchaseDate ?? null,
  );
  const purchaseDate = purchaseDateValue ?? today;
  const [transportAmount, setTransportAmount] = useState(
    draft?.transportAmount ?? "",
  );
  const [reference, setReference] = useState(draft?.reference ?? "");
  const [productTypeId, setProductTypeId] = useState(
    draft?.productTypeId ?? "",
  );
  const [productName, setProductName] = useState("");
  const [model, setModel] = useState("");
  const [warrantyMonths, setWarrantyMonths] = useState("");
  const [createdProducts, setCreatedProducts] = useState<CatalogProduct[]>([]);
  const [quantity, setQuantity] = useState(0);
  const [unitPrice, setUnitPrice] = useState("");
  const [cart, setCart] = useState<CartItem[]>(draft?.cart ?? []);
  const [confirmedItems, setConfirmedItems] = useState<CartItem[]>([]);
  const [paymentType, setPaymentType] = useState(draft?.paymentType ?? "full");
  const [partialPaid, setPartialPaid] = useState(draft?.partialPaid ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [received, setReceived] = useState<ReceivedPurchase | null>(null);
  useLocalReceipt(received, setReceived, setError);
  const requestKey = useRef<string | null>(draft?.requestKey ?? null);
  const requestBody = useRef(draft?.requestBody ?? "");
  const submitting = useRef(false);
  useEffect(() => {
    if (preview || !user) return;
    try {
      if (!cart.length) sessionStorage.removeItem(draftKey);
      else
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({
            cart,
            supplierId,
            productTypeId,
            purchaseDate,
            reference,
            paymentType,
            partialPaid,
            transportAmount,
            requestKey: requestKey.current,
            requestBody: requestBody.current,
          } satisfies PurchaseDraft),
        );
    } catch {}
  }, [
    cart,
    supplierId,
    productTypeId,
    purchaseDate,
    reference,
    paymentType,
    partialPaid,
    transportAmount,
    draftKey,
    preview,
    saving,
    user,
  ]);
  const types = options.data?.types ?? [];
  const filteredProducts = [
    ...(options.data?.products ?? []),
    ...createdProducts,
  ].filter(
    (item, index, items) =>
      item.type.id === productTypeId &&
      items.findIndex((candidate) => candidate.id === item.id) === index,
  );
  const product = filteredProducts.find(
    (item) =>
      item.name === productName &&
      item.model.toLowerCase() === model.trim().toLowerCase(),
  );
  const filteredSuppliers = [
    ...(options.data?.suppliers ?? []),
    ...addedSuppliers,
  ].filter(
    (supplier, index, items) =>
      supplier.productTypeId === productTypeId &&
      items.findIndex((item) => item.id === supplier.id) === index,
  );
  const selectedSupplierId = filteredSuppliers.some(
    (supplier) => supplier.id === supplierId,
  )
    ? supplierId
    : "";
  const productNames = [
    ...(options.data?.productNames ?? []),
    ...addedProductNames,
  ].filter((item) => item.typeId === productTypeId);
  const productChoices = [
    ...filteredProducts.map((item) => ({ value: item.id, name: item.name })),
    ...productNames.map((item) => ({
      value: `name:${item.id}`,
      name: item.name,
    })),
  ].filter(
    (item, index, items) =>
      items.findIndex((candidate) => candidate.name === item.name) === index,
  );
  const hasProductOptions = productChoices.length > 0;
  const selectedType = types.find((item) => item.id === productTypeId);
  const individual = selectedType?.trackingKind === "BATTERY_UNIT";
  const entryTotal =
    Number.isInteger(quantity) && quantity > 0 && productName
      ? cents(unitPrice) * BigInt(quantity)
      : BigInt(0);
  const totalCents = cart.reduce(
    (sum, item) => sum + cents(item.unitPrice) * BigInt(item.quantity),
    entryTotal,
  );
  const total = decimalAmount(totalCents);
  const paid =
    paymentType === "full"
      ? total
      : paymentType === "partial"
        ? partialPaid || "0.00"
        : "0.00";
  const due = decimalAmount(totalCents - cents(paid));
  const canReceive = Boolean(user?.permissions.includes("inventory.receive"));
  const canDefineProduct =
    preview || Boolean(user?.permissions.includes("catalog.write"));
  const current = view === "list" ? "list" : "new";
  const showingConfirmed = Boolean(received && !cart.length && !productName);
  const summaryItems = showingConfirmed ? confirmedItems : cart;
  const summaryTotal = showingConfirmed ? received!.total : total;
  const summaryPaid = showingConfirmed ? received!.paid : paid;
  const summaryDue = showingConfirmed ? received!.due : due;
  function selectProductName(name: string) {
    setProductName(name);
    setModel("");
    setWarrantyMonths("");
  }
  async function savePurchase(confirm: boolean) {
    if (preview || submitting.current || !canReceive) return;
    setError("");
    if (!selectedSupplierId || !purchaseDate) {
      setError("Select a supplier and enter the purchase date.");
      return;
    }
    if (confirm && !reference.trim()) {
      setError("Enter the invoice / challan number.");
      return;
    }
    if (productName) {
      if (cart.length >= 100) {
        setError("A purchase can contain up to 100 products.");
        return;
      }
      if (
        !selectedType ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > (individual ? 500 : 10000) ||
        !/^\d{1,14}(?:\.\d{1,2})?$/.test(unitPrice)
      ) {
        setError(
          "Select a product and enter a valid quantity and purchase price.",
        );
        return;
      }
      if (
        (individual && !model.trim()) ||
        !/^\d+$/.test(warrantyMonths || "0") ||
        Number(warrantyMonths) > 600
      ) {
        setError(
          "Enter the warranty (0-600 months), and required battery model.",
        );
        return;
      }
    } else if (!cart.length) {
      setError("Select a product to confirm the purchase.");
      return;
    }
    if (
      confirm &&
      (!/^\d{1,14}(?:\.\d{1,2})?$/.test(paid) ||
        cents(paid) > totalCents ||
        (paymentType === "partial" && cents(paid) <= BigInt(0)))
    ) {
      setError("Enter a valid paid amount within the purchase total.");
      return;
    }
    if (
      confirm &&
      !/^\d{1,14}(?:\.\d{1,2})?$/.test(canPay ? transportAmount : "0")
    ) {
      setError("Enter a valid transport amount.");
      return;
    }
    submitting.current = true;
    setReceived(null);
    setSaving(true);
    try {
      let items = cart;
      if (productName) {
        let selected = product;
        if (!selected) {
          if (!canDefineProduct)
            throw new Error(
              "You do not have permission to add a new product model.",
            );
          const created = await post<CatalogProduct>("/products", {
            typeId: productTypeId,
            name: productName,
            category: productName,
            model: model.trim(),
            unit: "pcs",
            warrantyMonths: Number(warrantyMonths),
          });
          selected = created;
          setCreatedProducts((products) => [...products, created]);
        }
        if (items.some((item) => item.productId === selected.id))
          throw new Error(
            "This model already has a pending purchase. Remove its pending line before changing it.",
          );
        items = [
          ...items,
          {
            productId: selected.id,
            name: selected.name,
            model: selected.model,
            typeName: selected.type.name,
            capacityAh: selected.capacityAh,
            voltage: selected.voltage,
            specifications: selected.specifications,
            warrantyMonths: selected.warrantyMonths ?? 0,
            quantity,
            unitPrice,
          },
        ];
        setCart(items);
        selectProductName("");
        setQuantity(0);
        setUnitPrice("");
      }
      if (!confirm) return;
      const body = {
        supplierId: selectedSupplierId,
        purchaseDate,
        reference: reference.trim(),
        items: items.map(({ productId, quantity, unitPrice }) => ({
          productId,
          quantity,
          unitPrice,
        })),
        paidAmount: paid,
        transportAmount: transportAmount || "0.00",
        ...(cents(paid) > BigInt(0) || cents(transportAmount) > BigInt(0)
          ? {
              paymentAccountId: options.data?.paymentAccounts.find(
                (account) => account.paymentMethod === "CASH",
              )?.id,
            }
          : {}),
      };
      const serialized = JSON.stringify(body);
      if (!requestKey.current || requestBody.current !== serialized) {
        requestKey.current = randomId();
        requestBody.current = serialized;
      }
      const result = await post<ReceivedPurchase>("/purchases/receive", body, {
        "Idempotency-Key": requestKey.current,
      });
      setReceived(result);
      notifyDashboardUpdate();
      setConfirmedItems(items);
      setCart([]);
      setPaymentType("full");
      setPartialPaid("");
      setTransportAmount("");
      setReference("");
      requestKey.current = null;
      requestBody.current = "";
      setRevision((value) => value + 1);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not confirm purchase. Please retry.",
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  const loadError = options.error || listing.error;
  const listLoading = loading || listing.loading;
  const pages = Math.max(1, Math.ceil((listing.data?.total ?? 0) / 20));
  return (
    <div
      aria-busy={loading || options.loading || listing.loading}
      className={
        current === "new"
          ? "purchase-workspace purchase-page"
          : "purchase-workspace purchase-list-page"
      }
    >
      <ModuleTabs
        moduleId="purchases"
        current={current}
        preview={preview}
        items={[
          { id: "new", label: "New Purchase", icon: Plus },
          { id: "list", label: "Purchase List", icon: List },
        ]}
      />
      <div className="purchase-notices">
        {received ? (
          <div
            role="status"
            className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800"
          >
            {received.syncStatus === "PENDING"
              ? "ডিভাইসে ক্রয় সেভ হয়েছে · Online হলে sync হবে"
              : "Successful"}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Dismiss purchase confirmation"
              onClick={() => setReceived(null)}
            >
              <X />
            </Button>
          </div>
        ) : null}
        {error || loadError || moduleError ? (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
          >
            <span>{error || loadError || moduleError}</span>
            {error ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Dismiss purchase error"
                onClick={() => setError("")}
              >
                <X />
              </Button>
            ) : null}
            {loadError ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {current === "list" ? (
        <Panel title="Purchase List" className="purchase-list-panel">
          <div
            className="purchase-list-body"
            aria-busy={loading || listing.loading}
          >
            <div className="erp-table-wrap">
              <table className="erp-table purchase-recent-table">
                <caption className="sr-only">Purchases</caption>
                <colgroup>
                  {[7, 11, 13, 9, 7, 12, 9, 6, 4, 9, 9, 4].map(
                    (width, index) => (
                      <col key={index} style={{ width: `${width}%` }} />
                    ),
                  )}
                </colgroup>
                <thead>
                  <tr>
                    {[
                      "Date",
                      "Supplier",
                      "Company Name",
                      "Challan No.",
                      "Category",
                      "পণ্যের নাম",
                      "Model",
                      "ওয়ারেন্টি",
                      "Qty",
                      "Unit Price (৳)",
                      "Total (৳)",
                      "Action",
                    ].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className={
                          label === "Action"
                            ? "purchase-action-cell"
                            : undefined
                        }
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {listing.data?.items.flatMap((purchase) =>
                    purchase.items.map((item, index) => (
                      <tr
                        key={item.id}
                        tabIndex={0}
                        aria-label={`View purchase ${purchaseDisplayNumber(purchase.number)} details for ${item.name}`}
                        className="cursor-pointer hover:bg-green-50 focus-visible:outline-2 focus-visible:outline-green-600 outline-offset-[-2px]"
                        onClick={(event) => {
                          const target = event.target as HTMLElement;
                          if (
                            !event.currentTarget.contains(target) ||
                            target.closest("button")
                          )
                            return;
                          detailsRow.current = event.currentTarget;
                          setPurchaseDetails(purchase);
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            detailsRow.current = event.currentTarget;
                            setPurchaseDetails(purchase);
                          }
                        }}
                      >
                        {index === 0 ? (
                          <>
                            <td
                              data-label="Date"
                              rowSpan={purchase.items.length}
                            >
                              {shortBusinessDate(purchase.purchaseDate)}
                            </td>
                            <td
                              data-label="Supplier"
                              rowSpan={purchase.items.length}
                            >
                              {purchase.supplier.name}
                            </td>
                            <td
                              data-label="Company Name"
                              rowSpan={purchase.items.length}
                            >
                              {purchase.supplier.company || "—"}
                            </td>
                            <td
                              data-label="Challan No."
                              rowSpan={purchase.items.length}
                            >
                              {purchase.supplierReference || "—"}
                            </td>
                          </>
                        ) : null}
                        <td data-label="Category">{item.typeName}</td>
                        <td data-label="পণ্যের নাম">
                          <strong>{item.name}</strong>
                        </td>
                        <td data-label="Model">{item.model.trim() || "N/A"}</td>
                        <td data-label="ওয়ারেন্টি">{item.warrantyMonths} মাস</td>
                        <td data-label="Qty">{item.quantity}</td>
                        <td data-label="Unit Price (৳)">
                          {purchaseListMoney(item.unitPrice)}
                        </td>
                        <td data-label="Total (৳)">
                          {purchaseListMoney(item.total)}
                        </td>
                        {index === 0 ? (
                          <>
                            <td
                              data-label="Action"
                              className="purchase-action-cell"
                              rowSpan={purchase.items.length}
                            >
                              <TransactionDeleteButton
                                kind="purchases"
                                id={purchase.id}
                                label={purchaseDisplayNumber(purchase.number)}
                                preview={preview}
                                onDeleted={() => {
                                  if (received?.id === purchase.id) {
                                    setReceived(null);
                                    setConfirmedItems([]);
                                  }
                                  setPage(1);
                                  setRevision((value) => value + 1);
                                }}
                              />
                            </td>
                          </>
                        ) : null}
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            {listing.error ? (
              <div
                className="erp-empty purchase-cart-empty purchase-recent-error"
                role="alert"
              >
                <PackageOpen size={26} strokeWidth={1.3} />
                <p>Purchase List লোড করা যায়নি</p>
                <span>{listing.error}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  Retry purchases
                </Button>
              </div>
            ) : loading || listing.loading ? (
              <div className="erp-empty purchase-cart-empty" role="status">
                <LoaderCircle className="animate-spin" />
                <p>Loading purchases...</p>
              </div>
            ) : !listing.data?.items.length ? (
              <div className="erp-empty purchase-cart-empty" role="status">
                <PackageOpen size={26} strokeWidth={1.3} />
                <p>No records to display</p>
                <span>
                  Confirm Purchase করলে কেনাকাটার তথ্য এখানে দেখা যাবে।
                </span>
              </div>
            ) : null}
          </div>
          <div className="erp-pager">
            <span>
              Page {page} / {pages}
            </span>
            <div>
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous purchase page"
                disabled={page <= 1 || listLoading}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next purchase page"
                disabled={page >= pages || listLoading}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void savePurchase(true);
          }}
          autoComplete="off"
        >
          <nav className="purchase-mobile-tabs" aria-label="Purchase sections">
            {["Details", "Payment"].map((label, index) => (
              <Button
                key={index}
                type="button"
                size="sm"
                variant={mobileSection === index ? "default" : "outline"}
                aria-pressed={mobileSection === index}
                onClick={() => {
                  formGrid.current
                    ?.querySelectorAll<HTMLElement>(
                      ".purchase-details, .erp-form-side",
                    )
                    [index]?.scrollIntoView({
                      behavior: "smooth",
                      block: "nearest",
                      inline: "start",
                    });
                }}
              >
                {label}
              </Button>
            ))}
          </nav>
          <fieldset
            disabled={saving || loading || options.loading}
            className="purchase-fieldset"
          >
            <legend className="sr-only">Purchase receiving</legend>
            <div
              ref={formGrid}
              className="erp-form-grid"
              onScroll={(event) => {
                const element = event.currentTarget;
                setMobileSection(
                  Math.max(
                    0,
                    Math.min(
                      1,
                      Math.round(
                        element.scrollLeft / (element.clientWidth + 12),
                      ),
                    ),
                  ),
                );
              }}
            >
              <div className="erp-form-main">
                <Panel
                  title="New Purchase"
                  className="purchase-details"
                  action={
                    !loading &&
                    productTypeId &&
                    filteredSuppliers.length === 0 ? (
                      <Link
                        className="text-xs text-amber-700 underline"
                        href="/suppliers/new"
                      >
                        সাপ্লায়ার যোগ করুন
                      </Link>
                    ) : null
                  }
                >
                  <div className="erp-form-body">
                    <div className="purchase-product-heading mt-5 mb-3 flex items-center justify-between gap-3">
                      <h3 className="erp-section-title mb-0!">Add Products</h3>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="purchase-add-another"
                        disabled={
                          preview ||
                          !canReceive ||
                          !selectedSupplierId ||
                          !productName ||
                          cart.length >= 100
                        }
                        onClick={() => void savePurchase(false)}
                      >
                        <Plus size={15} /> Add Another Product
                      </Button>
                    </div>
                    <div className="erp-add-products">
                      <Field
                        label="Product Category"
                        className="purchase-type-field"
                      >
                        <select
                          aria-label="Purchase product type"
                          value={productTypeId}
                          disabled={!types.length || cart.length > 0}
                          onChange={(event) => {
                            setProductTypeId(event.target.value);
                            setSupplierId("");
                            selectProductName("");
                            setQuantity(0);
                            setUnitPrice("");
                            setError("");
                          }}
                        >
                          <option value="">পণ্যের ধরন নির্বাচন করুন</option>
                          {types.map((type) => (
                            <option key={type.id} value={type.id}>
                              {type.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="purchase-supplier-field purchase-quick-field">
                        <Field label="Supplier" required>
                          <select
                            aria-label="Purchase supplier"
                            value={selectedSupplierId}
                            disabled={cart.length > 0}
                            onChange={(event) =>
                              setSupplierId(event.target.value)
                            }
                            required
                          >
                            <option value="">
                              {!productTypeId
                                ? "আগে Product Category নির্বাচন করুন"
                                : filteredSuppliers.length
                                  ? "সাপ্লায়ার নির্বাচন করুন"
                                  : "এই ক্যাটাগরিতে সাপ্লায়ার নেই"}
                            </option>
                            {filteredSuppliers.map((supplier) => (
                              <option key={supplier.id} value={supplier.id}>
                                {supplier.name}
                                {supplier.company
                                  ? " · " + supplier.company
                                  : ""}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Button
                          type="button"
                          variant="ghost"
                          className="purchase-quick-add"
                          aria-label="Add Supplier"
                          title="Add Supplier"
                          disabled={
                            !productTypeId ||
                            preview ||
                            !user?.permissions.includes("parties.suppliers")
                          }
                          onClick={() => setQuickAdd("supplier")}
                        >
                          <Plus /> Add
                        </Button>
                      </div>
                      <div className="purchase-product-field purchase-quick-field">
                        <Field label="Product">
                          <select
                            aria-label="Purchase product"
                            value={productName}
                            disabled={!productTypeId || !hasProductOptions}
                            onChange={(event) =>
                              selectProductName(event.target.value)
                            }
                          >
                            <option value="">
                              {!productTypeId
                                ? "আগে পণ্যের ধরন নির্বাচন করুন"
                                : !hasProductOptions
                                  ? "এই ধরনে কোনো পণ্য নেই"
                                  : "পণ্য নির্বাচন করুন"}
                            </option>
                            {productChoices.map((item) => (
                              <option key={item.value} value={item.name}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Button
                          type="button"
                          variant="ghost"
                          className="purchase-quick-add"
                          aria-label="Add Product"
                          title="Add Product"
                          disabled={
                            !productTypeId || preview || !canDefineProduct
                          }
                          onClick={() => setQuickAdd("product")}
                        >
                          <Plus /> Add
                        </Button>
                      </div>
                      <Field
                        label="Model Number"
                        required={individual}
                        className="purchase-model-field"
                      >
                        <input
                          aria-label="Purchase product model number"
                          value={model}
                          placeholder={
                            productName && !individual ? "N/A" : undefined
                          }
                          maxLength={160}
                          disabled={!productName}
                          onChange={(event) => setModel(event.target.value)}
                        />
                      </Field>
                      <Field
                        label="Qty"
                        required
                        className="purchase-quantity-field"
                      >
                        <input
                          aria-label="Purchase quantity"
                          required={Boolean(productName) || !cart.length}
                          type="number"
                          min="1"
                          max={individual ? 500 : 10000}
                          step="1"
                          value={quantity || ""}
                          placeholder="0"
                          onChange={(event) =>
                            setQuantity(Number(event.target.value))
                          }
                        />
                      </Field>
                      <Field
                        label="Unit Price (৳)"
                        required
                        className="purchase-price-field"
                      >
                        <input
                          aria-label="Unit purchase price"
                          required={Boolean(productName) || !cart.length}
                          type="number"
                          min="0"
                          step="0.01"
                          value={unitPrice}
                          onChange={(event) => setUnitPrice(event.target.value)}
                          placeholder="0.00"
                        />
                      </Field>
                    </div>
                    <div className="purchase-basics purchase-product-fields grid">
                      <Field
                        label="Warranty (months)"
                        className="purchase-warranty-field"
                      >
                        <input
                          aria-label="Purchase product warranty"
                          type="number"
                          min="0"
                          max="600"
                          step="1"
                          value={warrantyMonths}
                          disabled={!productName}
                          onFocus={(event) => {
                            if (event.currentTarget.value === "0")
                              event.currentTarget.select();
                          }}
                          onChange={(event) =>
                            setWarrantyMonths(
                              event.target.value.replace(/^0+(?=\d)/, ""),
                            )
                          }
                        />
                      </Field>
                      <Field
                        label="Transport (৳)"
                        required={canPay}
                        className="purchase-transport-field"
                      >
                        <input
                          aria-label="Purchase transport amount"
                          required={canPay}
                          type="number"
                          min="0"
                          max="99999999999999.99"
                          step="0.01"
                          value={transportAmount}
                          placeholder="0.00"
                          disabled={!canPay}
                          onChange={(event) =>
                            setTransportAmount(event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Invoice / Challan No." required>
                        <input
                          required
                          value={reference}
                          onChange={(event) => setReference(event.target.value)}
                          maxLength={160}
                        />
                      </Field>
                      <Field label="Purchase Date" required>
                        <input
                          type="date"
                          value={purchaseDate}
                          onChange={(event) =>
                            setPurchaseDate(event.target.value)
                          }
                          required
                        />
                      </Field>
                      <Button
                        type="submit"
                        className="purchase-add-button"
                        disabled={
                          saving ||
                          loading ||
                          preview ||
                          !canReceive ||
                          options.loading ||
                          (!productName && !cart.length)
                        }
                      >
                        <>
                          {saving ? (
                            <LoaderCircle className="animate-spin" />
                          ) : (
                            <Plus />
                          )}
                          {saving ? "Confirming..." : "Confirm Purchase"}
                        </>
                      </Button>
                    </div>
                    {cart.length > 0 ? (
                      <section
                        className="purchase-pending-products"
                        aria-label="Products in this purchase"
                      >
                        <h3>
                          Products in this purchase <span>{cart.length}</span>
                        </h3>
                        <ul>
                          {cart.map((item) => (
                            <li key={item.productId}>
                              <div className="purchase-pending-name">
                                <strong>{item.name}</strong>
                                <span>
                                  {item.model.trim() || "N/A"} · {item.quantity}{" "}
                                  × {money(item.unitPrice)}
                                </span>
                              </div>
                              <strong>
                                {money(
                                  decimalAmount(
                                    cents(item.unitPrice) *
                                      BigInt(item.quantity),
                                  ),
                                )}
                              </strong>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove ${item.name} from purchase`}
                                onClick={() => {
                                  setCart((items) =>
                                    items.filter(
                                      (line) =>
                                        line.productId !== item.productId,
                                    ),
                                  );
                                  setError("");
                                }}
                              >
                                <X size={16} />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </div>
                </Panel>
              </div>
              <aside className="erp-form-side">
                <Panel>
                  <h2 className="erp-summary-title">
                    <ShoppingCart size={24} />
                    Purchase Summary
                  </h2>
                  <SummaryRows
                    rows={[
                      [
                        "Total Items",
                        String(summaryItems.length + (productName ? 1 : 0)),
                      ],
                      [
                        "Total Quantity",
                        String(
                          summaryItems.reduce(
                            (sum, item) => sum + item.quantity,
                            productName ? quantity : 0,
                          ),
                        ),
                      ],
                      ["Subtotal", money(summaryTotal)],
                      [
                        "Transport",
                        money(
                          showingConfirmed
                            ? (received?.transportAmount ?? "0.00")
                            : transportAmount || "0.00",
                        ),
                      ],
                      ["Paid", money(summaryPaid)],
                      ["Due", money(summaryDue)],
                    ]}
                  />
                  <div className="erp-summary-total">
                    <span>Grand Total</span>
                    <span>{money(summaryTotal)}</span>
                  </div>
                </Panel>
                <Panel title="Payment Information" icon={CreditCard}>
                  <div className="erp-form-body">
                    <Field label="Payment Type">
                      <select
                        aria-label="Payment Type"
                        value={paymentType}
                        onChange={(event) => setPaymentType(event.target.value)}
                      >
                        <option value="full" disabled={!canPay}>
                          Full Payment
                        </option>
                        <option value="due">Due</option>
                        {canPay ? (
                          <>
                            <option value="partial">Partial Payment</option>
                          </>
                        ) : null}
                      </select>
                    </Field>
                    {paymentType === "partial" ? (
                      <fieldset className="purchase-payment-fields grid gap-4">
                        <Field label="Paid Amount (৳)" required>
                          <input
                            aria-label="Purchase paid amount"
                            type="number"
                            min="0"
                            max={total}
                            step="0.01"
                            value={partialPaid}
                            placeholder="0.00"
                            onChange={(event) =>
                              setPartialPaid(event.target.value)
                            }
                            required
                          />
                        </Field>
                        <Field label="Due Amount (৳)">
                          <input
                            aria-label="Purchase due amount"
                            readOnly
                            disabled
                            className="cursor-not-allowed bg-slate-50 text-slate-600"
                            value={due}
                          />
                        </Field>
                        <p className="purchase-payment-hint">
                          মোট টাকা থেকে পরিশোধ বাদ দিয়ে বাকি টাকা কোম্পানির
                          বকেয়ায় যোগ হবে।
                        </p>
                      </fieldset>
                    ) : paymentType === "due" ? (
                      <p className="purchase-payment-hint">
                        ক্রয়মূল্য সাপ্লায়ারের বকেয়ায় যুক্ত হবে।
                      </p>
                    ) : null}
                  </div>
                </Panel>
              </aside>
            </div>
          </fieldset>
          {preview ? (
            <p className="mt-4 text-xs text-amber-700">
              UI preview: লগইন ছাড়া Purchase সেভ হবে না।
            </p>
          ) : null}
        </form>
      )}
      {purchaseDetails ? (
        <PurchaseDetailsDialog
          purchase={purchaseDetails}
          onClose={() => setPurchaseDetails(null)}
          returnFocus={() => detailsRow.current?.focus()}
        />
      ) : null}
      {quickAdd && selectedType ? (
        <PurchaseQuickAdd
          kind={quickAdd}
          type={selectedType}
          onClose={() => setQuickAdd(null)}
          onProductSaved={(created) => {
            setAddedProductNames((items) => [...items, created]);
            selectProductName(created.name);
            setRevision((value) => value + 1);
          }}
          onSupplierSaved={(created) => {
            setAddedSuppliers((items) => [...items, created]);
            setSupplierId(created.id);
            setRevision((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}
