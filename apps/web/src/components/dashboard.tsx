"use client";
import Link from "@/components/workspace-link";
import { useRef, useState } from "react";
import { Dialog } from "radix-ui";
import {
  ArrowLeftRight,
  ArrowRight,
  BatteryCharging,
  Boxes,
  CalendarDays,
  CheckCheck,
  Clock3,
  Eye,
  Package,
  Plus,
  ShoppingCart,
  TriangleAlert,
  Truck,
  UserRoundCheck,
  Users,
  Wallet,
  Wrench,
  X,
} from "lucide-react";
import { useSession } from "@/components/session-provider";
import { Button } from "@/components/ui/button";
import { CustomerSalesHistoryDialog } from "@/components/workspace/customer-sales-history";
import type { DashboardData } from "@/lib/api";
import { businessDate, money } from "@/lib/utils";
import { useDashboardData } from "@/lib/use-dashboard";
import { useBusinessDate } from "@/lib/use-business-date";
import {
  EmptyTable,
  Field,
  Panel,
  StatCard,
  workspaceHref,
} from "@/components/reference-ui";

export function Dashboard({ preview = false }: { preview?: boolean }) {
  const user = useSession();
  const today = useBusinessDate();
  const [period, setPeriod] = useState("today");
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ from: today, to: today });
  const [details, setDetails] = useState<
    DashboardData["recentSales"][number] | null
  >(null);
  const detailsTrigger = useRef<HTMLElement | null>(null);
  const start = new Date((today || "2000-01-01") + "T12:00:00Z");
  start.setUTCDate(
    start.getUTCDate() - (period === "week" ? 6 : period === "month" ? 29 : 0),
  );
  const from =
    period === "custom"
      ? custom.from || today
      : today
        ? start.toISOString().slice(0, 10)
        : "";
  const to = period === "custom" ? custom.to || today : today;
  const { data, error, loading, refresh } = useDashboardData({
    preview,
    from,
    to,
  });
  const finance = preview || !user || user.permissions.includes("finance.read");
  const count = (value?: string | number) =>
    value == null || preview ? "—" : String(value);
  const taka = (value?: string) => money(preview ? null : value);
  const has = (permission: string) =>
    preview || !user || user.permissions.includes(permission);
  return (
    <div className="dashboard-page">
      <div className="dashboard-intro">
        <div>
          <h2>
            স্বাগতম, {preview ? "Admin" : (user?.name ?? "Admin")}{" "}
            <span aria-hidden="true">👋</span>
          </h2>
          <p>আজকের ব্যবসার সারসংক্ষেপ দেখুন</p>
        </div>
        <div
          className="date-pills"
          role="group"
          aria-label="Dashboard date range"
        >
          {[
            ["today", "আজ"],
            ["week", "এই সপ্তাহ"],
            ["month", "এই মাস"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={period === value ? "active" : ""}
              onClick={() => setPeriod(value)}
              aria-pressed={period === value}
            >
              {label}
            </button>
          ))}
          <Dialog.Root open={customOpen} onOpenChange={setCustomOpen}>
            <Dialog.Trigger asChild>
              <button
                className={
                  "custom-range " + (period === "custom" ? "active" : "")
                }
              >
                কাস্টম রেঞ্জ
                <CalendarDays size={15} />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/40" />
              <Dialog.Content className="feature-dialog">
                <Dialog.Title className="text-xl font-bold">
                  তারিখ নির্বাচন করুন
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-xs text-slate-500">
                  Asia/Dhaka সময় অনুযায়ী সারসংক্ষেপ দেখুন।
                </Dialog.Description>
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    setCustom({
                      from: String(fields.get("from")),
                      to: String(fields.get("to")),
                    });
                    setPeriod("custom");
                    setCustomOpen(false);
                  }}
                >
                  <Field label="শুরুর তারিখ">
                    <input
                      type="date"
                      name="from"
                      required
                      defaultValue={custom.from || today}
                      max={custom.to || today}
                    />
                  </Field>
                  <Field label="শেষ তারিখ">
                    <input
                      type="date"
                      name="to"
                      required
                      defaultValue={custom.to || today}
                      min={custom.from}
                    />
                  </Field>
                  <Button type="submit">সারসংক্ষেপ দেখুন</Button>
                </form>
                <Dialog.Close
                  className="absolute top-4 right-4"
                  aria-label="Close date range"
                >
                  <X size={18} />
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
        <div className="dashboard-actions">
          {has("sales.manage") ? (
            <Button asChild className="erp-button">
              <Link href={workspaceHref("sales", "new", preview)}>
                <Plus />
                New Sale
              </Link>
            </Button>
          ) : null}
          {has("purchases.manage") ? (
            <Button asChild variant="outline" className="erp-button">
              <Link href={workspaceHref("purchases", "new", preview)}>
                <Plus />
                New Purchase
              </Link>
            </Button>
          ) : null}
          {has("finance.read") ? (
            <Button asChild variant="outline" className="erp-button">
              <Link href={workspaceHref("accounts", undefined, preview)}>
                <Wallet />
                Accounts
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={refresh}>
            আবার চেষ্টা করুন
          </Button>
        </div>
      ) : null}
      <div
        className="erp-stats"
        data-finance={Boolean(finance)}
        aria-busy={loading}
      >
        {finance ? (
          <>
            <StatCard
              label="মোট বিক্রয়"
              value={taka(data?.financials?.todaySales)}

              icon={ShoppingCart}
            />
            <StatCard
              label="স্টকের ক্রয়মূল্য"
              value={taka(data?.financials?.availableStockPurchaseValue)}

              icon={Boxes}
              tone="blue"
            />
            <StatCard
              label="কাস্টমার বাকি"
              value={taka(data?.financials?.customerDues)}

              icon={Wallet}
              tone="orange"
            />
            <StatCard
              label="কোম্পানির বাকি"
              value={taka(data?.financials?.supplierDues)}

              icon={Truck}
              tone="purple"
            />
          </>
        ) : (
          <>
            <StatCard
              label="সক্রিয় পণ্য"
              value={count(data?.counts.products)}
              icon={Package}
            />
            <StatCard
              label="কাস্টমার"
              value={count(data?.counts.customers)}
              icon={Users}
              tone="blue"
            />
            <StatCard
              label="বিক্রয়যোগ্য স্টক"
              value={count(data?.counts.availableStock)}
              icon={Boxes}
            />
            <StatCard
              label="কম স্টক পণ্য"
              value={count(data?.counts.lowStock)}
              icon={TriangleAlert}
              tone="orange"
            />
            <StatCard
              label="পেন্ডিং রিপ্লেসমেন্ট"
              value={count(data?.counts.pendingReplacements)}
              icon={ArrowLeftRight}
              tone="purple"
            />
          </>
        )}
      </div>
      <div className="dashboard-middle">
        <Panel
          className="dashboard-recent-sales"
          title="সাম্প্রতিক বিক্রয় (Recent Sales)"
          action={
            <Link
              className="flex items-center gap-2 text-xs font-semibold text-sky-800"
              href={workspaceHref("sales", "list", preview)}
            >
              সবগুলো দেখুন
              <ArrowRight size={16} />
            </Link>
          }
        >
          {data?.recentSales.length ? (
            <div className="erp-table-wrap">
              <table className="erp-table">
                <caption className="sr-only">Recent Sales</caption>
                <thead>
                  <tr>
                    {["ইনভয়েস", "তারিখ", "কাস্টমার", "মোট টাকা", "Details"].map(
                      (label) => (
                        <th key={label}>{label}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.recentSales.slice(0, 5).map((sale) => (
                    <tr
                      key={sale.id}
                      tabIndex={
                        !preview &&
                        sale.customerId &&
                        (has("sales.manage") || has("parties.customers"))
                          ? 0
                          : undefined
                      }
                      className={
                        !preview &&
                        sale.customerId &&
                        (has("sales.manage") || has("parties.customers"))
                          ? "cursor-pointer hover:bg-green-50 focus-visible:outline-2 focus-visible:outline-green-600 outline-offset-[-2px]"
                          : undefined
                      }
                      onClick={(event) => {
                        if (
                          preview ||
                          !sale.customerId ||
                          !(has("sales.manage") || has("parties.customers")) ||
                          (event.target as HTMLElement).closest("button")
                        )
                          return;
                        detailsTrigger.current = event.currentTarget;
                        setDetails(sale);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.target !== event.currentTarget ||
                          preview ||
                          !sale.customerId ||
                          !(has("sales.manage") || has("parties.customers"))
                        )
                          return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          detailsTrigger.current = event.currentTarget;
                          setDetails(sale);
                        }
                      }}
                    >
                      <td>{sale.invoiceNumber}</td>
                      <td>
                        {sale.soldAt
                          ? businessDate(sale.soldAt.slice(0, 10))
                          : "—"}
                      </td>
                      <td>{sale.customer}</td>
                      <td>{money(sale.total)}</td>
                      <td>
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          disabled={
                            preview ||
                            !sale.customerId ||
                            !(has("sales.manage") || has("parties.customers"))
                          }
                          aria-label={`Details ${sale.invoiceNumber ?? sale.id}`}
                          onClick={(event) => {
                            detailsTrigger.current = event.currentTarget;
                            setDetails(sale);
                          }}
                        >
                          <Eye />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyTable
              title="No invoices yet"
              description="নিশ্চিত বিক্রয়ের পর ইনভয়েস ও পরিশোধের তথ্য এখানে দেখা যাবে।"
              columns={["ইনভয়েস", "তারিখ", "কাস্টমার", "মোট টাকা", "Details"]}
            />
          )}
        </Panel>
        <Panel title="স্টক সারসংক্ষেপ">
          <div className="summary-stack">
            {[
              {
                label: "ব্যাটারি",
                english: "Available",
                value: data?.stock?.batteriesAvailable,
                icon: BatteryCharging,
                tone: "",
              },
              {
                label: "পার্টস / অন্যান্য",
                english: "Available",
                value: data?.stock?.partsAvailable,
                icon: Wrench,
                tone: "slate",
              },
              {
                label: "কম স্টক পণ্য",
                english: "Low Stock",
                value: data?.counts.lowStock,
                icon: TriangleAlert,
                tone: "orange",
              },
              {
                label: "রিপ্লেসেবল",
                english: "বিক্রয়যোগ্য নয়",
                value: data?.stock?.replaceable,
                icon: Package,
                tone: "red",
              },
            ].map((item) => (
              <div className={"summary-line " + item.tone} key={item.label}>
                <item.icon />
                <span>
                  {item.label} <small>({item.english})</small>
                </span>
                <strong>{count(item.value)} টি</strong>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="রিপ্লেসমেন্ট স্ট্যাটাস" icon={ArrowLeftRight}>
          <div className="summary-stack">
            {[
              {
                label: "পাঠানোর অপেক্ষায়",
                english: "Pending Return",
                value: data?.replacementStages?.pendingReturn,
                icon: Clock3,
                tone: "purple",
              },
              {
                label: "কোম্পানিতে পাঠানো হয়েছে",
                english: "Sent to Company",
                value: data?.replacementStages?.sentToCompany,
                icon: Truck,
                tone: "blue",
              },
              {
                label: "রিপ্লেসমেন্ট পাওয়া গেছে",
                english: "Replacement Received",
                value: data?.replacementStages?.received,
                icon: CheckCheck,
                tone: "",
              },
              {
                label: "কাস্টমারকে দেওয়ার জন্য প্রস্তুত",
                english: "Ready for Delivery",
                value: data?.replacementStages?.readyForDelivery,
                icon: UserRoundCheck,
                tone: "orange",
              },
            ].map((item) => (
              <div className={"summary-line " + item.tone} key={item.english}>
                <item.icon />
                <span>{item.label}</span>
                <strong>{count(item.value)} টি</strong>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {details?.customerId ? (
        <CustomerSalesHistoryDialog
          key={details.id}
          customer={{
            id: details.customerId,
            name: details.customer,
            phone: details.customerPhone ?? "",
          }}
          sale={{
            id: details.id,
            total: details.total,
            paid: details.paid ?? "0",
            due: details.due ?? details.total,
          }}
          preview={preview}
          onClose={() => setDetails(null)}
          returnFocus={() => detailsTrigger.current?.focus()}
        />
      ) : null}
    </div>
  );
}
