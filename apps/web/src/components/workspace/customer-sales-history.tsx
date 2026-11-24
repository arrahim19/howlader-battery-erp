"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Dialog } from "radix-ui";
import { BrandLogo } from "@/components/brand-logo";
import { CalendarDays, Printer, ReceiptText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CustomerRecord,
  CustomerSalesHistory,
  SalesList,
} from "@/lib/api";
import { api } from "@/lib/api";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import type { ShopSettings } from "@/components/shop-profile-form";
import { useSession } from "@/components/session-provider";
import { CustomerEditor } from "./customer-editor";
import { businessDate, money as formatMoney } from "@/lib/utils";
import { setInvoicePrintTitle } from "@/lib/invoice-print-title";

function money(value?: string | null) {
  const formatted = formatMoney(value);
  return value != null && Number(value) !== 0
    ? formatted.replace(/\.00$/, "")
    : formatted;
}

import { takaInWords, invoiceAmount } from "@/lib/invoice-format";

function InvoicePrintSheet({
  invoice,
  customer,
  shop,
}: {
  invoice: CustomerSalesHistory["items"][number];
  customer: Pick<CustomerRecord, "name" | "phone"> & Partial<CustomerRecord>;
  shop: ShopSettings["value"];
}) {
  const quantity = invoice.products.reduce(
    (sum, product) => sum + Number(product.quantity),
    0,
  );
  return createPortal(
    <section className="sale-invoice-print-sheet" aria-label="Invoice to print">
      <header className="invoice-shop-header">
        <BrandLogo size={64} />
        <div>
          <h1>{shop.name}</h1>
          {shop.tagLine ? (
            <p className="invoice-tagline">
              <strong>{shop.tagLine}</strong>
            </p>
          ) : null}
          {shop.tagLine2 ? (
            <p className="invoice-tagline">{shop.tagLine2}</p>
          ) : null}
          {shop?.address ? (
            <p>
              <strong>ঠিকানা:</strong> {shop.address}
            </p>
          ) : null}
          {shop?.phone ? (
            <p>
              <strong>মোবাইল:</strong> {shop.phone}
            </p>
          ) : null}
        </div>
      </header>
      <div className="invoice-parties">
        <section className="invoice-bill-to">
          <h3>BILL TO</h3>
          <strong>{customer.name}</strong>
          {customer.address ? <p>{customer.address}</p> : null}
          {customer.phone ? <p>Phone: {customer.phone}</p> : null}
        </section>
        <section className="invoice-reference-box">
          <p>
            <span>Invoice No:</span>
            <strong>{invoice.invoiceNumber ?? "Invoice"}</strong>
          </p>
          <p>
            <span>Date:</span>
            <strong>
              {invoice.soldAt
                ? businessDate(invoice.soldAt)
                : "Date unavailable"}
            </strong>
          </p>
        </section>
      </div>
      <h2 className="invoice-document-title">Sales Invoice</h2>
      <table className="invoice-print-products">
        <colgroup>
          {[5, 39, 11, 9, 18, 18].map((width, index) => (
            <col key={index} style={{ width: width + "%" }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {[
              "#",
              "Item name",
              "Quantity",
              "Unit",
              "Price / Unit (Tk)",
              "Amount (Tk)",
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {invoice.products.map((product, index) => (
            <tr key={product.id}>
              <td>{index + 1}</td>
              <td>
                <strong>
                  {product.name}
                  {product.model?.trim() ? ` ${product.model.trim()}` : ""}
                </strong>
              </td>
              <td>{product.quantity}</td>
              <td>{product.unit}</td>
              <td>{invoiceAmount(product.unitPrice)}</td>
              <td>{invoiceAmount(product.amount)}</td>
            </tr>
          ))}
          {invoice.products.length < 12 ? (
            <tr
              className="invoice-empty-row"
              aria-hidden="true"
              style={{
                height: Math.max(12, 100 - invoice.products.length * 10) + "mm",
              }}
            >
              {Array.from({ length: 6 }, (_, i) => (
                <td key={i} />
              ))}
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <th scope="row">Total</th>
            <td>{quantity}</td>
            <td />
            <td />
            <td>
              <strong>{invoiceAmount(invoice.subtotal)}</strong>
            </td>
          </tr>
        </tfoot>
      </table>
      <div className="invoice-summary">
        <div className="invoice-amount-words">
          <p>
            <strong>AMOUNT IN WORDS:</strong> {takaInWords(invoice.total)}
          </p>
          {invoice.notes?.trim() ? (
            <p className="invoice-note">
              <strong>NOTE:</strong> {invoice.notes.trim()}
            </p>
          ) : null}
        </div>
        <div className="invoice-totals-panel">
          <table className="invoice-totals">
            <tbody>
              <tr>
                <th scope="row">Sub Total</th>
                <td>{invoiceAmount(invoice.subtotal)}</td>
              </tr>
              {Number(invoice.discount) !== 0 ? (
                <tr>
                  <th scope="row">Discount</th>
                  <td>-{invoiceAmount(invoice.discount)}</td>
                </tr>
              ) : null}
              <tr className="invoice-total-row">
                <th scope="row">Total</th>
                <td>{invoiceAmount(invoice.total)}</td>
              </tr>
              <tr>
                <th scope="row">Received</th>
                <td>{invoiceAmount(invoice.paid)}</td>
              </tr>
              <tr className="invoice-due-row">
                <th scope="row">Due</th>
                <td>{invoiceAmount(invoice.due)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="invoice-signatures">
        <div>
          <span>Received by</span>
        </div>
        <div>
          <span>Delivered by</span>
        </div>
        <div>
          <span>Authorized Signatory</span>
        </div>
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
  const user = useSession();
  const canEditCustomer =
    !preview && Boolean(user?.permissions.includes("parties.customers"));
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [editedCustomer, setEditedCustomer] = useState<CustomerRecord | null>(
    null,
  );
  const editButton = useRef<HTMLButtonElement>(null);
  const [printingShop, setPrintingShop] = useState<
    ShopSettings["value"] | null
  >(null);
  const [revision, setRevision] = useState(0);
  const [printingInvoice, setPrintingInvoice] = useState<
    CustomerSalesHistory["items"][number] | null
  >(null);
  const [preparingPrint, setPreparingPrint] = useState(false);
  const [printError, setPrintError] = useState("");
  const restorePrintTitle = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      restorePrintTitle.current?.();
    };
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
  const details = editedCustomer ?? history.data?.customer ?? customer;
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
            {canEditCustomer ? (
              <button
                type="button"
                ref={editButton}
                className="customer-history-mark hover:bg-green-100"
                aria-label="Edit customer"
                title="Edit customer"
                onClick={() => setEditingCustomer(true)}
              >
                <ReceiptText size={24} />
              </button>
            ) : (
              <span className="customer-history-mark">
                <ReceiptText size={24} />
              </span>
            )}
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
                          const shop =
                            await api<ShopSettings["value"]>("/shop-profile");
                          if (!shop.name?.trim()) {
                            throw new Error(
                              "Set the shop name in Settings before printing.",
                            );
                          }
                          flushSync(() => {
                            setPrintingShop(shop);
                            setPrintingInvoice(sale);
                          });
                          const image =
                            document.querySelector<HTMLImageElement>(
                              ".sale-invoice-print-sheet img",
                            );
                          if (image) await image.decode();
                          await document.fonts.ready;
                          // Mobile print services can read the PDF name after
                          // afterprint fires. Keep it until this dialog closes.
                          restorePrintTitle.current?.();
                          restorePrintTitle.current = setInvoicePrintTitle(
                            `${shop.name.trim()} - ${sale.invoiceNumber || sale.id}`,
                          );
                          // Allow the browser's title update to reach its print UI.
                          await new Promise<void>((resolve) => {
                            requestAnimationFrame(() => setTimeout(resolve, 0));
                          });
                          window.print();
                        } catch (error) {
                          setPrintingInvoice(null);
                          setPrintError(
                            error instanceof Error
                              ? error.message
                              : "Unable to prepare the invoice. Please try printing again.",
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
          {editingCustomer ? (
            <CustomerEditor
              customerId={customer.id}
              onClose={() => setEditingCustomer(false)}
              returnFocus={() => editButton.current?.focus()}
              onSaved={(updated) => {
                setEditedCustomer(updated);
                setEditingCustomer(false);
                setRevision((n) => n + 1);
              }}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
      {printingInvoice && printingShop ? (
        <InvoicePrintSheet
          invoice={printingInvoice}
          customer={details}
          shop={printingShop}
        />
      ) : null}
    </Dialog.Root>
  );
}
