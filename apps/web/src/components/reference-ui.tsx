"use client";
import Link from "@/components/workspace-link";
import { useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import {
  ChevronLeft,
  ChevronRight,
  Info,
  PackageOpen,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Tone = "green" | "blue" | "orange" | "purple" | "red" | "slate";
export function workspaceHref(moduleId: string, view = "", preview = false) {
  if (moduleId === "products") moduleId = "inventory";
  if (moduleId === "inventory") view = "";
  return preview
    ? `/preview?module=${moduleId}${view ? "&view=" + encodeURIComponent(view) : ""}`
    : `/${moduleId}${view ? "/" + view : ""}`;
}
export function DesignAction({
  children,
  icon: Icon,
  variant = "default",
  className,
  feature,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  variant?: "default" | "outline" | "ghost";
  className?: string;
  feature?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant={variant} className={cn("erp-button", className)}>
          {Icon ? <Icon /> : null}
          {children}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-60 bg-slate-950/40 backdrop-blur-[2px]" />
        <Dialog.Content className="feature-dialog">
          <Dialog.Title className="text-xl font-bold">
            {feature ?? children}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-7 text-slate-600">
            এই পেজের ডিজাইন প্রস্তুত। তথ্য সংরক্ষণ ও লেনদেন নিশ্চিত করার সুবিধা পরবর্তী
            ডেভেলপমেন্ট ধাপে যুক্ত হবে। এই কাজটি কোনো রেকর্ড বা স্টক পরিবর্তন করেনি।
          </Dialog.Description>
          <Button className="mt-6" onClick={() => setOpen(false)}>
            ঠিক আছে
          </Button>
          <Dialog.Close
            className="absolute top-4 right-4 rounded p-1 text-slate-400"
            aria-label="Close dialog"
          >
            <X size={19} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function StatCard({
  label,
  value,
  caption,
  icon: Icon,
  tone = "green",
}: {
  label: ReactNode;
  value: string;
  caption?: ReactNode;
  icon: LucideIcon;
  tone?: Tone;
}) {
  return (
    <section className={cn("erp-stat", "tone-" + tone)}>
      <span className="erp-stat-icon">
        <Icon size={28} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <h2 className="erp-stat-label">{label}</h2>
        <p className="erp-stat-value">{value}</p>
        {caption ? <p className="erp-stat-caption">{caption}</p> : null}
      </div>
    </section>
  );
}
export function Panel({
  title,
  icon: Icon,
  children,
  className,
  action,
}: {
  title?: ReactNode;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={cn("erp-panel", className)}>
      {title ? (
        <div className="erp-panel-heading">
          <h2>
            {Icon ? <Icon size={23} strokeWidth={1.9} /> : null}
            {title}
          </h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
export function ModuleTabs({
  moduleId,
  current,
  preview = false,
  items,
}: {
  moduleId: string;
  current: string;
  preview?: boolean;
  items: { id: string; label: string; icon: LucideIcon; permission?: string }[];
}) {
  return (
    <nav className="erp-tabs" data-module={moduleId} aria-label="Module tabs">
      {items.map(({ id, label, icon: Icon }) => (
        <Link
          key={id}
          href={workspaceHref(moduleId, id, preview)}
          className={cn("erp-tab", current === id && "active")}
          aria-current={current === id ? "page" : undefined}
        >
          <Icon size={20} strokeWidth={1.8} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
export function EmptyTable({
  columns,
  title = "No records to display",
  description = "এখনও কোনো রেকর্ড নেই। তথ্য যুক্ত হলে এই তালিকায় দেখা যাবে।",
  caption,
}: {
  columns: string[];
  title?: string;
  description?: string;
  caption?: string;
}) {
  return (
    <div className="erp-empty-table">
      <div className="erp-table-wrap">
        <table className="erp-table">
          <caption className="sr-only">{caption ?? "Business records"}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody />
        </table>
      </div>
      <div className="erp-empty" role="status">
        <PackageOpen size={34} strokeWidth={1.3} />
        <p>{title}</p>
        <span>{description}</span>
      </div>
    </div>
  );
}
export function Pager() {
  return (
    <div className="erp-pager">
      <label>
        প্রতি পাতায় দেখান:{" "}
        <select aria-label="Rows per page" defaultValue="10">
          <option>10</option>
          <option>25</option>
          <option>50</option>
        </select>
      </label>
      <div>
        <Button
          variant="outline"
          size="icon"
          disabled
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <span className="page-current" aria-current="page">
          1
        </span>
        <Button variant="outline" size="icon" disabled aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
export function DetailPanel({
  title,
  rows,
  footer,
  showHint = true,
}: {
  title: string;
  rows: string[];
  footer?: ReactNode;
  showHint?: boolean;
}) {
  return (
    <Panel title={title} className="erp-details">
      <dl>
        {rows.map((row) => (
          <div key={row}>
            <dt>{row}</dt>
            <dd>
              <span>:</span> —
            </dd>
          </div>
        ))}
      </dl>
      {showHint ? (
        <p className="erp-details-hint">
          বিস্তারিত দেখতে তালিকা থেকে একটি রেকর্ড বাছাই করুন।
        </p>
      ) : null}
      {footer ? <div className="erp-detail-footer">{footer}</div> : null}
    </Panel>
  );
}
export function FoundationNote() {
  return (
    <p className="erp-foundation-note">
      <Info size={14} />
      <span>ডিজাইন প্রস্তুত · সংরক্ষণ ও লেনদেনের সুবিধা পরবর্তী ধাপে যুক্ত হবে।</span>
    </p>
  );
}
export function Field({
  label,
  children,
  required = false,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={cn("erp-field", className)}>
      <span>
        {label}
        {required ? <b className="text-red-500"> *</b> : null}
      </span>
      {children}
    </label>
  );
}
export function SummaryRows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="erp-summary-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
