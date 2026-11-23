"use client";

import { useState, type FormEvent } from "react";
import { post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ShopSettings = {
  value: { name?: string; address?: string; phone?: string };
  version: number;
};

export function ShopProfileForm({
  shop,
  disabled,
  preview,
  onSaved,
}: {
  shop: ShopSettings | null;
  disabled: boolean;
  preview: boolean;
  onSaved: (shop: ShopSettings) => void;
}) {
  const [name, setName] = useState(shop?.value?.name ?? "");
  const [address, setAddress] = useState(shop?.value?.address ?? "");
  const [phone, setPhone] = useState(shop?.value?.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const dirty =
    name !== (shop?.value?.name ?? "") ||
    address !== (shop?.value?.address ?? "") ||
    phone !== (shop?.value?.phone ?? "");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || preview || saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await post<ShopSettings>("/settings/shop", {
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim(),
        version: shop?.version ?? 0,
      });
      setName(updated.value.name ?? "");
      setAddress(updated.value.address ?? "");
      setPhone(updated.value.phone ?? "");
      onSaved(updated);
      setSaved(true);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save shop profile.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <fieldset disabled={disabled || saving} className="space-y-4">
        <label className="block space-y-2 text-xs text-slate-500">
          <span>Shop name</span>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
            required
            maxLength={120}
            autoComplete="organization"
          />
        </label>
        <label className="block space-y-2 text-xs text-slate-500">
          <span>Address</span>
          <Input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setSaved(false);
            }}
            maxLength={500}
            autoComplete="street-address"
            placeholder="Shop address"
          />
        </label>
        <label className="block space-y-2 text-xs text-slate-500">
          <span>Phone</span>
          <Input
            type="tel"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              setSaved(false);
            }}
            maxLength={50}
            autoComplete="tel"
            placeholder="Contact number"
          />
        </label>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-emerald-700">
          Shop profile saved.
        </p>
      ) : null}
      {preview ? (
        <p className="text-xs text-slate-500">Sign in to save changes.</p>
      ) : null}
      <Button
        type="submit"
        disabled={disabled || preview || saving || !dirty || !name.trim()}
      >
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
