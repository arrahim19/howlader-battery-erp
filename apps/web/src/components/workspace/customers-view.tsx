"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/workspace-router";
import { ClipboardList, Plus, Search, Users } from "lucide-react";
import { ModuleTabs, Panel, workspaceHref } from "@/components/reference-ui";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/session-provider";
import { api, type CustomerList, type CustomerRecord } from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { money } from "@/lib/utils";
import { CustomerForm } from "./customer-form";
import { CustomerSalesHistoryDialog } from "./customer-sales-history";
import { CustomerLedgerView } from "./customer-ledger-view";

const columns = ["#", "Customer", "Mobile", "Total Sales", "Due"];
const pageSize = 100;
function customerMoney(value?: string | null) {
  const formatted = money(value);
  return value != null && Number(value) !== 0
    ? formatted.replace(/\.00$/, "")
    : formatted;
}

export function CustomersView({
  preview,
  view = "",
}: {
  preview: boolean;
  view?: string;
}) {
  const router = useRouter();
  const user = useSession();
  const canSell =
    preview || Boolean(user?.permissions.includes("sales.manage"));
  const current = ["new", "credit", "ledger"].includes(view) ? view : "list";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<CustomerRecord | null>(
    null,
  );
  const historyButton = useRef<HTMLElement | null>(null);
  const params = new URLSearchParams({
    q: query,
    status,
    credit: current === "credit" ? "due" : "all",
    page: "1",
    pageSize: String(pageSize),
  });
  const resource = useCatalogResource<CustomerList>(
    preview || current === "ledger" ? null : "/customers?" + params,
    revision,
  );
  const [extra, setExtra] = useState<{
    first: CustomerList;
    items: CustomerRecord[];
    page: number;
  } | null>(null);
  const [scrollError, setScrollError] = useState("");
  const [retry, setRetry] = useState(0);
  const first = resource.data;
  const continuation = extra?.first === first ? extra : null;
  const loadedList =
    first && continuation
      ? { ...first, items: [...first.items, ...continuation.items] }
      : first;
  const hasMore = Boolean(
    loadedList && loadedList.items.length < loadedList.total,
  );
  const list = hasMore ? null : loadedList;
  const loading = resource.loading || (hasMore && !scrollError);
  const nextPage = (continuation?.page ?? 1) + 1;
  const scrollPath = new URLSearchParams(params);
  scrollPath.set("page", String(nextPage));
  const nextPath = "/customers?" + scrollPath;
  useEffect(() => {
    if (!hasMore || !first) return;
    let active = true;
    api<CustomerList>(nextPath)
      .then((data) => {
        if (!active) return;
        setExtra({
          first,
          items: [...(continuation?.items ?? []), ...data.items],
          page: nextPage,
        });
      })
      .catch(() => {
        if (active) setScrollError("Unable to load more customers.");
      });
    return () => {
      active = false;
    };
  }, [hasMore, first, continuation, nextPage, nextPath, retry]);
  const selected = list?.items.find((customer) => customer.id === selectedId);
  const title = current === "credit" ? "Credit Customers" : "Customer List";
  const filters = (
    <form
      className="customer-list-filters"
      role="search"
      aria-label="Customer filters"
      onSubmit={(event) => {
        event.preventDefault();
        setQuery(search.trim());
      }}
    >
      <label className="erp-search">
        <Search size={19} />
        <input
          aria-label="Search customers"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name or mobile"
          maxLength={160}
        />
      </label>
      <select
        className="erp-select"
        aria-label="Customer status"
        value={status}
        onChange={(event) => {
          setStatus(event.target.value);
        }}
      >
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>
    </form>
  );
  return (
    <>
      <ModuleTabs
        moduleId="customers"
        current={current}
        preview={preview}
        items={[
          { id: "list", label: "Customer List", icon: Users },
          { id: "new", label: "Add Customer", icon: Plus },
          { id: "ledger", label: "Ledger", icon: ClipboardList },
        ]}
      />
      {resource.error ? (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          <span>{resource.error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {current === "ledger" ? (
        <CustomerLedgerView preview={preview} />
      ) : current === "new" ? (
        <Panel title="Add Customer" icon={Users}>
          <div className="erp-form-body">
            <CustomerForm
              preview={preview}
              onSaved={() => router.replace("/customers")}
              onCancel={() =>
                router.push(workspaceHref("customers", "", preview))
              }
            />
          </div>
        </Panel>
      ) : (
        <>
          <div className="master-detail-layout customer-master-detail">
            <Panel
              title={title}
              icon={Users}
              className="customer-list-panel"
              action={filters}
            >
              <div className="erp-table-wrap" aria-busy={loading}>
                <table className="erp-table min-w-[680px]">
                  <caption className="sr-only">Customers</caption>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th key={column} scope="col">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {list?.items.map((customer, index) => (
                      <tr
                        key={customer.id}
                        tabIndex={0}
                        aria-label={`View details for ${customer.name}`}
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest("button"))
                            return;
                          historyButton.current = event.currentTarget;
                          setSelectedId(customer.id);
                          setHistoryCustomer(customer);
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            historyButton.current = event.currentTarget;
                            setSelectedId(customer.id);
                            setHistoryCustomer(customer);
                          }
                        }}
                        className={
                          selected?.id === customer.id
                            ? "cursor-pointer bg-green-50 outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-green-600"
                            : "cursor-pointer hover:bg-green-50 outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-green-600"
                        }
                      >
                        <td>{index + 1}</td>
                        <td>
                          <button
                            type="button"
                            className="text-left font-semibold text-green-800 hover:underline"
                            aria-pressed={selected?.id === customer.id}
                            onClick={(event) => {
                              historyButton.current = event.currentTarget;
                              setSelectedId(customer.id);
                              setHistoryCustomer(customer);
                            }}
                          >
                            {customer.name}
                          </button>
                        </td>
                        <td className="whitespace-nowrap">{customer.phone}</td>

                        <td className="whitespace-nowrap">
                          {customerMoney(customer.totalSales)}
                        </td>
                        <td className="whitespace-nowrap">
                          {customerMoney(customer.due)}
                        </td>
                      </tr>
                    ))}
                    {!list?.items.length ? (
                      <tr>
                        <td colSpan={columns.length}>
                          <div
                            role="status"
                            className="flex min-h-48 items-center justify-center p-6 text-center text-sm text-slate-500"
                          >
                            {loading
                              ? "Loading customers..."
                              : resource.error || scrollError
                                ? "Unable to load customers."
                                : preview
                                  ? "Sign in to view customer records."
                                  : current === "credit"
                                    ? "No customers have an outstanding balance."
                                    : query
                                      ? "No matching customers."
                                      : "No customers yet. Add a customer here or from New Sale."}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {hasMore && scrollError ? (
                      <tr>
                        <td colSpan={columns.length} className="text-center">
                          {scrollError ? (
                            <Button
                              variant="outline"
                              onClick={() => {
                                setScrollError("");
                                setRetry((value) => value + 1);
                              }}
                            >
                              Retry loading customers
                            </Button>
                          ) : (
                            <span role="status">Loading more customers...</span>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <div className="erp-pager">
                <span>
                  {list ? `${list.total} customers` : "—"}
                </span>
              </div>
            </Panel>
            <Panel
              title="Customer Details"
              className="erp-details customer-details-panel"
              action={
                <Button
                  type="button"
                  size="sm"
                  className="customer-new-sale"
                  disabled={!selected?.active || !canSell}
                  onClick={() => {
                    if (!selected?.active || !canSell) return;
                    router.push(
                      preview
                        ? workspaceHref("sales", "new", true)
                        : `/sales/new?customer=${encodeURIComponent(selected.id)}`,
                    );
                  }}
                >
                  <Plus />
                  New Sale
                </Button>
              }
            >
              {selected ? (
                <>
                  <dl>
                    {[
                      ["Name", selected.name],
                      ["Mobile", selected.phone],
                      ["Address", selected.address || "—"],
                      ["Total Sales", customerMoney(selected.totalSales)],
                      ["Outstanding Due", customerMoney(selected.due)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd className="min-w-0 [overflow-wrap:anywhere]">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
            </Panel>
          </div>
        </>
      )}
      {historyCustomer ? (
        <CustomerSalesHistoryDialog
          key={historyCustomer.id}
          customer={historyCustomer}
          preview={preview}
          onClose={() => setHistoryCustomer(null)}
          returnFocus={() => historyButton.current?.focus()}
        />
      ) : null}
    </>
  );
}
