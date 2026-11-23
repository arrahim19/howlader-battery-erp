import { useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
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
import { amount, cents, money, today } from "../lib/format";
import type {
  CompletedSale,
  PurchaseOptions,
  ReceivedPurchase,
  SalesOptions,
} from "../../../../packages/api-client/src";

type Line = {
  id: string;
  productId: string;
  quantity: string;
  unitPrice: string;
};
const newLine = (): Line => ({
  id: Crypto.randomUUID(),
  productId: "",
  quantity: "1",
  unitPrice: "",
});
export function TransactionForm({ kind }: { kind: "sale" | "purchase" }) {
  const sales = kind === "sale";
  const permission = sales ? "sales.manage" : "purchases.manage";
  const { submit, can } = useSession();
  const resource = useResource<SalesOptions | PurchaseOptions>(
    can(permission) ? (sales ? "/sales/options" : "/purchases/options") : null,
  );
  const [partyId, setPartyId] = useState("");
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [paid, setPaid] = useState("0");
  const [account, setAccount] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(Crypto.randomUUID());
  const data = resource.data;
  const parties = data
    ? "customers" in data
      ? data.customers
      : data.suppliers
    : [];
  const supplierType =
    data && "suppliers" in data
      ? data.suppliers.find((item) => item.id === partyId)?.productTypeId
      : null;
  const products = (data?.products ?? []).filter(
    (product) => sales || !supplierType || product.type.id === supplierType,
  );
  const update = (id: string, value: Partial<Line>) =>
    setLines((old) =>
      old.map((line) => (line.id === id ? { ...line, ...value } : line)),
    );
  let total = 0n;
  try {
    total = lines.reduce(
      (sum, line) =>
        sum +
        cents(line.unitPrice || "0") *
          BigInt(/^\d+$/.test(line.quantity) ? line.quantity : "0"),
      0n,
    );
  } catch {
    /* The submit action presents validation errors. */
  }
  async function save() {
    setError("");
    try {
      if (!partyId)
        throw new Error(`Select a ${sales ? "customer" : "supplier"}.`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new Error("Enter the date as YYYY-MM-DD.");
      if (!sales && !reference.trim())
        throw new Error("Enter the supplier invoice or challan reference.");
      if (!lines.length || lines.length > 100)
        throw new Error("Add between 1 and 100 product lines.");
      if (new Set(lines.map((line) => line.productId)).size !== lines.length)
        throw new Error(
          "Each product can only appear once. Increase its quantity instead.",
        );
      const items = lines.map((line) => {
        if (!products.some((product) => product.id === line.productId))
          throw new Error("Select an available product for every line.");
        if (
          !/^\d+$/.test(line.quantity) ||
          Number(line.quantity) < 1 ||
          Number(line.quantity) > 10000
        )
          throw new Error("Quantities must be whole numbers from 1 to 10000.");
        cents(line.unitPrice);
        return {
          productId: line.productId,
          quantity: Number(line.quantity),
          unitPrice: line.unitPrice,
        };
      });
      const paidValue = cents(paid || "0");
      if (paidValue > total)
        throw new Error("Paid amount cannot exceed the total.");
      if (paidValue > 0n && !account)
        throw new Error("Select the payment account.");
      const body = sales
        ? {
            customerId: partyId,
            saleDate: date,
            notes: reference.trim(),
            items,
            paidAmount: paid || "0",
            ...(account ? { paymentAccountId: account } : {}),
          }
        : {
            supplierId: partyId,
            purchaseDate: date,
            reference: reference.trim(),
            items,
            paidAmount: paid || "0",
            ...(account ? { paymentAccountId: account } : {}),
          };
      setBusy(true);
      const submitted = await submit<CompletedSale | ReceivedPurchase>(
        sales ? "/sales/complete" : "/purchases/receive",
        body,
        key.current,
      );
      if (submitted.queued) {
        router.replace("/sync");
        return;
      }
      const result = submitted.data;
      const number =
        "invoiceNumber" in result ? result.invoiceNumber : result.number;
      Alert.alert(
        sales ? "Sale saved" : "Purchase received",
        `${number}\nTotal: ${money(result.total)}\nDue: ${money(result.due)}`,
      );
      router.replace(sales ? "/(tabs)/sales" : "/module/purchases");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to save this transaction.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title={sales ? "New sale" : "Receive purchase"} back>
      {!can(permission) ? (
        <Notice>This action is restricted.</Notice>
      ) : resource.loading && !data ? (
        <Loading />
      ) : data ? (
        <>
          <Card>
            <Field
              label="Date (YYYY-MM-DD)"
              value={date}
              onChangeText={setDate}
              maxLength={10}
              editable={!busy}
            />
            <Select
              label={sales ? "Customer" : "Supplier"}
              disabled={busy}
              value={partyId}
              onChange={(value) => {
                setPartyId(value);
                if (!sales) setLines([newLine()]);
              }}
              options={parties.map((item) => ({
                id: item.id,
                label: item.name,
              }))}
            />
            <Button
              title={sales ? "Add customer" : "Add supplier"}
              variant="outline"
              disabled={busy}
              onPress={() =>
                router.push(sales ? "/new/customer" : "/new/supplier")
              }
            />
            <Field
              label={sales ? "Notes (optional)" : "Supplier invoice / challan"}
              value={reference}
              onChangeText={setReference}
              maxLength={160}
              editable={!busy}
            />
          </Card>
          <Text style={styles.heading}>Products</Text>
          {lines.map((line, index) => (
            <Card key={line.id}>
              <Text style={styles.muted}>Item {index + 1}</Text>
              <Select
                label={`Product ${index + 1}`}
                value={line.productId}
                disabled={busy}
                options={products.map((item) => ({
                  id: item.id,
                  label: `${item.name}${item.model ? " · " + item.model : ""}`,
                  detail:
                    "availableQuantity" in item
                      ? `${item.availableQuantity} available`
                      : item.type.name,
                }))}
                onChange={(productId) => {
                  const product = products.find(
                    (item) => item.id === productId,
                  );
                  update(line.id, {
                    productId,
                    unitPrice:
                      product && "defaultSellingPrice" in product
                        ? product.defaultSellingPrice
                        : "",
                  });
                }}
              />
              <View style={{ flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Field
                    label={`Quantity ${index + 1}`}
                    value={line.quantity}
                    onChangeText={(quantity) => update(line.id, { quantity })}
                    keyboardType="number-pad"
                    maxLength={5}
                    editable={!busy}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Field
                    label={`Unit price ${index + 1}`}
                    value={line.unitPrice}
                    onChangeText={(unitPrice) => update(line.id, { unitPrice })}
                    keyboardType="decimal-pad"
                    maxLength={17}
                    editable={!busy}
                  />
                </View>
              </View>
              {lines.length > 1 ? (
                <Button
                  title={`Remove item ${index + 1}`}
                  variant="outline"
                  disabled={busy}
                  onPress={() =>
                    setLines((old) => old.filter((item) => item.id !== line.id))
                  }
                />
              ) : null}
            </Card>
          ))}
          <Button
            title="Add another product"
            variant="outline"
            disabled={busy || lines.length >= 100}
            onPress={() => setLines((old) => [...old, newLine()])}
          />
          <Card>
            <Text style={styles.muted}>Transaction total</Text>
            <Text style={styles.amount}>{money(amount(total))}</Text>
            <Field
              label="Paid amount"
              value={paid}
              onChangeText={setPaid}
              keyboardType="decimal-pad"
              editable={!busy}
            />
            <Select
              label="Payment account"
              disabled={busy}
              value={account}
              onChange={setAccount}
              options={data.paymentAccounts.map((item) => ({
                id: item.id,
                label: item.name,
              }))}
            />
            <Text style={styles.muted}>
              Without a connection this transaction stays on your phone until
              sync. Stock and balances become final after server confirmation.
            </Text>
          </Card>
        </>
      ) : null}
      {resource.error || error ? (
        <Notice>{resource.error || error}</Notice>
      ) : null}
      {data && can(permission) ? (
        <Button
          title={sales ? "Complete sale" : "Receive purchase"}
          busy={busy}
          onPress={() => {
            void save();
          }}
          icon="checkmark-circle-outline"
        />
      ) : null}
    </Page>
  );
}
