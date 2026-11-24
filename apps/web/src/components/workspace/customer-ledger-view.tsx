"use client";
import { BrandLogo } from "@/components/brand-logo";
import { randomId } from "@/lib/random-id";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ClipboardList,
  CreditCard,
  Eye,
  MapPin,
  Phone,
  Plus,
  Search,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/reference-ui";
import { useSession } from "@/components/session-provider";
import { api, post, type CustomerLedger, type CustomerList } from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { useBusinessDate } from "@/lib/use-business-date";
import { notifyDashboardUpdate } from "@/lib/use-dashboard";
import { businessDate, money, shortBusinessDate } from "@/lib/utils";
import { cents } from "@/lib/purchase-amounts";
import { CustomerSalesHistoryDialog } from "./customer-sales-history";

function CollectPaymentDialog({
  ledger,
  onClose,
  onSaved,
}: {
  ledger: CustomerLedger;
  onClose: () => void;
  onSaved: (receipt: string) => void;
}) {
  const today = useBusinessDate();
  const [dateValue, setDate] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState(ledger.paymentAccounts[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const submission = useRef<{ body: string; key: string } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const body = {
      date: dateValue ?? today,
      amount,
      paymentAccountId: account,
      reference: reference.trim(),
    };
    const serialized = JSON.stringify(body);
    if (submission.current?.body !== serialized)
      submission.current = { body: serialized, key: randomId() };
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await post<{ number: string }>(
        `/customers/${ledger.customer.id}/payments`,
        body,
        { "Idempotency-Key": submission.current.key },
      );
      notifyDashboardUpdate();
      onSaved(result.number);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not save payment.",
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="customer-history-overlay" />
        <Dialog.Content className="feature-dialog ledger-payment-dialog">
          <header>
            <span className="ledger-payment-mark">
              <Wallet size={22} />
            </span>
            <div>
              <Dialog.Title>Collect Due</Dialog.Title>
              <Dialog.Description>{ledger.customer.name}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={saving}
                aria-label="Close payment"
              >
                <X size={18} />
              </Button>
            </Dialog.Close>
          </header>
          <form onSubmit={save}>
            <div className="ledger-payment-due">
              <span>Current outstanding due</span>
              <strong>{money(ledger.customer.due)}</strong>
            </div>
            <fieldset disabled={saving} className="ledger-payment-fields">
              <Field label="Amount (৳)" required>
                <input
                  autoFocus
                  aria-label="Collection amount"
                  type="number"
                  min="0.01"
                  max={ledger.customer.due}
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  required
                />
              </Field>
              <Field label="Payment date" required>
                <input
                  aria-label="Collection date"
                  type="date"
                  value={dateValue ?? today}
                  onChange={(event) => setDate(event.target.value)}
                  required
                />
              </Field>
              <Field label="Payment account" required>
                <select
                  aria-label="Collection account"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  required
                >
                  {ledger.paymentAccounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference / note">
                <input
                  aria-label="Collection reference"
                  value={reference}
                  maxLength={160}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="Receipt or transaction reference"
                />
              </Field>
            </fieldset>
            <p className="ledger-payment-hint">
              Payment will be applied to the oldest outstanding invoices.
            </p>
            {error ? (
              <p role="alert" className="ledger-error">
                {error}
              </p>
            ) : null}
            <footer>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !account}>
                {saving ? "Saving…" : "Save Payment"}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CustomerLedgerView({ preview }: { preview: boolean }) {
  const user = useSession();
  const today = useBusinessDate();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [period, setPeriod] = useState({ from: "", to: "" });
  const [revision, setRevision] = useState(0);
  const [collecting, setCollecting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [receipt, setReceipt] = useState("");
  const historyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const firstCustomers = useCatalogResource<CustomerList>(
    preview
      ? null
      : `/customers?${new URLSearchParams({ q: query, status: "all", credit: "all", page: "1", pageSize: "100" })}`,
    revision,
    true,
  );
  const [allCustomers, setAllCustomers] = useState<{
    first: CustomerList;
    data: CustomerList;
  } | null>(null);
  const [customerFailure, setCustomerFailure] = useState<CustomerList | null>(
    null,
  );
  const first = firstCustomers.data;
  const needsMore = Boolean(first && first.items.length < first.total);
  useEffect(() => {
    if (!needsMore || !first) return;
    const initial = first;
    let active = true;
    async function loadRemaining() {
      const items = [...initial.items];
      const params = new URLSearchParams({
        q: query,
        status: "all",
        credit: "all",
        pageSize: "100",
      });
      for (
        let nextPage = 2;
        nextPage <= Math.ceil(initial.total / 100);
        nextPage++
      ) {
        params.set("page", String(nextPage));
        const result = await api<CustomerList>("/customers?" + params);
        if (!active) return;
        items.push(...result.items);
      }
      if (active)
        setAllCustomers({ first: initial, data: { ...initial, items } });
    }
    loadRemaining().catch(() => {
      if (active) setCustomerFailure(initial);
    });
    return () => {
      active = false;
    };
  }, [needsMore, first, query]);
  const customerData = needsMore
    ? allCustomers?.first === first
      ? allCustomers.data
      : null
    : first;
  const customerError =
    firstCustomers.error ||
    (needsMore && customerFailure === first ? "Unable to load customers." : "");
  const customers = {
    data: customerData,
    error: customerError,
    loading:
      firstCustomers.loading ||
      Boolean(needsMore && !customerData && !customerError),
  };
  const selected = customers.data?.items.find((item) => item.id === selectedId);
  const resource = useCatalogResource<CustomerLedger>(
    !preview && selected
      ? `/customers/${selected.id}/ledger?${new URLSearchParams(period.from && period.to ? period : {})}`
      : null,
    revision,
    true,
  );
  const ledger = resource.data;
  const recentItems = ledger ? [...ledger.items].reverse() : [];
  const customer = ledger?.customer ?? selected;
  const canCollect = Boolean(
    user?.permissions.some((p) =>
      ["finance.write", "payments.customer"].includes(p),
    ),
  );
  // Omit empty dates so the API can distinguish all-time from a filtered statement.
  const hasPeriod = Boolean(period.from && period.to);
  return (
    <section className="customer-ledger" aria-label="Customer ledger">
      <div className="ledger-print-brand">
        <div className="ledger-print-identity">
          <BrandLogo size={40} />
          Howlader Battery
        </div>
        <span>Customer statement</span>
      </div>
      <div className="ledger-layout">
        <aside className="ledger-customers erp-panel">
          <div className="ledger-customer-search">
            <Search size={17} />
            <input
              aria-label="Search ledger customers"
              placeholder="Customer name or mobile"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={160}
            />
          </div>
          <div className="ledger-customer-list" aria-busy={customers.loading}>
            {customers.data?.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={selected?.id === item.id ? "selected" : ""}
                aria-pressed={selected?.id === item.id}
                onClick={() => {
                  setSelectedId(item.id);
                  setReceipt("");
                }}
              >
                <span className="ledger-avatar">{item.name.slice(0, 1)}</span>
                <span className="ledger-customer-name">
                  <strong>{item.name}</strong>
                  <small>{item.phone}</small>
                </span>
                <span
                  className={
                    cents(item.due) > BigInt(0)
                      ? "ledger-customer-due has-due"
                      : "ledger-customer-due"
                  }
                >
                  {money(item.due)}
                  <small>Due</small>
                </span>
              </button>
            ))}
            {!customers.data?.items.length ? (
              <p className="ledger-empty">
                {customers.loading
                  ? "Loading customers…"
                  : customers.error
                    ? "Unable to load customers."
                    : preview
                      ? "Sign in to view customers."
                      : "No matching customers."}
              </p>
            ) : null}
            {customers.error ? (
              <Button
                variant="outline"
                onClick={() => setRevision((value) => value + 1)}
              >
                Retry
              </Button>
            ) : null}
          </div>
          <div className="ledger-customer-pager">
            <span>{customers.data?.total ?? 0} customers</span>
          </div>
        </aside>
        <div className="ledger-statement">
          <div className="ledger-customer-card erp-panel">
            <span className="ledger-profile-icon">
              <Users size={23} />
            </span>
            <div className="ledger-contact">
              <h3 className="ledger-name-line">
                <span
                  className="ledger-customer-display-name"
                  title={customer?.name}
                >
                  {customer?.name ?? "Select a customer"}
                </span>
                {customer?.phone ? (
                  <span className="ledger-heading-phone">
                    <Phone size={13} />
                    {customer.phone}
                  </span>
                ) : null}
              </h3>
              <div>
                {customer?.address ? (
                  <span>
                    <MapPin size={13} />
                    {customer.address}
                  </span>
                ) : null}
              </div>
            </div>
            <Button
              size="sm"
              disabled={
                !ledger ||
                !customer?.active ||
                !canCollect ||
                !ledger.paymentAccounts.length ||
                cents(customer?.due ?? "0") <= BigInt(0) ||
                Boolean(resource.error)
              }
              onClick={() => setCollecting(true)}
            >
              <Plus size={16} /> Collect Due
            </Button>
          </div>
          <div
            className="ledger-period"
            role="group"
            aria-label="Ledger date range"
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!today}
              onClick={() => {
                const start = today.slice(0, 7) + "-01";
                setPeriod({ from: start, to: today });
              }}
            >
              This Month
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setPeriod({ from: "", to: "" });
              }}
            >
              All Time
            </Button>
          </div>
          {resource.error || customers.error ? (
            <div role="alert" className="ledger-error">
              <span>{resource.error || customers.error}</span>
              {resource.error || customers.error ? (
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
          {receipt ? (
            <div role="status" className="ledger-success">
              <span>Payment received · {receipt}</span>
              <button
                type="button"
                aria-label="Dismiss payment confirmation"
                onClick={() => setReceipt("")}
              >
                <X size={16} />
              </button>
            </div>
          ) : null}
          <div className="ledger-summary">
            {[
              {
                label: "মোট বিক্রি",
                value: ledger?.summary.debit,
                icon: ArrowUpRight,
                tone: "debit",
              },
              {
                label: "মোট জমা",
                value: ledger?.summary.credit,
                icon: ArrowDownLeft,
                tone: "credit",
              },
              {
                label: "শেষ বাকি",
                value: ledger?.summary.closing,
                icon: CreditCard,
                tone: "closing",
              },
            ].map((item) => (
              <div key={item.label} className={"ledger-stat " + item.tone}>
                <span className="ledger-stat-icon">
                  <item.icon size={18} />
                </span>
                <div>
                  <span>{item.label}</span>
                  <strong>{money(item.value)}</strong>
                </div>
              </div>
            ))}
          </div>
          <div
            className="ledger-transactions erp-panel"
            aria-busy={resource.loading}
          >
            <header>
              <div>
                <h3>
                  <ClipboardList size={18} /> লেনদেনের হিসাব
                </h3>
                <p>
                  {hasPeriod
                    ? `${businessDate(period.from)} – ${businessDate(period.to)}`
                    : "সব সময়ের হিসাব"}
                </p>
              </div>
              <Button
                ref={historyButton}
                size="sm"
                variant="outline"
                disabled={!customer}
                onClick={() => setHistoryOpen(true)}
              >
                <Eye size={15} /> Invoice Details
              </Button>
            </header>
            <div className="ledger-table-scroll">
              <table className="erp-table ledger-table">
                <caption className="sr-only">
                  Customer ledger transactions
                </caption>
                <thead>
                  <tr>
                    {[
                      "তারিখ",
                      "ইনভয়েস",
                      "বিক্রি (৳)",
                      "জমা (৳)",
                      "বাকি (৳)",
                    ].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentItems.map((item) => (
                    <tr key={item.id}>
                      <td className="ledger-date">
                        {shortBusinessDate(item.date)}
                      </td>
                      <td className="ledger-reference" title={item.reference}>
                        {item.reference}
                        {item.description ? (
                          <span className="ledger-description">
                            {item.description}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {item.kind === "payment"
                          ? "N/A"
                          : item.debit !== "0.00"
                            ? money(item.debit)
                            : "—"}
                      </td>
                      <td className="ledger-credit">
                        {cents(item.credit) ? money(item.credit) : "—"}
                      </td>
                      <td>{money(item.balance)}</td>
                    </tr>
                  ))}
                  {ledger && ledger.summary.opening !== "0.00" ? (
                    <tr className="ledger-opening-row">
                      <td colSpan={2}>
                        আগের বাকি
                        {hasPeriod ? " · " + businessDate(period.from) : ""}
                      </td>
                      <td>—</td>
                      <td>—</td>
                      <td>{money(ledger?.summary.opening)}</td>
                    </tr>
                  ) : null}
                  {!ledger?.items.length ? (
                    <tr>
                      <td colSpan={5}>
                        <div role="status" className="ledger-empty">
                          <ClipboardList size={30} />
                          <strong>
                            {resource.loading
                              ? "Loading statement…"
                              : !customer
                                ? "Select a customer"
                                : "No transactions in this period"}
                          </strong>
                          <span>
                            {!customer
                              ? "Choose a customer to view their account statement."
                              : "Adjust the date range to see more transactions."}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2}>
                      মোট
                    </th>
                    <td>{money(ledger?.summary.debit)}</td>
                    <td>{money(ledger?.summary.credit)}</td>
                    <td>{money(ledger?.summary.closing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      </div>
      {collecting && ledger ? (
        <CollectPaymentDialog
          ledger={ledger}
          onClose={() => setCollecting(false)}
          onSaved={(number) => {
            setCollecting(false);
            setReceipt(number);
            setRevision((value) => value + 1);
          }}
        />
      ) : null}
      {historyOpen && customer ? (
        <CustomerSalesHistoryDialog
          customer={customer}
          preview={preview}
          onClose={() => setHistoryOpen(false)}
          returnFocus={() => historyButton.current?.focus()}
        />
      ) : null}
    </section>
  );
}
