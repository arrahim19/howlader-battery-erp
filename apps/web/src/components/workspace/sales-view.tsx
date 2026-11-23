"use client";
import { randomId } from "@/lib/random-id";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { Dialog } from "radix-ui";
import {
  CalendarDays,
  Check,
  CreditCard,
  FileText,
  List,
  LoaderCircle,
  PackageOpen,
  Plus,
  Search,
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
import { api } from "@/lib/api";
import {
  post,
  type CompletedSale,
  type CustomerRecord,
  type SalesList,
  type SalesOptions,
} from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { notifyDashboardUpdate } from "@/lib/use-dashboard";
import { useLocalReceipt } from "@/lib/use-local-receipt";
import { useBusinessDate } from "@/lib/use-business-date";
import { cents, decimalAmount } from "@/lib/purchase-amounts";
import { money, shortBusinessDate as saleListDate } from "@/lib/utils";
import { CustomerSalesHistoryDialog } from "./customer-sales-history";
import { CustomerForm } from "./customer-form";
import { TransactionView } from "./transaction-view";
import { TransactionDeleteButton } from "./transaction-delete-button";

import {
  SaleProductEntry,
  blankSaleEntry,
  type SaleEntry,
} from "./sale-product-entry";

type SaleLine = {
  entryId?: string;
  productId: string;
  name: string;
  typeName: string;
  quantity: number;
  unitPrice: string;
  model: string;
};
const validPrice = (value: string) => /^\d{1,14}(?:\.\d{1,2})?$/.test(value);
const validUnitPrice = (value: string) =>
  validPrice(value) && cents(value) > BigInt(0);
function saleListMoney(value?: string | null) {
  const formatted = money(value);
  return value != null && Number(value) !== 0
    ? formatted.replace(/\.00$/, "")
    : formatted;
}

function RecentSales({
  data,
  loading,
  error,
  bodyRef,
  onDeleted,
  preview,
  searching,
}: {
  data: SalesList | null;
  loading: boolean;
  error: string;
  bodyRef: RefObject<HTMLDivElement | null>;
  onDeleted: (id: string) => void;
  preview: boolean;
  searching: boolean;
}) {
  const [details, setDetails] = useState<SalesList["items"][number] | null>(
    null,
  );
  const detailsRow = useRef<HTMLTableRowElement | null>(null);
  return (
    <>
      <div className="sales-cart-body sales-history-body" ref={bodyRef}>
        <div className="erp-table-wrap">
          <table className="erp-table">
            <caption className="sr-only">Sales List</caption>
            <colgroup>
              {[17, 12, 23, 5, 12, 12, 12, 7].map((width, index) => (
                <col key={index} style={{ width: `${width}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {[
                  "Invoice",
                  "Date",
                  "Customer",
                  "Qty",
                  "Total (৳)",
                  "Paid (৳)",
                  "Due (৳)",
                  "Action",
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.items.map((sale) => (
                <tr
                  key={sale.id}
                  tabIndex={0}
                  aria-label={`View details for ${sale.invoiceNumber || sale.id}`}
                  className="cursor-pointer hover:bg-green-50 focus-visible:outline-2 focus-visible:outline-green-600 outline-offset-[-2px]"
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (
                      !event.currentTarget.contains(target) ||
                      target.closest("button")
                    )
                      return;
                    detailsRow.current = event.currentTarget;
                    setDetails(sale);
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      detailsRow.current = event.currentTarget;
                      setDetails(sale);
                    }
                  }}
                >
                  <td title={sale.invoiceNumber ?? undefined}>
                    {sale.invoiceNumber || "—"}
                  </td>
                  <td>{saleListDate(sale.saleDate)}</td>
                  <td>
                    {sale.customer.name}
                    <small className="block text-slate-500">
                      {sale.customer.phone}
                    </small>
                  </td>
                  <td>{sale.quantity}</td>
                  <td>{saleListMoney(sale.total)}</td>
                  <td>{saleListMoney(sale.paid)}</td>
                  <td>{saleListMoney(sale.due)}</td>
                  <td>
                    <TransactionDeleteButton
                      kind="sales"
                      id={sale.id}
                      label={sale.invoiceNumber || sale.id}
                      preview={preview}
                      onDeleted={() => onDeleted(sale.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data?.items.length ? (
          <div className="erp-empty sales-cart-empty" role="status">
            <PackageOpen />
            <p>
              {loading
                ? "Loading sales..."
                : error
                  ? "Unable to load sales"
                  : searching
                    ? "No matching sales found"
                    : "No confirmed sales yet"}
            </p>
            <span>নিশ্চিত বিক্রয় এখানে দেখা যাবে।</span>
          </div>
        ) : null}
      </div>
      <div className="erp-pager sales-items-pager">
        <span>{data?.total ?? 0} sales</span>
      </div>
      {details ? (
        <CustomerSalesHistoryDialog
          key={details.id}
          customer={details.customer}
          sale={details}
          preview={preview}
          onClose={() => setDetails(null)}
          returnFocus={() => detailsRow.current?.focus()}
        />
      ) : null}
    </>
  );
}

export function SalesView({
  preview = false,
  view = "",
  loading = false,
  moduleError = "",
  initialCustomerId = "",
}: {
  preview?: boolean;
  view?: string;
  loading?: boolean;
  moduleError?: string;
  initialCustomerId?: string;
}) {
  const user = useSession();
  const [revision, setRevision] = useState(0);
  const current = ["list", "returns", "reports"].includes(view) ? view : "new";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const searchSuffix = query ? `&q=${encodeURIComponent(query)}` : "";
  const options = useCatalogResource<SalesOptions>(
    !preview && !loading && current === "new" ? "/sales/options" : null,
    revision,
  );
  const firstSales = useCatalogResource<SalesList>(
    !preview && !loading && current === "list"
      ? `/sales?page=1&pageSize=100${searchSuffix}`
      : null,
    revision,
  );
  const [allSales, setAllSales] = useState<{
    first: SalesList;
    data: SalesList;
  } | null>(null);
  const [salesFailure, setSalesFailure] = useState<SalesList | null>(null);
  const first = firstSales.data;
  const needsMore = Boolean(first && first.items.length < first.total);
  useEffect(() => {
    if (!first || !needsMore) return;
    const initial = first;
    let active = true;
    async function loadRemaining() {
      const items = [...initial.items];
      const count = Math.ceil(initial.total / 100);
      for (let page = 2; page <= count; page++) {
        const result = await api<SalesList>(
          `/sales?page=${page}&pageSize=100${searchSuffix}`,
        );
        if (!active) return;
        items.push(...result.items);
      }
      if (active) setAllSales({ first: initial, data: { ...initial, items } });
    }
    loadRemaining().catch(() => {
      if (active) setSalesFailure(first);
    });
    return () => {
      active = false;
    };
  }, [first, needsMore, searchSuffix]);
  const salesData = needsMore
    ? allSales?.first === first
      ? allSales.data
      : null
    : first;
  const salesError =
    firstSales.error ||
    (needsMore && salesFailure === first ? "Unable to load sales." : "");
  const listing = {
    data: salesData,
    error: salesError,
    loading:
      firstSales.loading || Boolean(needsMore && !salesData && !salesError),
  };
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [createdCustomers, setCreatedCustomers] = useState<CustomerRecord[]>(
    [],
  );
  const [customerOpen, setCustomerOpen] = useState(false);
  const today = useBusinessDate();
  const [saleDateValue, setSaleDate] = useState<string | null>(null);
  const saleDate = saleDateValue ?? today;
  const [entries, setEntries] = useState<SaleEntry[]>([
    blankSaleEntry("entry-0"),
  ]);
  const entrySequence = useRef(1);
  const entryList = useRef<HTMLDivElement>(null);
  const canPay =
    preview ||
    Boolean(
      user?.permissions.some((permission) =>
        ["finance.write", "payments.customer"].includes(permission),
      ),
    );
  const [saleType, setSaleType] = useState("cash");
  const [partialPaid, setPartialPaid] = useState("");
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [mobilePanel, setMobilePanel] = useState("details");
  const cartBody = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<
    (CompletedSale & { items: SaleLine[] }) | null
  >(null);
  useLocalReceipt(completed, setCompleted, setError);
  const cart: SaleLine[] = entries.flatMap((entry) => {
    const product = options.data?.products.find(
      (product) =>
        product.id === entry.productId && product.type.id === entry.typeId,
    );
    const quantity = /^\d+$/.test(entry.quantity) ? Number(entry.quantity) : 0;
    if (
      !product ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 10000 ||
      !validUnitPrice(entry.unitPrice)
    )
      return [];
    return [
      {
        entryId: entry.id,
        productId: product.id,
        name: product.name,
        typeName: product.type.name,
        quantity,
        unitPrice: decimalAmount(cents(entry.unitPrice)),
        model: product.model,
      },
    ];
  });
  const displayedItems = completed?.items ?? cart;
  const submission = useRef<{ signature: string; key: string } | null>(null);
  const submitting = useRef(false);
  const customers = [
    ...new Map(
      [...createdCustomers, ...(options.data?.customers ?? [])].map(
        (customer) => [customer.id, customer],
      ),
    ).values(),
  ];
  const customer = customers.find((item) => item.id === customerId);
  const totalCents = completed
    ? cents(completed.total)
    : cart.reduce(
        (sum, line) => sum + cents(line.unitPrice) * BigInt(line.quantity),
        BigInt(0),
      );
  const total = decimalAmount(totalCents);
  const paid =
    completed?.paid ??
    (saleType === "cash"
      ? total
      : saleType === "partial"
        ? partialPaid || "0.00"
        : "0.00");
  const due = decimalAmount(totalCents - cents(paid));
  const busy = loading || options.loading;
  const loadError = options.error || listing.error || moduleError;

  function resetEntry() {
    setEntries([blankSaleEntry("entry-0")]);
  }
  function addLine() {
    if (entries.length >= 100) return;
    const row = blankSaleEntry("entry-" + entrySequence.current++);
    row.typeId = entries.at(-1)?.typeId ?? "";
    setEntries((previous) => [...previous, row]);
    setCompleted(null);
    setError("");
    requestAnimationFrame(() => {
      const list = entryList.current;
      if (list) {
        list.scrollTop = 0;
        list.firstElementChild
          ?.querySelector("select")
          ?.focus({ preventScroll: true });
      }
    });
  }
  function updateEntry(id: string, patch: Partial<SaleEntry>) {
    setEntries((previous) =>
      previous.map((entry) =>
        entry.id === id ? { ...entry, ...patch, id } : entry,
      ),
    );
    setCompleted(null);
    setError("");
  }
  function removeEntry(id: string) {
    setEntries((previous) => {
      const remaining = previous.filter((entry) => entry.id !== id);
      return remaining.length ? remaining : [blankSaleEntry("entry-0")];
    });
    setCompleted(null);
    setError("");
  }
  async function completeSale(event: FormEvent) {
    event.preventDefault();
    if (preview || submitting.current || completed) return;
    setError("");
    const items = cart;
    const selected = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const product = options.data?.products.find(
        (product) =>
          product.id === entry.productId && product.type.id === entry.typeId,
      );
      const quantity = /^\d+$/.test(entry.quantity)
        ? Number(entry.quantity)
        : 0;
      if (
        !product ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 10000 ||
        !validUnitPrice(entry.unitPrice)
      ) {
        setError(
          "Product " +
            (index + 1) +
            ": select a product and enter a valid quantity and unit price.",
        );
        return;
      }
      if (quantity > Number(product.availableQuantity)) {
        setError(
          "Product " + (index + 1) + ": quantity exceeds available stock.",
        );
        return;
      }
      if (selected.has(product.id)) {
        setError(
          "This product is already added. Update its existing row or remove the duplicate row.",
        );
        return;
      }
      selected.add(product.id);
    }
    if (!customer || !items.length) {
      setError("একজন customer এবং বিক্রয়ের জন্য অন্তত একটি পণ্য বাছাই করুন।");
      return;
    }
    if (!validPrice(paid) || cents(paid) > totalCents) {
      setError("পরিশোধের পরিমাণ মোট বিক্রয়মূল্যের মধ্যে হতে হবে।");
      return;
    }
    const account = options.data?.paymentAccounts.find(
      (item) => item.paymentMethod === "CASH",
    )?.id;
    if (cents(paid) > BigInt(0) && (!canPay || !account)) {
      setError("পেমেন্ট গ্রহণের জন্য সক্রিয় Cash account প্রয়োজন।");
      return;
    }
    const body = {
      customerId,
      saleDate,
      notes,
      items: items.map(({ productId, quantity, unitPrice }) => ({
        productId,
        quantity,
        unitPrice,
      })),
      paidAmount: decimalAmount(cents(paid)),
      ...(cents(paid) > BigInt(0) ? { paymentAccountId: account } : {}),
    };
    const signature = JSON.stringify(body);
    if (submission.current?.signature !== signature)
      submission.current = { signature, key: randomId() };
    submitting.current = true;
    setSaving(true);
    try {
      const result = await post<CompletedSale>("/sales/complete", body, {
        "Idempotency-Key": submission.current.key,
      });
      setCompleted({ ...result, items });
      resetEntry();
      setPartialPaid("");
      setNotes("");
      submission.current = null;
      setRevision((value) => value + 1);
      notifyDashboardUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "বিক্রয় সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।",
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  if (!["new", "list"].includes(current))
    return (
      <div className="sales-workspace sales-secondary-workspace">
        <TransactionView purchase={false} preview={preview} view={current} />
      </div>
    );

  return (
    <div
      className={`sales-workspace ${current === "new" ? "sales-entry-workspace" : ""}`}
      aria-busy={busy || listing.loading}
    >
      <ModuleTabs
        moduleId="sales"
        current={current}
        preview={preview}
        items={[
          { id: "new", label: "New Sale", icon: ShoppingCart },
          { id: "list", label: "Sales List", icon: List },
        ]}
      />
      <div className="sales-notices">
        {error || loadError ? (
          <div role="alert" className="sales-error">
            <span>{error || loadError}</span>
            {options.error || listing.error ? (
              <Button
                type="button"
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
        <Panel
          title="Sales List"
          className="sales-list-panel"
          action={
            <form
              className="sales-list-filters"
              role="search"
              aria-label="Sales filters"
              onSubmit={(event) => {
                event.preventDefault();
                setQuery(search.trim());
              }}
            >
              <label className="erp-search">
                <Search size={18} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search sales"
                  placeholder="Invoice, customer or mobile"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  maxLength={160}
                />
              </label>
            </form>
          }
        >
          <RecentSales
            data={listing.data}
            loading={loading || listing.loading}
            error={listing.error}
            bodyRef={cartBody}
            preview={preview}
            searching={Boolean(query)}
            onDeleted={(id) => {
              if (completed?.id === id) setCompleted(null);
              setRevision((value) => value + 1);
            }}
          />
        </Panel>
      ) : (
        <form
          onSubmit={completeSale}
          className="sales-form"
          onInvalidCapture={(event) => {
            setMobilePanel(
              (event.target as HTMLElement).closest(".sales-side")
                ? "payment"
                : "details",
            );
          }}
        >
          <nav className="sales-mobile-panels" aria-label="Sale panels">
            {[
              ["details", "Details"],
              ["payment", "Payment"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={mobilePanel === id}
                onClick={() => setMobilePanel(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <fieldset
            disabled={saving || busy || Boolean(moduleError)}
            className="sales-fieldset"
          >
            <legend className="sr-only">Sales details</legend>
            <div className="sales-layout" data-panel={mobilePanel}>
              <div className="sales-main">
                <Panel
                  title="Customer & Invoice"
                  className="sales-customer-panel"
                >
                  <div className="erp-form-body">
                    <div className="sales-customer-fields">
                      <div className="erp-inline-field">
                        <Field label="Customer" required>
                          <select
                            aria-label="Select customer"
                            value={customerId}
                            onChange={(event) =>
                              setCustomerId(event.target.value)
                            }
                            required
                          >
                            <option value="">কাস্টমার নির্বাচন করুন</option>
                            {customers.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name} · {item.phone}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setCustomerOpen(true)}
                        >
                          <Plus />
                          New Customer
                        </Button>
                      </div>
                      <Field
                        label={
                          <>
                            <span className="sales-date-full-label">
                              Invoice Date
                            </span>
                            <span className="sales-date-short-label">Date</span>
                          </>
                        }
                        required
                      >
                        <div
                          className="sales-date-control"
                          title={`Invoice Date: ${saleDate}`}
                        >
                          <input
                            type="date"
                            aria-label="Sale date"
                            value={saleDate}
                            onChange={(event) =>
                              setSaleDate(event.target.value)
                            }
                            required
                          />
                          <CalendarDays
                            className="sales-date-icon"
                            aria-hidden="true"
                          />
                          <span className="sales-date-value" aria-hidden="true">
                            {saleDate
                              ? `${saleDate.slice(8, 10)}/${saleDate.slice(5, 7)}/${saleDate.slice(2, 4)}`
                              : ""}
                          </span>
                        </div>
                      </Field>
                    </div>
                    <p className="sales-customer-contact">
                      {customer
                        ? [customer.phone, customer.address]
                            .filter(Boolean)
                            .join(" · ")
                        : ""}
                    </p>
                  </div>
                </Panel>
                <Panel
                  title="Add Products"
                  className="sales-products-panel"
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addLine}
                      disabled={entries.length >= 100}
                    >
                      <Plus /> Add Another Product
                    </Button>
                  }
                >
                  <div
                    className="erp-form-body sales-product-entries"
                    ref={entryList}
                  >
                    {[...entries].reverse().map((entry, index) => (
                      <SaleProductEntry
                        key={entry.id}
                        entry={entry}
                        index={entries.length - 1 - index}
                        options={options.data}
                        removable={entries.length > 1}
                        onChange={(patch) => updateEntry(entry.id, patch)}
                        onRemove={() => removeEntry(entry.id)}
                      />
                    ))}
                  </div>
                </Panel>
              </div>
              <aside className="sales-side">
                <Panel>
                  <h2 className="erp-summary-title">
                    <ShoppingCart size={24} />
                    Sales Summary
                  </h2>
                  <SummaryRows
                    rows={[
                      ["Total Items", String(displayedItems.length)],
                      [
                        "Total Quantity",
                        String(
                          displayedItems.reduce(
                            (sum, line) => sum + line.quantity,
                            0,
                          ),
                        ),
                      ],
                      ["Subtotal", money(total)],
                    ]}
                  />
                  <div className="erp-summary-total">
                    <span>Grand Total</span>
                    <span>{money(total)}</span>
                  </div>
                </Panel>
                <Panel title="Payment" icon={CreditCard}>
                  <div className="erp-form-body sales-payment-fields">
                    <Field label="Sales Type">
                      <select
                        aria-label="Sales type"
                        disabled={Boolean(completed)}
                        value={saleType}
                        onChange={(event) => {
                          setSaleType(event.target.value);
                          setPartialPaid("");
                        }}
                      >
                        <option value="cash" disabled={!canPay}>
                          Full Payment
                        </option>
                        <option value="partial" disabled={!canPay}>
                          Partial Payment
                        </option>
                        <option value="credit">Due</option>
                      </select>
                    </Field>
                    {saleType === "partial" ? (
                      <div className="sales-partial-payment-fields">
                        <Field label="Paid Amount (৳)" required>
                          <input
                            aria-label="Sales paid amount"
                            type="number"
                            min="0"
                            max={total}
                            step="0.01"
                            value={completed?.paid ?? partialPaid}
                            readOnly={Boolean(completed)}
                            placeholder="0.00"
                            required
                            onChange={(event) =>
                              setPartialPaid(event.target.value)
                            }
                          />
                        </Field>
                        <Field label="Due Amount (৳)">
                          <input
                            aria-label="Sales due amount"
                            readOnly
                            disabled
                            className="cursor-not-allowed bg-slate-50 text-slate-600"
                            value={due}
                          />
                        </Field>
                        <p className="sales-due-hint">
                          মোট টাকা থেকে পরিশোধ বাদ দিয়ে বাকি টাকা কাস্টমারের
                          বকেয়ায় যোগ হবে।
                        </p>
                      </div>
                    ) : saleType === "credit" ? (
                      <p className="sales-due-hint">
                        সম্পূর্ণ {money(total)} কাস্টমারের বকেয়ায় যোগ হবে।
                      </p>
                    ) : null}
                  </div>
                </Panel>
              </aside>
            </div>
          </fieldset>
          <div className="sales-actions">
            {preview ? (
              <span>UI preview: লগইন ছাড়া বিক্রয় সংরক্ষিত হবে না।</span>
            ) : null}
            <div className="sales-confirm-actions">
              <Button
                type="button"
                variant="outline"
                disabled={saving || Boolean(completed)}
                onClick={() => {
                  setNotesDraft(notes);
                  setNotesOpen(true);
                }}
              >
                <FileText />
                {notes ? "Edit Note" : "Add Note"}
              </Button>
              <Button
                type="submit"
                disabled={
                  preview ||
                  saving ||
                  Boolean(completed) ||
                  busy ||
                  !customer ||
                  !cart.length ||
                  Boolean(moduleError)
                }
              >
                {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
                {saving ? "Confirming..." : "Confirm Sale"}
              </Button>
            </div>
          </div>
        </form>
      )}
      <Dialog.Root open={notesOpen} onOpenChange={setNotesOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-60 bg-slate-950/40" />
          <Dialog.Content className="feature-dialog sales-notes-dialog">
            <Dialog.Title className="text-lg font-bold">Sale Note</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-slate-500">
              প্রয়োজন হলে বিক্রয় সংক্রান্ত নোট লিখুন।
            </Dialog.Description>
            <Field label="Sale notes">
              <textarea
                aria-label="Sale notes"
                rows={4}
                maxLength={2000}
                value={notesDraft}
                onChange={(event) => setNotesDraft(event.target.value)}
                placeholder="বিক্রয় সংক্রান্ত কোনো নোট..."
              />
            </Field>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-slate-400">
                {notesDraft.length}/2000
              </span>
              <div className="flex gap-2">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  type="button"
                  onClick={() => {
                    setNotes(notesDraft);
                    setNotesOpen(false);
                  }}
                >
                  Save Note
                </Button>
              </div>
            </div>
            <Dialog.Close
              aria-label="Close note dialog"
              className="absolute top-4 right-4"
            >
              <X size={18} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={customerOpen} onOpenChange={setCustomerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-60 bg-slate-950/40" />
          <Dialog.Content
            className="feature-dialog sales-customer-dialog"
            onInteractOutside={(event) => event.preventDefault()}
          >
            <Dialog.Title className="text-xl font-bold">
              New Customer
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-slate-500">
              Customer-এর যোগাযোগ ও গাড়ির তথ্য দিন। সংরক্ষণ করলে এই বিক্রয়ে
              নির্বাচিত হবে।
            </Dialog.Description>
            <div className="mt-5">
              <CustomerForm
                preview={preview}
                onSaved={(created) => {
                  setCreatedCustomers((items) => [...items, created]);
                  setCustomerId(created.id);
                  setCustomerOpen(false);
                }}
              />
            </div>
            <Dialog.Close
              aria-label="Close customer dialog"
              className="absolute top-4 right-4"
            >
              <X size={18} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
