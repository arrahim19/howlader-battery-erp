"use client";
import Link from "@/components/workspace-link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "@/lib/workspace-router";
import { z } from "zod";
import { Dialog, AlertDialog } from "radix-ui";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  LoaderCircle,
  Plus,
  Pencil,
  Trash2,
  Search,
  ShieldCheck,
  ShoppingCart,
  Truck,
} from "lucide-react";
import {
  EmptyTable,
  Field,
  ModuleTabs,
  Panel,
  StatCard,
  workspaceHref,
} from "@/components/reference-ui";
import { Button } from "@/components/ui/button";
import {
  api,
  csrf,
  post,
  type DashboardData,
  type SupplierList,
  type SupplierRecord,
} from "@/lib/api";
import { money } from "@/lib/utils";
import { useCatalogResource } from "@/lib/use-catalog-resource";
import { useSession } from "@/components/session-provider";

const supplierSchema = z.object({
  productTypeId: z.string().uuid("Product Category নির্বাচন করুন।"),
  name: z.string().trim().min(1, "সাপ্লায়ারের নাম লিখুন।").max(160),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9][0-9 ()-]{5,29}$/, "সঠিক মোবাইল নম্বর লিখুন।"),
  company: z.string().trim().max(160),
});
const columns = ["#", "Product", "নাম", "কোম্পানি / ব্র্যান্ড", "মোবাইল", "অ্যাকশন"];

function SupplierForm({
  preview,
  supplier,
  onSaved,
}: {
  preview: boolean;
  supplier?: SupplierRecord;
  onSaved?: () => void;
}) {
  const categories = useCatalogResource<{ id: string; name: string }[]>(
    preview ? null : "/suppliers/product-types",
    0,
  );
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview || saving) return;
    setError("");
    setFields({});
    const form = new FormData(event.currentTarget);
    const result = supplierSchema.safeParse({
      productTypeId: form.get("productTypeId"),
      name: form.get("name"),
      phone: form.get("phone"),
      company: form.get("company"),
    });
    if (!result.success) {
      setFields(
        Object.fromEntries(
          result.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.message,
          ]),
        ),
      );
      return;
    }
    setSaving(true);
    try {
      if (supplier) {
        await api<SupplierRecord>("/suppliers/" + supplier.id, {
          method: "PATCH",
          headers: { "X-CSRF-Token": await csrf() },
          body: JSON.stringify(result.data),
        });
      } else {
        await post<SupplierRecord>("/suppliers", result.data);
      }
      if (onSaved) onSaved();
      else router.replace("/suppliers");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "সাপ্লায়ার সেভ করা যায়নি। আবার চেষ্টা করুন।",
      );
      setSaving(false);
    }
  }
  return (
    <Panel title={supplier ? "সাপ্লায়ার সম্পাদনা" : "নতুন সাপ্লায়ার"} icon={Truck}>
      <form onSubmit={save} className="erp-form-body supplier-form">
        <fieldset disabled={saving}>
          <legend className="sr-only">Supplier contact information</legend>
          <div className="supplier-form-grid">
            <div>
              <Field label="Product Category" required>
                <select
                  name="productTypeId"
                  aria-label="Supplier product category"
                  required
                  defaultValue={supplier?.productTypeId ?? ""}
                  disabled={categories.loading || !categories.data?.length}
                >
                  <option value="" disabled>
                    {categories.loading
                      ? "Loading categories..."
                      : "ক্যাটাগরি নির্বাচন করুন"}
                  </option>
                  {categories.data?.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </Field>
              {categories.error || fields.productTypeId ? (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {categories.error || fields.productTypeId}
                </p>
              ) : null}
            </div>
            <div>
              <Field label="নাম" required>
                <input
                  name="name"
                  defaultValue={supplier?.name}
                  aria-label="Supplier name"
                  autoComplete="name"
                  placeholder="সাপ্লায়ারের নাম"
                  required
                  maxLength={160}
                  aria-invalid={Boolean(fields.name)}
                  aria-describedby={
                    fields.name ? "supplier-name-error" : undefined
                  }
                />
              </Field>
              {fields.name ? (
                <p
                  id="supplier-name-error"
                  className="mt-1 text-xs text-red-600"
                >
                  {fields.name}
                </p>
              ) : null}
            </div>
            <div>
              <Field label="মোবাইল নম্বর" required>
                <input
                  name="phone"
                  defaultValue={supplier?.phone ?? ""}
                  aria-label="Supplier mobile number"
                  type="tel"
                  autoComplete="tel"
                  placeholder="01XXXXXXXXX"
                  required
                  maxLength={30}
                  aria-invalid={Boolean(fields.phone)}
                  aria-describedby={
                    fields.phone ? "supplier-phone-error" : undefined
                  }
                />
              </Field>
              {fields.phone ? (
                <p
                  id="supplier-phone-error"
                  className="mt-1 text-xs text-red-600"
                >
                  {fields.phone}
                </p>
              ) : null}
            </div>
            <div>
              <Field label="Company / Brand (optional)">
                <input
                  name="company"
                  defaultValue={supplier?.company ?? ""}
                  aria-label="Supplier company or brand"
                  autoComplete="organization"
                  placeholder="কোম্পানির নাম"
                  maxLength={160}
                  aria-invalid={Boolean(fields.company)}
                  aria-describedby={
                    fields.company ? "supplier-company-error" : undefined
                  }
                />
              </Field>
              {fields.company ? (
                <p
                  id="supplier-company-error"
                  className="mt-1 text-xs text-red-600"
                >
                  {fields.company}
                </p>
              ) : null}
            </div>
            <div className="supplier-form-actions">
              {!supplier ? (
                <Button asChild variant="outline">
                  <Link href={workspaceHref("suppliers", "", preview)}>
                    Cancel
                  </Link>
                </Button>
              ) : null}
              <Button
                type="submit"
                disabled={
                  saving ||
                  preview ||
                  categories.loading ||
                  !categories.data?.length
                }
                className="erp-button"
              >
                {saving ? <LoaderCircle className="animate-spin" /> : <Plus />}
                {saving
                  ? "Saving..."
                  : supplier
                    ? "Update Supplier"
                    : "Save Supplier"}
              </Button>
            </div>
          </div>
        </fieldset>
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        {preview ? (
          <p className="mt-4 text-xs text-amber-700">
            UI preview: সাপ্লায়ার সেভ করতে লগইন করুন।
          </p>
        ) : null}
      </form>
    </Panel>
  );
}

