import { useRef, useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import * as Crypto from "expo-crypto";
import {
  Button,
  Card,
  Field,
  Loading,
  Notice,
  Page,
  styles,
} from "../components/ui";
import { Select } from "../components/select";
import { useResource } from "../lib/use-resource";
import { useSession } from "../lib/session";
import { cents, today } from "../lib/format";
import type {
  CatalogMetadata,
  ExpenseOptions,
  ReplacementOptions,
} from "../../../../packages/api-client/src";

export type MasterKind =
  "customer" | "supplier" | "expense" | "product" | "replacement";
const permissions: Record<MasterKind, string> = {
  customer: "parties.customers",
  supplier: "parties.suppliers",
  expense: "finance.write",
  product: "catalog.write",
  replacement: "replacements.intake.customer",
};
export function MasterForm({ kind }: { kind: MasterKind }) {
  const { api, can, submit } = useSession();
  const key = useRef(Crypto.randomUUID());
  const [values, setValues] = useState<Record<string, string>>({
    date: today(),
    unit: "piece",
    price: "0",
    quantity: "1",
    source: "CUSTOMER_WARRANTY",
  });
  const set = (name: string, value: string) =>
    setValues((old) => ({ ...old, [name]: value }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resource = useResource<
    CatalogMetadata | ExpenseOptions | ReplacementOptions
  >(
    kind === "expense"
      ? "/expenses/options"
      : kind === "replacement"
        ? `/replacements/options?source=${values.source}`
        : kind === "supplier" || kind === "product"
          ? "/catalog?status=active"
          : null,
  );
  const catalog =
    resource.data && "types" in resource.data ? resource.data : null;
  const expenses =
    resource.data && "cashAvailable" in resource.data ? resource.data : null;
  const replacements =
    resource.data && "units" in resource.data ? resource.data : null;
  const type = catalog?.types.find((item) => item.id === values.typeId);
  const field = (
    name: string,
    label: string,
    options: { number?: boolean; max?: number; multiline?: boolean } = {},
  ) => (
    <Field
      key={name}
      label={label}
      value={values[name] ?? ""}
      onChangeText={(value) => set(name, value)}
      editable={!busy}
      maxLength={options.max ?? 160}
      keyboardType={options.number ? "decimal-pad" : "default"}
      multiline={options.multiline}
    />
  );
  async function save() {
    setError("");
    try {
      if (!can(permissions[kind]))
        throw new Error("This action is restricted.");
      let route: string;
      let body: object;
      if (kind === "customer" || kind === "supplier") {
        if (!values.name?.trim()) throw new Error("Enter a name.");
        if (!/^[+0-9][0-9 ()-]{5,29}$/.test(values.phone ?? ""))
          throw new Error("Enter a valid phone number.");
        if (kind === "customer" && !values.address?.trim())
          throw new Error("Enter the customer's address.");
        if (kind === "supplier" && !values.typeId)
          throw new Error("Select the supplier's product category.");
        route = kind === "customer" ? "/customers" : "/suppliers";
        body =
          kind === "customer"
            ? {
                name: values.name.trim(),
                phone: values.phone,
                address: values.address.trim(),
              }
            : {
                name: values.name.trim(),
                phone: values.phone,
                company: values.company?.trim() || null,
                productTypeId: values.typeId,
              };
      } else if (kind === "expense") {
        if (cents(values.amount ?? "") <= 0n)
          throw new Error("Enter an amount greater than zero.");
        if (!values.category || !values.account)
          throw new Error("Select a category and payment account.");
        route = "/expenses";
        body = {
          expenseDate: values.date,
          category: values.category,
          description: values.description ?? "",
          amount: values.amount,
          paymentAccountId: values.account,
        };
      } else if (kind === "product") {
        if (!type || !values.name?.trim() || !values.unit?.trim())
          throw new Error("Select a category and enter product name and unit.");
        if (
          type.trackingKind === "BATTERY_UNIT" &&
          (!values.model?.trim() || !values.brand?.trim())
        )
          throw new Error("Battery products need a model and brand.");
        if (type.trackingKind === "QUANTITY" && !values.category?.trim())
          throw new Error("Enter the product name group.");
        cents(values.price ?? "0");
        route = "/products";
        body = {
          typeId: values.typeId,
          name: values.name.trim(),
          unit: values.unit.trim(),
          defaultSellingPrice: values.price || "0",
          ...(values.model?.trim() ? { model: values.model.trim() } : {}),
          ...(values.brand?.trim() ? { brand: values.brand.trim() } : {}),
          ...(values.category?.trim()
            ? { category: values.category.trim() }
            : {}),
        };
      } else {
        const unit = replacements?.units.find(
          (item) => item.id === values.unitId,
        );
        if (!unit || !values.supplierId)
          throw new Error("Select a battery and supplier.");
        if (
          !/^\d+$/.test(values.quantity) ||
          Number(values.quantity) < 1 ||
          Number(values.quantity) > 100
        )
          throw new Error("Quantity must be between 1 and 100.");
        route = "/replacements/intake";
        body = {
          id: key.current,
          source: values.source,
          unitId: unit.id,
          supplierId: values.supplierId,
          quantity: Number(values.quantity),
          faultReason: values.reason ?? "",
          ...(unit.saleUnitId ? { saleUnitId: unit.saleUnitId } : {}),
        };
      }
      setBusy(true);
      if (kind === "expense") {
        const result = await submit(route, body, key.current);
        if (result.queued) {
          router.replace("/sync");
          return;
        }
      } else await api(route, { method: "POST", body, key: key.current });
      router.replace(
        kind === "product"
          ? "/(tabs)/stock"
          : `/module/${({ customer: "customers", supplier: "suppliers", expense: "accounts", replacement: "replacements" } as Record<string, string>)[kind]}`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title={"Add " + kind} back>
      {!can(permissions[kind]) ? (
        <Notice>This action is restricted.</Notice>
      ) : resource.loading && kind !== "customer" && !resource.data ? (
        <Loading />
      ) : (
        <Card>
          {kind === "customer" || kind === "supplier" ? (
            <>
              {field("name", "Name")}
              {field("phone", "Phone", { max: 30 })}
              {kind === "customer" ? (
                field("address", "Address", { max: 500, multiline: true })
              ) : (
                <>
                  {field("company", "Company (optional)")}
                  <Select
                    label="Product category"
                    disabled={busy}
                    value={values.typeId ?? ""}
                    onChange={(value) => set("typeId", value)}
                    options={(catalog?.types ?? []).map((item) => ({
                      id: item.id,
                      label: item.name,
                    }))}
                  />
                </>
              )}
            </>
          ) : null}
          {kind === "expense" ? (
            <>
              {field("date", "Date (YYYY-MM-DD)", { max: 10 })}
              <Select
                label="Expense category"
                disabled={busy}
                value={values.category ?? ""}
                onChange={(value) => set("category", value)}
                options={(expenses?.categories ?? []).map((item) => ({
                  id: item,
                  label: item,
                }))}
              />
              {field("description", "Description", { max: 500 })}
              {field("amount", "Amount", { number: true, max: 17 })}
              <Select
                label="Payment account"
                disabled={busy}
                value={values.account ?? ""}
                onChange={(value) => set("account", value)}
                options={(expenses?.paymentAccounts ?? []).map((item) => ({
                  id: item.id,
                  label: item.name,
                }))}
              />
            </>
          ) : null}
          {kind === "product" ? (
            <>
              <Select
                label="Product category"
                disabled={busy}
                value={values.typeId ?? ""}
                onChange={(value) => set("typeId", value)}
                options={(catalog?.types ?? []).map((item) => ({
                  id: item.id,
                  label: item.name,
                }))}
              />
              {field("name", "Product name")}
              {field("model", "Model")}
              {type?.trackingKind === "BATTERY_UNIT"
                ? field("brand", "Brand")
                : field("category", "Product name group")}
              {field("unit", "Unit")}
              {field("price", "Selling price", { number: true, max: 17 })}
              <Text style={styles.muted}>
                Stock is added when a purchase is received.
              </Text>
            </>
          ) : null}
          {kind === "replacement" ? (
            <>
              <Select
                label="Replacement source"
                disabled={busy}
                value={values.source}
                onChange={(value) => {
                  set("source", value);
                  set("unitId", "");
                }}
                options={[
                  { id: "CUSTOMER_WARRANTY", label: "Customer warranty" },
                  ...(can("replacements.intake.stock")
                    ? [{ id: "BEFORE_SALE", label: "Shop stock" }]
                    : []),
                ]}
              />
              <Select
                label="Battery"
                disabled={busy}
                value={values.unitId ?? ""}
                onChange={(value) => {
                  set("unitId", value);
                  const unit = replacements?.units.find(
                    (item) => item.id === value,
                  );
                  if (unit?.supplierId) set("supplierId", unit.supplierId);
                }}
                options={(replacements?.units ?? []).map((item) => ({
                  id: item.id,
                  label: item.label,
                  detail: [
                    item.customer ?? "Shop stock",
                    item.invoice ?? "",
                  ].join(" "),
                }))}
              />
              <Select
                label="Supplier"
                disabled={busy}
                value={values.supplierId ?? ""}
                onChange={(value) => set("supplierId", value)}
                options={(replacements?.suppliers ?? []).map((item) => ({
                  id: item.id,
                  label: item.name,
                }))}
              />
              {field("quantity", "Quantity", { number: true, max: 3 })}
              {field("reason", "Fault description", {
                multiline: true,
                max: 2000,
              })}
            </>
          ) : null}
        </Card>
      )}
      {resource.error || error ? (
        <Notice>{resource.error || error}</Notice>
      ) : null}
      {can(permissions[kind]) ? (
        <Button
          title={"Save " + kind}
          busy={busy}
          onPress={() => {
            void save();
          }}
        />
      ) : null}
    </Page>
  );
}
