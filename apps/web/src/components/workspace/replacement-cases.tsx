"use client";
import Link from "@/components/workspace-link";
import { useEffect, useState } from "react";
import {
  CheckCheck,
  Clock3,
  PackageCheck,
  Plus,
  Search,
  Truck,
} from "lucide-react";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import {
  EmptyTable,
  Pager,
  Panel,
  StatCard,
  workspaceHref,
} from "@/components/reference-ui";
import {
  post,
  api,
  type ReplacementCase,
  type ReplacementList,
  type ReplacementStage,
} from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { notifyDashboardUpdate } from "@/lib/use-dashboard";
import { businessDate } from "@/lib/utils";
import { ReplacementDeleteButton } from "./replacement-delete-button";

const stages = [
  {
    value: "FAULTY",
    label: "Faulty",
    icon: Clock3,
    tone: "orange",
    permission: "replacements.resolve",
  },
  {
    value: "SENT",
    label: "Sent",
    icon: Truck,
    tone: "purple",
    permission: "replacements.dispatch",
  },
  {
    value: "RECEIVED",
    label: "Received",
    icon: PackageCheck,
    tone: "blue",
    permission: "replacements.receive",
  },
  {
    value: "DELIVERED",
    label: "Delivered",
    icon: CheckCheck,
    tone: "green",
    permission: "replacements.deliver",
  },
] as const;
const columns = [
  "#",
  "ইনভয়েস নং",
  "পণ্য",
  "গ্রাহক",
  "জমার তারিখ",
  "স্ট্যাটাস",
  "অ্যাকশন",
];