export function SupplierView({
  preview,
  view = "",
  data,
}: {
  preview: boolean;
  view?: string;
  data: DashboardData | null;
}) {
  const user = useSession();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [productTypeId, setProductTypeId] = useState("");
  const productTypes = useCatalogResource<{ id: string; name: string }[]>(
    preview ? null : "/suppliers/product-types",
    0,
  );
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<SupplierRecord | null>(null);
  const [deleting, setDeleting] = useState<SupplierRecord | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  async function deleteSupplier() {
    if (!deleting || deletingBusy || preview) return;
    setDeletingBusy(true);
    setDeleteError("");
    try {
      await api("/suppliers/" + deleting.id, {
        method: "DELETE",
        headers: { "X-CSRF-Token": await csrf() },
        body: JSON.stringify({ confirmed: true }),
      });
      setDeleting(null);
      setPage(1);
      setRevision((value) => value + 1);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "সাপ্লায়ার ডিলিট করা যায়নি।",
      );
    } finally {
      setDeletingBusy(false);
    }
  }
  const [result, setResult] = useState<{
    key: string;
    data: SupplierList;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const key = JSON.stringify([query, productTypeId, page, revision]);
  useEffect(() => {
    if (preview || !user) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: query,
      page: String(page),
      pageSize: "10",
    });
    if (productTypeId) params.set("productTypeId", productTypeId);
    api<SupplierList>("/suppliers?" + params, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure({
            key,
            message:
              error instanceof Error
                ? error.message
                : "সাপ্লায়ারের তালিকা পাওয়া যায়নি।",
          });
      });
    return () => controller.abort();
  }, [preview, query, productTypeId, page, key, user]);
  const list = result?.key === key ? result.data : null;
  const error = failure?.key === key ? failure.message : "";
  const loading = !preview && !list && !error;
  const current = view === "new" ? "new" : "list";
  const pages = Math.max(1, Math.ceil((list?.total ?? 0) / 10));
  return (
    <>
      <ModuleTabs
        moduleId="suppliers"
        current={current}
        preview={preview}
        items={[
          { id: "list", label: "Supplier List", icon: Truck },
          { id: "new", label: "Add Supplier", icon: Plus },
          { id: "ledger", label: "Ledger", icon: ClipboardList },
        ]}
      />
      <div className="erp-stats supplier-stats">
        <StatCard
          label="Total Due"
          value={money(preview ? null : data?.financials?.supplierDues)}
          icon={ShieldCheck}
          tone="purple"
        />
        <StatCard
          label="Purchases Amount"
          value={money(preview ? null : data?.financials?.todayPurchases)}
          icon={ShoppingCart}
        />
      </div>
      {error ? (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {current === "new" ? (
        <SupplierForm preview={preview} />
      ) : (
        <>
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
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  maxLength={160}
                  placeholder="নাম, মোবাইল বা কোম্পানি দিয়ে খুঁজুন..."
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
            {productTypes.error ? (
              <p role="alert" className="px-4 pb-3 text-xs text-red-600">
                {productTypes.error}
              </p>
            ) : null}
          </Panel>
          <div className="supplier-list-layout">
            <Panel>
              <div className="supplier-table-body">
                {loading || list?.items.length ? (
                  <div className="erp-table-wrap" aria-busy={loading}>
                    <table className="erp-table">
                      <caption className="sr-only">Suppliers</caption>
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
                        {loading ? (
                          <tr>
                            <td colSpan={columns.length} className="h-32">
                              <span role="status" className="sr-only">
                                Loading suppliers...
                              </span>
                            </td>
                          </tr>
                        ) : null}
                        {list?.items.map((supplier, index) => (
                          <tr key={supplier.id}>
                            <td>{(page - 1) * 10 + index + 1}</td>
                            <td>
                              {supplier.productType?.name || "ক্যাটাগরি সেট করুন"}
                            </td>
                            <td>
                              <span className="font-semibold text-green-800">
                                {supplier.name}
                              </span>
                            </td>
                            <td>{supplier.company || "—"}</td>
                            <td>{supplier.phone || "—"}</td>
                            <td>
                              <div className="flex gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Edit ${supplier.name}`}
                                  disabled={preview}
                                  onClick={() => setEditing(supplier)}
                                >
                                  <Pencil />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="text-red-600"
                                  aria-label={`Delete ${supplier.name}`}
                                  disabled={preview}
                                  onClick={() => {
                                    setDeleteError("");
                                    setDeleting(supplier);
                                  }}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyTable
                    columns={columns}
                    description={
                      query
                        ? "খোঁজার সঙ্গে মেলে এমন সাপ্লায়ার নেই।"
                        : "নতুন সাপ্লায়ার যোগ করলে এখানে দেখা যাবে।"
                    }
                  />
                )}
              </div>
              <div className="erp-pager">
                <span>
                  Page {page} of {pages}
                </span>
                <div>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Previous supplier page"
                    disabled={loading || page <= 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Next supplier page"
                    disabled={loading || page >= pages}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </Panel>
          </div>
        </>
      )}
      <Dialog.Root
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-60 bg-slate-950/40" />
          <Dialog.Content className="feature-dialog supplier-edit-dialog">
            <Dialog.Title className="text-xl font-bold">
              Edit Supplier
            </Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-slate-500">
              সাপ্লায়ারের তথ্য পরিবর্তন করে সেভ করুন।
            </Dialog.Description>
            {editing ? (
              <SupplierForm
                key={editing.id}
                preview={preview}
                supplier={editing}
                onSaved={() => {
                  setEditing(null);
                  setRevision((value) => value + 1);
                }}
              />
            ) : null}
            <Dialog.Close asChild>
              <Button variant="outline" className="mt-3">
                Close
              </Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <AlertDialog.Root
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deletingBusy) setDeleting(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-60 bg-slate-950/40" />
          <AlertDialog.Content className="feature-dialog">
            <AlertDialog.Title className="text-xl font-bold">
              Delete Supplier
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-sm">
              {deleting?.name} ডিলিট করতে চান? লেনদেন থাকা সাপ্লায়ার ডিলিট করা
              যাবে না।
            </AlertDialog.Description>
            {deleteError ? (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {deleteError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button variant="outline" disabled={deletingBusy}>
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button
                disabled={deletingBusy}
                className="bg-red-600 hover:bg-red-700"
                onClick={deleteSupplier}
              >
                {deletingBusy ? "Deleting..." : "Delete Supplier"}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
