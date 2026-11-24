"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Field } from "@/components/reference-ui";
import { Button } from "@/components/ui/button";
import {
  api,
  post,
  type CatalogMetadata,
  type CatalogProduct,
} from "@/lib/api";

export function ProductEditor({
  productId,
  metadata,
  onSaved,
  onCancel,
  onBusyChange,
}: {
  productId: string;
  metadata: CatalogMetadata | null;
  onSaved: () => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<CatalogProduct>(`/products/${productId}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setProduct(data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : "Unable to load product.",
          );
      });
    return () => controller.abort();
  }, [productId, revision]);
  function reload() {
    setProduct(null);
    setError("");
    setRevision((n) => n + 1);
  }
  if (!product)
    return error ? (
      <div className="mt-5 space-y-3">
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
        <Button variant="outline" onClick={reload}>
          Retry
        </Button>
      </div>
    ) : (
      <p role="status" className="mt-5 text-sm text-slate-500">
        Loading product…
      </p>
    );
  const names = (metadata?.categories ?? []).filter((name) =>
    name.typeIds?.includes(product.type.id),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !product?.version) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    setSaving(true);
    onBusyChange(true);
    setError("");
    try {
      await post(`/products/${product.id}`, {
        version: product.version,
        name: text("name"),
        model: text("model"),
        unit: text("unit"),
        defaultSellingPrice: text("defaultSellingPrice"),
        warrantyMonths: Number(text("warrantyMonths")),
      });
      onSaved();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save product.",
      );
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-5 space-y-4">
      <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
        <Field label="Product Category">
          <input value={product.type.name} readOnly />
        </Field>
        <Field label="Product Name" required>
          <select name="name" defaultValue={product.name} required>
            {!names.some((name) => name.name === product.name) ? (
              <option value={product.name}>{product.name}</option>
            ) : null}
            {names.map((name) => (
              <option key={name.id} value={name.name}>
                {name.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Model"
          required={product.type.trackingKind === "BATTERY_UNIT"}
        >
          <input
            name="model"
            defaultValue={product.model}
            maxLength={160}
            required={product.type.trackingKind === "BATTERY_UNIT"}
          />
        </Field>
        <Field label="Unit" required>
          <input
            name="unit"
            readOnly={!product.unitEditable}
            defaultValue={product.unit}
            maxLength={30}
            required
          />
        </Field>
        <Field label="Default selling price" required>
          <input
            name="defaultSellingPrice"
            inputMode="decimal"
            defaultValue={product.defaultSellingPrice}
            pattern="\d{1,18}(\.\d{1,2})?"
            required
          />
        </Field>
        <Field label="Warranty (months)" required>
          <input
            name="warrantyMonths"
            type="number"
            min="0"
            max="600"
            step="1"
            defaultValue={product.warrantyMonths}
            required
          />
        </Field>
      </fieldset>
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={reload}
            disabled={saving}
          >
            Reload product
          </Button>
        </div>
      ) : null}
      {!product.version ? (
        <p role="status" className="text-sm text-amber-700">
          Connect and sync this product before editing.
        </p>
      ) : null}
      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !product.version}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