export function ReplacementCases({
  preview,
  view,
}: {
  preview: boolean;
  view: string;
}) {
  const user = useSession();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(
    view === "dispatch" ? "SENT" : view === "receipts" ? "RECEIVED" : "all",
  );
  const [revision, setRevision] = useState(0);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [updates, setUpdates] = useState<
    Record<string, { version: number; status: ReplacementStage }>
  >({});
  const params = new URLSearchParams({
    q: search,
    status,
    page: "1",
    pageSize: "100",
  });
  const resource = useCatalogResource<ReplacementList>(
    preview ? null : `/replacements?${params}`,
    revision,
    true,
  );
  const first = resource.data;
  const query = params.toString();
  const [remaining, setRemaining] = useState<{
    first: ReplacementList;
    items: ReplacementCase[];
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!first || first.items.length >= first.total) return;
    const controller = new AbortController();
    const initial = first;
    async function loadRemaining() {
      const items: ReplacementCase[] = [];
      const params = new URLSearchParams(query);
      for (let page = 2; page <= Math.ceil(initial.total / 100); page++) {
        params.set("page", String(page));
        const next = await api<ReplacementList>(`/replacements?${params}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        items.push(...next.items);
        setRemaining({ first: initial, items: [...items], error: "" });
      }
    }
    void loadRemaining().catch((failure: unknown) => {
      if (!controller.signal.aborted)
        setRemaining((previous) => ({
          first: initial,
          items: previous?.first === initial ? previous.items : [],
          error:
            failure instanceof Error
              ? failure.message
              : "Unable to load all replacements.",
        }));
    });
    return () => controller.abort();
  }, [first, query, revision]);
  const extra = remaining?.first === first ? remaining : null;
  const records = [...(first?.items ?? []), ...(extra?.items ?? [])];
  const loadingMore = Boolean(
    first && records.length < first.total && !extra?.error,
  );
  const items = records.map((item) => {
    const update = updates[item.id];
    return update && update.version > item.version
      ? { ...item, ...update }
      : item;
  });
  const summary = resource.data ? { ...resource.data.summary } : null;
  if (summary)
    for (const original of records) {
      const update = updates[original.id];
      if (
        update &&
        update.version > original.version &&
        update.status !== original.status
      ) {
        summary[original.status]--;
        summary[update.status]++;
      }
    }
  async function changeStatus(item: ReplacementCase, next: ReplacementStage) {
    if (savingId || next === item.status || preview) return;
    setSavingId(item.id);
    setError("");
    setMessage("");
    try {
      const saved = await post<{
        id: string;
        status: ReplacementStage;
        version: number;
      }>(`/replacements/${item.id}/status`, {
        status: next,
        version: item.version,
      });
      setUpdates((previous) => ({ ...previous, [item.id]: saved }));
      setMessage(
        `${item.number}: ${stages.find((stage) => stage.value === saved.status)!.label}`,
      );
      setRevision((value) => value + 1);
      notifyDashboardUpdate();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Status could not be saved.",
      );
    } finally {
      setSavingId(null);
    }
  }
  return (
    <>
      <div className="erp-stats replacement-stats">
        {stages.map((stage) => (
          <StatCard
            key={stage.value}
            label={stage.label}
            value={summary ? String(summary[stage.value]) : "—"}
            icon={stage.icon}
            tone={stage.tone}
          />
        ))}
      </div>
      {view === "policy" ? (
        <Panel>
          <EmptyTable
            columns={["কোম্পানি", "পণ্যের ধরন", "ওয়ারেন্টি", "নীতি", "স্ট্যাটাস"]}
          />
          <Pager />
        </Panel>
      ) : view !== "new" ? (
        <>
          <Panel className="mb-4">
            <div className="erp-filterbar">
              <label className="erp-search">
                <Search size={19} />
                <input
                  aria-label="Search replacements"
                  placeholder="ইনভয়েস, সিরিয়াল, গ্রাহকের নাম দিয়ে খুঁজুন..."
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                />
              </label>
              <select
                className="erp-select"
                aria-label="Record status"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                }}
              >
                <option value="all">স্ট্যাটাস: সকল</option>
                {stages.map((stage) => (
                  <option key={stage.value} value={stage.value}>
                    {stage.label}
                  </option>
                ))}
              </select>
              <Button asChild className="erp-button">
                <Link href={workspaceHref("replacements", "new", preview)}>
                  <Plus />
                  নতুন রিপ্লেসমেন্ট
                </Link>
              </Button>
            </div>
          </Panel>
          {message ? (
            <p role="status" className="mb-3 text-sm text-green-700">
              {message}
            </p>
          ) : null}
          {error || resource.error || extra?.error ? (
            <div
              role="alert"
              className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
            >
              <span>{error || resource.error || extra?.error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError("");
                  setRevision((value) => value + 1);
                }}
              >
                Refresh
              </Button>
            </div>
          ) : null}
          <Panel className="replacement-list-panel">
            <div className="erp-table-wrap">
              <table className="erp-table" aria-busy={resource.loading}>
                <caption className="sr-only">Replacement cases</caption>
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
                  {items.length ? (
                    items.map((item, index) => (
                      <tr key={item.id}>
                        <td>{index + 1}</td>
                        <td>{item.invoice ?? "N/A"}</td>
                        <td>{item.product}</td>
                        <td>{item.customer ?? "N/A"}</td>
                        <td>{businessDate(item.createdAt)}</td>
                        <td>
                          <select
                            className="replacement-status"
                            aria-label={`Status for ${item.number}`}
                            value={item.status}
                            disabled={
                              preview ||
                              Boolean(savingId) ||
                              !stages.some((stage) =>
                                user?.permissions.includes(stage.permission),
                              )
                            }
                            onChange={(event) =>
                              void changeStatus(
                                item,
                                event.target.value as ReplacementStage,
                              )
                            }
                          >
                            {stages.map((stage) => (
                              <option
                                key={stage.value}
                                value={stage.value}
                                disabled={
                                  !user?.permissions.includes(stage.permission)
                                }
                              >
                                {stage.label}
                              </option>
                            ))}
                          </select>
                          {savingId === item.id ? (
                            <span
                              role="status"
                              className="ml-2 text-xs text-slate-500"
                            >
                              Saving…
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <ReplacementDeleteButton
                            item={item}
                            preview={preview}
                            onDeleted={() => {
                              setMessage("Replacement deleted.");
                              setRevision((value) => value + 1);
                            }}
                          />
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={columns.length}>
                        <p
                          role="status"
                          className="py-16 text-center text-sm text-slate-500"
                        >
                          {resource.loading
                            ? "Loading records…"
                            : "No records to display"}
                        </p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {loadingMore ? (
              <p
                role="status"
                className="shrink-0 p-2 text-center text-xs text-slate-500"
              >
                Loading more replacements?
              </p>
            ) : null}
          </Panel>
        </>
      ) : null}
    </>
  );
}
