"use client";
import { useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Dialog } from "radix-ui";
import Image from "next/image";
import {
  BatteryCharging,
  Users,
  CalendarDays,
  MapPin,
  Phone,
  Printer,
  ReceiptText,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CustomerRecord,
  CustomerSalesHistory,
  SalesList,
} from "@/lib/api";
import { api } from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { businessDate, money as formatMoney } from "@/lib/utils";

function money(value?: string | null) {
  const formatted = formatMoney(value);
  return value != null && Number(value) !== 0
    ? formatted.replace(/\.00$/, "")
    : formatted;
}

import { invoiceProductsImage } from "@/lib/invoice-image";

function InvoicePrintSheet({
  invoice,
  customer,
}: {
  invoice: CustomerSalesHistory["items"][number];
  customer: Pick<CustomerRecord, "name" | "phone"> & Partial<CustomerRecord>;
}) {
  return createPortal(
    <section className="sale-invoice-print-sheet" aria-label="Invoice to print">
      <header className="invoice-brand-banner">
        <div className="invoice-brand-lockup">
          <BatteryCharging className="invoice-brand-icon" strokeWidth={2.2} />
          <div>
            <h1>Howlader Battery</h1>
            <p>Battery &amp; Auto Parts</p>
          </div>
        </div>
        <div className="invoice-brand-tag">
          Auto Easy Bike Battery &amp; Parts
        </div>
        <Image
          className="invoice-product-montage"
          src={invoiceProductsImage}
          width={1920}
          height={800}
          alt=""
          unoptimized
          loading="eager"
        />
        <svg
          className="invoice-brand-wave"
          viewBox="0 0 1000 85"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path fill="#83c83e" d="M0 16Q250 140 510 54T1000 12V85H0Z" />
          <path fill="#24933c" d="M0 30Q250 137 520 65T1000 25V85H0Z" />
          <path fill="#086524" d="M0 47Q260 139 530 76T1000 43V85H0Z" />
        </svg>
      </header>
      <div className="invoice-document-title">
        <span />
        <h2>Sales Invoice</h2>
        <span />
      </div>
      <div className="invoice-page-content">
        <div className="invoice-parties">
          <section className="invoice-customer-box">
            <h3>
              <Users /> Customer Information
            </h3>
            <div className="invoice-customer-lines">
              <p>
                <Users />
                <strong>{customer.name}</strong>
              </p>
              <p>
                <Phone />
                <span>{customer.phone}</span>
              </p>
              <p>
                <MapPin />
                <span>{customer.address || "N/A"}</span>
              </p>
            </div>
          </section>
          <section className="invoice-reference-box">
            <div>
              <ReceiptText />
              <p>
                <span>Invoice No.</span>
                <strong>{invoice.invoiceNumber ?? "Invoice"}</strong>
              </p>
            </div>
            <div>
              <CalendarDays />
              <p>
                <span>Invoice Date</span>
                <strong>
                  {invoice.soldAt
                    ? businessDate(invoice.soldAt)
                    : "Date unavailable"}
                </strong>
              </p>
            </div>
          </section>
        </div>
        <div className="invoice-products-frame">
          <table className="invoice-print-products">
            <colgroup>
              {[24, 18, 14, 22, 22].map((width, index) => (
                <col key={index} style={{ width: width + "%" }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {["Product", "Model", "Qty", "Unit Price", "Total"].map(
                  (label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {invoice.products.map((product) => (
                <tr key={product.id}>
                  <td>{product.name}</td>
                  <td>{product.model?.trim() || "N/A"}</td>
                  <td>
                    {product.quantity} {product.unit}
                  </td>
                  <td>{money(product.unitPrice)}</td>
                  <td>{money(product.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="invoice-grand-total">
          <span>Invoice Total</span>
          <strong>{money(invoice.total)}</strong>
        </div>
        <div className="invoice-signature">
          <p className="invoice-signature-name">Howlader</p>
          <strong>Proprietor</strong>
          <p>Howlader Battery House</p>
        </div>
        <footer className="invoice-location">
          <span />
          <p>
            <MapPin />
            <strong>Location:</strong> College Road, Betagi-8740
          </p>
          <span />
        </footer>
      </div>
    </section>,
    document.body,
  );
}

export function CustomerSalesHistoryDialog({
  customer,
  sale,
  preview,
  onClose,
  returnFocus,
}: {
  customer: Pick<CustomerRecord, "id" | "name" | "phone"> &
    Partial<CustomerRecord>;
  sale?: Pick<SalesList["items"][number], "id" | "total" | "paid" | "due">;
  preview: boolean;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [printingInvoice, setPrintingInvoice] = useState<
    CustomerSalesHistory["items"][number] | null
  >(null);
  const [preparingPrint, setPreparingPrint] = useState(false);
  const [printError, setPrintError] = useState("");
  useEffect(() => {
    if (!printingInvoice) return;
    const previousTitle = document.title;
    document.title = `Howlader Battery House - ${printingInvoice.invoiceNumber || printingInvoice.id}`;
    return () => {
      document.title = previousTitle;
    };
  }, [printingInvoice]);
  useEffect(() => {
    const image = new window.Image();
    image.src = invoiceProductsImage;
  }, []);
  useEffect(() => {
    const finishPrinting = () => setPrintingInvoice(null);
    window.addEventListener("afterprint", finishPrinting);
    return () => window.removeEventListener("afterprint", finishPrinting);
  }, []);
  const firstHistory = useCatalogResource<CustomerSalesHistory>(
    preview
      ? null
      : `/customers/${customer.id}/sales?page=1&pageSize=50${sale ? "&saleId=" + encodeURIComponent(sale.id) : ""}`,
    revision,
  );
  const [allHistory, setAllHistory] = useState<{
    first: CustomerSalesHistory;
    data: CustomerSalesHistory;
  } | null>(null);
  const [historyFailure, setHistoryFailure] =
    useState<CustomerSalesHistory | null>(null);
  const first = firstHistory.data;
  const needsMore = Boolean(first && first.items.length < first.total);
  const saleId = sale?.id;
  useEffect(() => {
    if (!needsMore || !first) return;
    const initial = first;
    let active = true;
    async function loadRemaining() {
      const items = [...initial.items];
      for (let page = 2; page <= Math.ceil(initial.total / 50); page++) {
        const result = await api<CustomerSalesHistory>(
          `/customers/${customer.id}/sales?page=${page}&pageSize=50${saleId ? "&saleId=" + encodeURIComponent(saleId) : ""}`,
        );
        if (!active) return;
        items.push(...result.items);
      }
      if (active)
        setAllHistory({ first: initial, data: { ...initial, items } });
    }
    loadRemaining().catch(() => {
      if (active) setHistoryFailure(initial);
    });
    return () => {
      active = false;
    };
  }, [first, needsMore, customer.id, saleId]);
  const historyData = needsMore
    ? allHistory?.first === first
      ? allHistory.data
      : null
    : first;
  const historyError =
    firstHistory.error ||
    (needsMore && historyFailure === first
      ? "Unable to load sales history."
      : "");
  const history = {
    data: historyData,
    error: historyError,
    loading:
      firstHistory.loading ||
      Boolean(needsMore && !historyData && !historyError),
  };
  const details = history.data?.customer ?? customer;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="customer-history-overlay" />
        <Dialog.Content
          className="feature-dialog customer-history-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus();
          }}
        >
          <header className="customer-history-header">
            <span className="customer-history-mark">
              <ReceiptText size={24} />
            </span>
            <div className="customer-history-heading">
              <div className="customer-history-title-line">
                <Dialog.Title>
                  {sale ? "Sale Details" : "Customer Details"}
                </Dialog.Title>
                {!sale ? (
                  <span className="customer-history-invoice-count">
                    Total Invoices:{" "}
                    <strong>{history.data?.total ?? "—"}</strong>
                  </span>
                ) : null}
              </div>
              <p className="customer-history-name-line">
                <span>{details.name}</span>
                <span className="customer-history-header-phone">
                  {details.phone || "—"}
                </span>
              </p>
            </div>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="customer-history-close"
                aria-label="Close customer details"
              >
                <X />
              </Button>
            </Dialog.Close>
          </header>
          <div className="customer-history-body">
            {sale ? (
              <div className="customer-history-summary">
                {[
                  ["Total", money(sale.total)],
                  ["Paid", money(sale.paid)],
                  ["Due", money(sale.due)],
                ].map(([label, value]) => (
                  <div key={label} className="customer-history-stat">
                    <p className="text-[11px] text-slate-500">{label}:</p>
                    <p className="font-bold">{value}</p>
                  </div>
                ))}
              </div>
            ) : null}
            <h2 className="customer-history-section-title">
              <ReceiptText size={18} className="text-green-700" />
              {sale ? "Sold Products" : "Sales History"}
            </h2>
            {printError ? (
              <p role="alert" className="mb-3 text-sm text-red-700">
                {printError}
              </p>
            ) : null}
            {history.error ? (
              <div
                role="alert"
                className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
              >
                <span>{history.error}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            <div className="grid gap-4" aria-busy={history.loading}>
              {history.data?.items.map((sale) => (
                <article key={sale.id} className="customer-history-invoice">
                  <div className="customer-history-invoice-header">
                    <div>
                      <h3 className="text-sm font-bold">
                        {sale.invoiceNumber ?? "Invoice"}
                      </h3>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                        <CalendarDays size={13} />
                        <time dateTime={sale.soldAt ?? undefined}>
                          {sale.soldAt
                            ? businessDate(sale.soldAt)
                            : "Date unavailable"}
                        </time>
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Print invoice ${sale.invoiceNumber ?? sale.id}`}
                      disabled={preparingPrint}
                      onClick={async () => {
                        setPreparingPrint(true);
                        setPrintError("");
                        try {
                          flushSync(() => setPrintingInvoice(sale));
                          const image =
                            document.querySelector<HTMLImageElement>(
                              ".sale-invoice-print-sheet img",
                            );
                          if (image) await image.decode();
                          await document.fonts.ready;
                          window.print();
                        } catch {
                          setPrintingInvoice(null);
                          setPrintError(
                            "Invoice image could not load. Please try printing again.",
                          );
                        } finally {
                          setPreparingPrint(false);
                        }
                      }}
                    >
                      <Printer size={14} /> Print
                    </Button>
                  </div>
                  <div className="erp-table-wrap">
                    <table className="erp-table customer-history-products">
                      <caption className="sr-only">
                        Products sold on invoice {sale.invoiceNumber ?? sale.id}
                      </caption>
                      <thead>
                        <tr>
                          {[
                            "Product",
                            "Model",
                            "Qty",
                            "Unit Price",
                            "Amount",
                          ].map((label) => (
                            <th
                              key={label}
                              scope="col"
                              className={
                                label === "Model"
                                  ? "invoice-model-column"
                                  : undefined
                              }
                            >
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sale.products.map((product) => (
                          <tr key={product.id}>
                            <td className="font-medium">{product.name}</td>
                            <td className="invoice-model-column">
                              {product.model?.trim() || "N/A"}
                            </td>
                            <td className="whitespace-nowrap">
                              {product.quantity} {product.unit}
                            </td>
                            <td className="whitespace-nowrap">
                              {money(product.unitPrice)}
                            </td>
                            <td className="whitespace-nowrap font-semibold">
                              {money(product.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="customer-history-invoice-total">
                    <span>Invoice Total</span>
                    <strong>{money(sale.total)}</strong>
                  </div>
                </article>
              ))}
              {!history.data?.items.length && !history.error ? (
                <p
                  role="status"
                  className="rounded-xl border border-slate-200 px-4 py-10 text-center text-sm text-slate-500"
                >
                  {history.loading
                    ? "Loading sales history…"
                    : preview
                      ? "Sign in to view sales history."
                      : "No sales recorded for this customer."}
                </p>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      {printingInvoice ? (
        <InvoicePrintSheet invoice={printingInvoice} customer={details} />
      ) : null}
    </Dialog.Root>
  );
}
