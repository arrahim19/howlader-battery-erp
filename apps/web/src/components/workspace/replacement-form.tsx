"use client";
import { randomId } from "@/lib/random-id";
import { useState, type FormEvent } from "react";
import { useRouter } from "@/lib/workspace-router";
import { ArrowLeftRight, Plus } from "lucide-react";
import { Field, Panel, workspaceHref } from "@/components/reference-ui";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/session-provider";
import { post, type ReplacementOptions } from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { notifyDashboardUpdate } from "@/lib/use-dashboard";

export function ReplacementForm({ preview }: { preview: boolean }) {
  const router = useRouter();
  const user = useSession();
  const [source, setSource] = useState("CUSTOMER_WARRANTY");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [invoice, setInvoice] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [reason, setReason] = useState("");
  const [quantity, setQuantity] = useState("1");
  const quantityValid =
    Number.isInteger(Number(quantity)) &&
    Number(quantity) >= 1 &&
    Number(quantity) <= 100;
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const options = useCatalogResource<ReplacementOptions>(
    preview
      ? null
      : `/replacements/options?${new URLSearchParams({ source, q: search })}`,
    revision,
  );
  const units = options.data?.units ?? [];
  const products = [
    ...new Map(units.map((item) => [item.productId, item])).values(),
  ];
  const candidates = units.filter((item) => item.productId === selected);
  const invoiceKey = (item: ReplacementOptions["units"][number]) =>
    item.invoice ?? item.saleUnitId ?? item.id;
  const invoices = candidates.filter(
    (item, index) =>
      candidates.findIndex(
        (candidate) => invoiceKey(candidate) === invoiceKey(item),
      ) === index,
  );
  const searchResults = units.filter(
    (item, index) =>
      units.findIndex(
        (candidate) =>
          candidate.productId === item.productId &&
          invoiceKey(candidate) === invoiceKey(item),
      ) === index,
  );
  const unit =
    invoices.length === 1
      ? invoices[0]
      : invoices.find((item) => invoiceKey(item) === invoice);
  const canCreate =
    preview ||
    Boolean(
      user?.permissions.includes(
        source === "CUSTOMER_WARRANTY"
          ? "replacements.intake.customer"
          : "replacements.intake.stock",
      ),
    );
  function selectUnit(value: string) {
    setSelected(value);
    setQuantity("1");
    setInvoice("");
    const matches = units.filter((item) => item.productId === value);
    const next =
      new Set(matches.map(invoiceKey)).size === 1 ? matches[0] : undefined;
    setSupplierId(next?.supplierId ?? "");
    setRequestId(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      preview ||
      saving ||
      !unit ||
      !supplierId ||
      !quantityValid
    )
      return;
    setSaving(true);
    setError("");
    const id = requestId ?? randomId();
    setRequestId(id);
    try {
      await post("/replacements", {
        id,
        source,
        unitId: unit.id,
        ...(unit.saleUnitId ? { saleUnitId: unit.saleUnitId } : {}),
        supplierId,
        faultReason: reason.trim(),
        quantity: Number(quantity),
      });
      notifyDashboardUpdate();
      router.push(workspaceHref("replacements"));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Replacement could not be registered.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Panel title="নতুন রিপ্লেসমেন্ট" icon={ArrowLeftRight}>
      <form className="erp-form-body" onSubmit={(event) => void submit(event)}>
        {error || options.error ? (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
          >
            <span>{error || options.error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        ) : null}
        <fieldset
          disabled={saving}
          className="grid min-w-0 gap-4 border-0 p-0 md:grid-cols-2 xl:grid-cols-[1fr_1.25fr_1.35fr_1fr]"
        >
          <Field label="Replacement Source">
            <select
              aria-label="Replacement Source"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setQuantity("1");
                setSearch("");
                setSearchOpen(false);
                setSelected("");
                setInvoice("");
                setSupplierId("");
                setRequestId(null);
              }}
            >
              <option value="CUSTOMER_WARRANTY">Customer Warranty Claim</option>
              <option value="BEFORE_SALE">Before-Sale Replacement</option>
            </select>
          </Field>
          <div
            className="relative min-w-0"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setSearchOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearchOpen(false);
            }}
          >
            <Field label="Customer / Invoice / Model Number">
              <input
                aria-label="Customer / Invoice / Model Number"
                className="search-input"
                value={search}
                maxLength={160}
                autoComplete="off"
                aria-expanded={searchOpen && Boolean(search.trim())}
                aria-controls="replacement-search-results"
                onFocus={() => setSearchOpen(true)}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSearchOpen(true);
                  setSelected("");
                  setInvoice("");
                  setSupplierId("");
                  setRequestId(null);
                }}
                placeholder="Search customer, invoice or model number..."
              />
            </Field>
            {searchOpen && search.trim() ? (
              <div
                id="replacement-search-results"
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
              >
                {options.loading ? (
                  <p role="status" className="p-3 text-xs text-slate-500">
                    Searching…
                  </p>
                ) : options.error ? (
                  <p role="status" className="p-3 text-xs text-red-700">
                    Search failed. Please retry.
                  </p>
                ) : !searchResults.length ? (
                  <p role="status" className="p-3 text-xs text-slate-500">
                    No eligible batteries found for this search.
                  </p>
                ) : (
                  <ul aria-label="Replacement search results">
                    {searchResults.map((item) => (
                      <li key={`${item.productId}-${invoiceKey(item)}`}>
                        <button
                          type="button"
                          disabled={!canCreate}
                          className="flex w-full flex-col gap-1 border-b border-slate-100 p-3 text-left text-xs hover:bg-green-50 focus-visible:bg-green-50"
                          onClick={() => {
                            setSelected(item.productId);
                            setInvoice(invoiceKey(item));
                            setSupplierId(item.supplierId ?? "");
                            setQuantity("1");
                            setRequestId(null);
                            setSearchOpen(false);
                          }}
                        >
                          <strong>{item.customer ?? item.label}</strong>
                          <span className="text-slate-500">
                            {[item.invoice, item.label]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px] gap-3">
            <Field label="Product / Model Number" required>
              <select
                aria-label="Product / Model Number"
                required
                value={
                  products.some((item) => item.productId === selected)
                    ? selected
                    : ""
                }
                disabled={options.loading || !canCreate}
                onChange={(event) => selectUnit(event.target.value)}
              >
                <option value="">
                  {options.loading
                    ? "Loading batteries…"
                    : "ব্যাটারি নির্বাচন করুন"}
                </option>
                {products.map((item) => (
                  <option key={item.productId} value={item.productId}>
                    {item.label}
                  </option>
                ))}
              </select>
              {!options.loading &&
              !options.error &&
              !units.length &&
              !preview ? (
                <p role="status" className="mt-2 text-xs text-slate-500">
                  {source === "CUSTOMER_WARRANTY"
                    ? "কোনো বিক্রিত ব্যাটারি পাওয়া যায়নি। ইনভয়েস, কাস্টমার বা মডেল দিয়ে খুঁজুন।"
                    : "রিপ্লেসমেন্টের জন্য স্টকে কোনো ব্যাটারি পাওয়া যায়নি।"}
                </p>
              ) : null}
            </Field>
            <Field label="Qty" required>
              <input
                aria-label="Qty"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                required
                value={quantity}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  setRequestId(null);
                }}
              />
            </Field>
          </div>
          <Field label="Supplier" required>
            <select
              aria-label="Supplier"
              required
              value={supplierId}
              disabled={options.loading || !canCreate}
              onChange={(event) => {
                setSupplierId(event.target.value);
                setRequestId(null);
              }}
            >
              <option value="">সাপ্লায়ার নির্বাচন করুন</option>
              {options.data?.suppliers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          {invoices.length > 1 ? (
            <Field label="Customer / Invoice" required>
              <select
                aria-label="Customer / Invoice"
                required
                value={invoice}
                onChange={(event) => {
                  setInvoice(event.target.value);
                  setQuantity("1");
                  setSupplierId(
                    invoices.find(
                      (item) => invoiceKey(item) === event.target.value,
                    )?.supplierId ?? "",
                  );
                  setRequestId(null);
                }}
              >
                <option value="">ইনভয়েস নির্বাচন করুন</option>
                {invoices.map((item) => (
                  <option key={invoiceKey(item)} value={invoiceKey(item)}>
                    {item.invoice} · {item.customer}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field
            label="অভিযোগ / Fault reason"
            className={
              invoices.length > 1
                ? "md:col-span-2 xl:col-span-3"
                : "md:col-span-2 xl:col-span-4"
            }
          >
            <textarea
              aria-label="অভিযোগ / Fault reason"
              maxLength={2000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setRequestId(null);
              }}
              placeholder="ব্যাটারির সমস্যা ও পরীক্ষার ফলাফল লিখুন..."
            />
          </Field>
        </fieldset>
        {!canCreate ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            You do not have permission for this replacement source.
          </p>
        ) : null}
        <div className="mt-5 flex justify-end">
          <Button
            type="submit"
            disabled={
              preview ||
              saving ||
              !canCreate ||
              options.loading ||
              !unit ||
              !supplierId ||
              !quantityValid
            }
          >
            <Plus />
            {saving ? "Registering…" : "Register Replacement"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
