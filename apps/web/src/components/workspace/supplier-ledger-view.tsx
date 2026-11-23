"use client";

import Link from "@/components/workspace-link";
import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Plus,
  Search,
  ShieldCheck,
  ShoppingCart,
  Truck,
  X,
} from "lucide-react";
import {
  EmptyTable,
  ModuleTabs,
  Panel,
  StatCard,
  workspaceHref,
} from "@/components/reference-ui";
import { Button } from "@/components/ui/button";
import type { SupplierLedger, SupplierLedgerList } from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { businessDate, money } from "@/lib/utils";

function SupplierStatement({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const ledger = useCatalogResource<SupplierLedger>(
    `/suppliers/${id}/ledger`,
    revision,
  );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-70 bg-slate-950/40" />
        <Dialog.Content className="feature-dialog supplier-statement-dialog">
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-lg font-bold">Ledger</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close ledger">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-slate-600">
            {ledger.data?.supplier.name ?? "সাপ্লায়ারের লেনদেন"}
          </Dialog.Description>
          {ledger.error ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-red-600"
            >
              {ledger.error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : ledger.loading ? (
            <p role="status">Loading ledger...</p>
          ) : ledger.data ? (
            <>
              <p className="mb-3 text-sm font-semibold">
                বকেয়া {money(ledger.data.supplier.due)}
              </p>
              <div className="erp-table-wrap">
                <table className="erp-table">
                  <caption className="sr-only">Supplier transactions</caption>
                  <thead>
                    <tr>
                      {[
                        "তারিখ",
                        "চালান / রেফারেন্স",
                        "বিবরণ",
                        "ক্রেডিট",
                        "ডেবিট",
                        "বকেয়া",
                      ].map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.data.items.map((item) => (
                      <tr key={item.id}>
                        <td className="whitespace-nowrap">
                          {businessDate(item.date)}
                        </td>
                        <td>{item.reference}</td>
                        <td>{item.description}</td>
                        <td>{money(item.credit)}</td>
                        <td>{money(item.debit)}</td>
                        <td>{money(item.balance)}</td>
                      </tr>
                    ))}
                    {!ledger.data.items.length ? (
                      <tr>
                        <td colSpan={6}>কোনো লেনদেন নেই।</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const columns = ["#", "নাম", "কোম্পানি", "মোবাইল নম্বর", "ক্রয়", "বকেয়া"];

export function SupplierLedgerView({ preview }: { preview: boolean }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [productTypeId, setProductTypeId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statementId, setStatementId] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (productTypeId) params.set("productTypeId", productTypeId);
  const list = useCatalogResource<SupplierLedgerList>(
    preview ? null : `/suppliers/ledger?${params}`,
    revision,
  );
  const productTypes = useCatalogResource<{ id: string; name: string }[]>(
    preview ? null : "/suppliers/product-types",
    revision,
  );
  const selected =
    list.data?.items.find((supplier) => supplier.id === selectedId) ??
    list.data?.items[0];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / pageSize));
  const details = selected
    ? [
        ["নাম", selected.name],
        ["মোবাইল", selected.phone || "—"],
        ["ক্রেডিট লিমিট", "—"],
        ["বকেয়া", money(selected.due)],
        ["স্থিতি", selected.active ? "Active" : "Inactive"],
      ]
    : [];
  return (
    <div className="supplier-ledger">
      <ModuleTabs
        moduleId="suppliers"
        current="ledger"
        preview={preview}
        items={[
          { id: "list", label: "Supplier List", icon: Truck },
          { id: "new", label: "Add Supplier", icon: Plus },
          { id: "ledger", label: "Ledger", icon: ClipboardList },
        ]}
      />
      <div className="erp-stats supplier-stats">
        <StatCard
          label="Total Payable"
          value={money(list.data?.summary.totalDue)}
          icon={ShieldCheck}
          tone="purple"
        />
        <StatCard
          label="Total Purchases"
          value={money(list.data?.summary.totalPurchases)}
          icon={ShoppingCart}
        />
      </div>
      <Panel className="mb-4">
        <form
          className="erp-filterbar supplier-list-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search.trim());
            setPage(1);
          }}
        >
          <label className="erp-search">
            <Search size={19} />
            <input
              aria-label="Search suppliers"
              placeholder="নাম, মোবাইল বা কোম্পানি দিয়ে খুঁজুন..."
              value={search}
              maxLength={160}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            className="erp-select"
            aria-label="Filter suppliers by product"
            value={productTypeId}
            disabled={productTypes.loading}
            onChange={(event) => {
              setProductTypeId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Product: সকল</option>
            {productTypes.data?.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
          <Button asChild className="erp-button">
            <Link href={workspaceHref("suppliers", "new", preview)}>
              <Plus />
              নতুন সাপ্লায়ার
            </Link>
          </Button>
        </form>
      </Panel>
      {list.error || productTypes.error ? (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          {list.error || productTypes.error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <div className="master-detail-layout">
        <Panel>
          <div className="supplier-table-body">
            {list.loading ? (
              <p role="status" className="p-4 text-sm">
                Loading suppliers...
              </p>
            ) : list.data?.items.length ? (
              <div className="erp-table-wrap">
                <table className="erp-table">
                  <caption className="sr-only">
                    Supplier ledger balances
                  </caption>
                  <thead>
                    <tr>
                      {columns.map((label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((supplier, index) => (
                      <tr
                        key={supplier.id}
                        className={
                          selected?.id === supplier.id
                            ? "bg-green-50"
                            : undefined
                        }
                      >
                        <td>{(page - 1) * pageSize + index + 1}</td>
                        <td>
                          <button
                            type="button"
                            className="font-semibold text-green-800 hover:underline focus-visible:underline"
                            aria-label={`বিস্তারিত ${supplier.name}`}
                            aria-pressed={selected?.id === supplier.id}
                            onClick={() => setSelectedId(supplier.id)}
                          >
                            {supplier.name}
                          </button>
                        </td>
                        <td>{supplier.company || "—"}</td>
                        <td>{supplier.phone || "—"}</td>
                        <td className="whitespace-nowrap">
                          {money(supplier.totalPurchases)}
                        </td>
                        <td className="whitespace-nowrap">
                          {money(supplier.due)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : !list.error ? (
              <EmptyTable
                columns={columns}
                description={
                  query || productTypeId
                    ? "কোনো সাপ্লায়ার পাওয়া যায়নি।"
                    : "নতুন সাপ্লায়ার যোগ করলে এখানে দেখাবে।"
                }
              />
            ) : null}
          </div>
          <div className="erp-pager">
            <label>
              প্রতি পাতায়{" "}
              <select
                aria-label="Rows per page"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {[10, 25, 50].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span>
                Page {page} of {pages}
              </span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous supplier page"
                disabled={list.loading || page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next supplier page"
                disabled={list.loading || page >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </Panel>
        <Panel title="সাপ্লায়ারের বিস্তারিত" className="erp-details">
          {selected ? (
            <dl>
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="p-4 text-sm text-slate-500">
              বিস্তারিত দেখতে একটি সাপ্লায়ার নির্বাচন করুন।
            </p>
          )}
          <div className="erp-detail-footer">
            <Button
              variant="outline"
              disabled={!selected}
              onClick={() => selected && setStatementId(selected.id)}
            >
              <ClipboardList />
              লেজার দেখুন
            </Button>
          </div>
        </Panel>
      </div>
      {statementId ? (
        <SupplierStatement
          id={statementId}
          onClose={() => setStatementId(null)}
        />
      ) : null}
    </div>
  );
}
