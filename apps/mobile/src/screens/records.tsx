import { useState } from "react";
import { Alert, Share, Text, View } from "react-native";
import { router } from "expo-router";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Loading,
  Notice,
  Page,
  colors,
  styles,
} from "../components/ui";
import { Select } from "../components/select";
import { useResource } from "../lib/use-resource";
import { useSession } from "../lib/session";
import { dateText, money } from "../lib/format";
import type {
  CatalogProduct,
  ProductList,
} from "../../../../packages/api-client/src";

type RecordRow = {
  id: string;
  name?: string;
  model?: string;
  phone?: string;
  company?: string | null;
  login?: string;
  active?: boolean;
  invoiceNumber?: string | null;
  number?: string;
  total?: string;
  paid?: string;
  due?: string;
  totalSales?: string;
  totalPurchases?: string;
  amount?: string;
  description?: string;
  category?: string;
  date?: string;
  saleDate?: string | null;
  purchaseDate?: string;
  customer?: { id: string; name: string; phone?: string } | string | null;
  supplier?: { id: string; name: string } | string;
  status?: string;
  product?: string;
  version?: number;
  stage?: string;
  claimNumber?: string;
};
type Records = {
  items: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
};
export const recordModules = {
  sales: {
    title: "Sales",
    path: "/sales",
    create: "sale",
    permission: "sales.manage",
    write: "sales.manage",
  },
  purchases: {
    title: "Purchases",
    path: "/purchases",
    create: "purchase",
    permission: "purchases.manage",
    write: "purchases.manage",
  },
  customers: {
    title: "Customers",
    path: "/customers",
    create: "customer",
    permission: "parties.customers",
    write: "parties.customers",
  },
  suppliers: {
    title: "Suppliers",
    path: "/suppliers",
    create: "supplier",
    permission: "parties.suppliers",
    write: "parties.suppliers",
  },
  accounts: {
    title: "Accounts & expenses",
    path: "/expenses",
    create: "expense",
    permission: "finance.read",
    write: "finance.write",
  },
  replacements: {
    title: "Replacements",
    path: "/replacements",
    create: "replacement",
    permission: "replacements.intake.customer",
    write: "replacements.intake.customer",
  },
  users: {
    title: "Users",
    path: "/users",
    create: "",
    permission: "access.manage",
    write: "access.manage",
  },
} as const;
export type RecordKind = keyof typeof recordModules;
export function RecordsScreen({
  kind,
  tab = false,
}: {
  kind: RecordKind;
  tab?: boolean;
}) {
  const config = recordModules[kind];
  const { can, user, api } = useSession();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusError, setStatusError] = useState("");
  const resource = useResource<Records | RecordRow[]>(
    can(config.permission)
      ? config.path + (kind === "users" ? "" : `?page=${page}&pageSize=20`)
      : null,
  );
  const records = Array.isArray(resource.data)
    ? resource.data
    : (resource.data?.items ?? []);
  const items = records.filter((row) =>
    `${row.name ?? ""} ${row.invoiceNumber ?? ""} ${row.number ?? ""} ${row.product ?? ""} ${typeof row.customer === "string" ? row.customer : (row.customer?.name ?? "")} ${typeof row.supplier === "string" ? row.supplier : (row.supplier?.name ?? "")} ${row.phone ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  async function setStage(row: RecordRow, status: string) {
    setStatusError("");
    try {
      await api(`/replacements/${row.id}/status`, {
        method: "POST",
        body: { status, version: row.version },
      });
      resource.refresh();
    } catch (error) {
      setStatusError(
        error instanceof Error ? error.message : "Unable to update status.",
      );
    }
  }
  async function share(row: RecordRow) {
    try {
      await Share.share({
        message: `${user?.shop?.name ?? "Hawlader Battery"} · ${user?.shop?.branchName ?? ""}\nInvoice: ${row.invoiceNumber ?? row.number ?? ""}\nCustomer: ${typeof row.customer === "object" ? (row.customer?.name ?? "") : (row.customer ?? "")}\nTotal: ${money(row.total)}\nPaid: ${money(row.paid)}\nDue: ${money(row.due)}`,
      });
    } catch (error) {
      Alert.alert(
        "Unable to share",
        error instanceof Error ? error.message : "Please try again.",
      );
    }
  }
  return (
    <Page
      title={config.title}
      back={!tab}
      loading={resource.loading}
      onRefresh={resource.refresh}
    >
      {!can(config.permission) ? (
        <Notice>You do not have permission to access this module.</Notice>
      ) : (
        <>
          {config.create && can(config.write) ? (
            <Button
              title={`Add ${config.create}`}
              icon="add-outline"
              onPress={() => router.push(`/new/${config.create}`)}
            />
          ) : null}
          <Field
            label="Search this page"
            placeholder="Name, invoice, phone…"
            value={search}
            onChangeText={setSearch}
          />
          {resource.error || statusError ? (
            <Notice>{resource.error || statusError}</Notice>
          ) : null}
          {resource.loading && !resource.data ? (
            <Loading />
          ) : !items.length ? (
            <Empty
              text={
                search
                  ? "No matching records on this page."
                  : "No records in this shop yet."
              }
            />
          ) : (
            items.map((row) => (
              <Card key={row.id}>
                <View style={styles.between}>
                  <Text style={[styles.heading, { flex: 1 }]}>
                    {row.invoiceNumber ??
                      row.number ??
                      row.claimNumber ??
                      row.name ??
                      row.product ??
                      row.description ??
                      "Record"}
                  </Text>
                  {row.status ? (
                    <Badge>{row.status.replaceAll("_", " ")}</Badge>
                  ) : null}
                </View>
                {row.customer ? (
                  <Text style={styles.text}>
                    {typeof row.customer === "string"
                      ? row.customer
                      : row.customer.name}
                  </Text>
                ) : null}
                {row.supplier ? (
                  <Text style={styles.text}>
                    {typeof row.supplier === "string"
                      ? row.supplier
                      : row.supplier.name}
                  </Text>
                ) : null}
                {row.phone || row.login ? (
                  <Text style={styles.muted}>{row.phone ?? row.login}</Text>
                ) : null}
                {row.description && row.category ? (
                  <Text style={styles.muted}>{row.category}</Text>
                ) : null}
                {row.saleDate || row.purchaseDate || row.date ? (
                  <Text style={styles.muted}>
                    {dateText(row.saleDate ?? row.purchaseDate ?? row.date)}
                  </Text>
                ) : null}
                {row.total !== undefined || row.amount !== undefined ? (
                  <Text style={[styles.amount, { fontSize: 20 }]}>
                    {money(row.total ?? row.amount)}
                  </Text>
                ) : null}
                {row.due !== undefined ? (
                  <Text
                    style={{
                      color: Number(row.due) > 0 ? "#a7651a" : colors.green,
                      fontSize: 13,
                    }}
                  >
                    Due {money(row.due)}
                    {row.paid !== undefined ? ` · Paid ${money(row.paid)}` : ""}
                  </Text>
                ) : null}
                {kind === "customers" || kind === "suppliers" ? (
                  <Button
                    title="View ledger"
                    variant="outline"
                    onPress={() =>
                      router.push({
                        pathname: "/ledger/[kind]/[id]",
                        params: {
                          kind: kind === "customers" ? "customer" : "supplier",
                          id: row.id,
                        },
                      })
                    }
                  />
                ) : null}
                {kind === "sales" ? (
                  <Button
                    title="Share invoice summary"
                    variant="outline"
                    icon="share-outline"
                    onPress={() => {
                      void share(row);
                    }}
                  />
                ) : null}
                {kind === "replacements" ? (
                  <Select
                    label="Update status"
                    value={row.status ?? row.stage ?? ""}
                    options={[
                      { id: "FAULTY", label: "Faulty" },
                      { id: "SENT", label: "Sent to company" },
                      { id: "RECEIVED", label: "Received" },
                      { id: "DELIVERED", label: "Delivered" },
                    ].filter((option) =>
                      can(
                        (
                          {
                            FAULTY: "replacements.resolve",
                            SENT: "replacements.dispatch",
                            RECEIVED: "replacements.receive",
                            DELIVERED: "replacements.deliver",
                          } as Record<string, string>
                        )[option.id],
                      ),
                    )}
                    onChange={(status) => {
                      void setStage(row, status);
                    }}
                  />
                ) : null}
              </Card>
            ))
          )}
          {kind !== "users" ? (
            <View style={styles.between}>
              <Button
                title="Previous"
                disabled={page <= 1 || resource.loading}
                variant="outline"
                onPress={() => {
                  setPage((value) => value - 1);
                  setSearch("");
                }}
              />
              <Text style={styles.muted}>Page {page}</Text>
              <Button
                title="Next"
                variant="outline"
                disabled={
                  resource.loading ||
                  Array.isArray(resource.data) ||
                  page * 20 >= (resource.data?.total ?? 0)
                }
                onPress={() => {
                  setPage((value) => value + 1);
                  setSearch("");
                }}
              />
            </View>
          ) : null}
        </>
      )}
    </Page>
  );
}
export function StockScreen() {
  const { can } = useSession();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const resource = useResource<ProductList>(
    can("inventory.read")
      ? `/products?page=${page}&pageSize=20&q=${encodeURIComponent(filter)}`
      : null,
  );
  return (
    <Page
      title="Inventory / Stock"
      loading={resource.loading}
      onRefresh={resource.refresh}
    >
      {can("catalog.write") ? (
        <Button
          title="Add product"
          icon="add-outline"
          onPress={() => router.push("/new/product")}
        />
      ) : null}
      <Field
        label="Search products"
        value={query}
        onChangeText={setQuery}
        placeholder="Name or model"
        onSubmitEditing={() => {
          setFilter(query);
          setPage(1);
        }}
      />
      <Button
        title="Search"
        variant="outline"
        onPress={() => {
          setFilter(query);
          setPage(1);
        }}
      />
      {!can("inventory.read") ? (
        <Notice>Inventory access is restricted.</Notice>
      ) : resource.error ? (
        <Notice>{resource.error}</Notice>
      ) : null}
      {resource.loading && !resource.data ? (
        <Loading />
      ) : resource.data?.items.length ? (
        resource.data.items.map((row: CatalogProduct) => (
          <Card key={row.id}>
            <View style={styles.between}>
              <Text style={[styles.heading, { flex: 1 }]}>{row.name}</Text>
              <Badge>{row.type.name}</Badge>
            </View>
            {row.model ? (
              <Text style={styles.muted}>Model: {row.model}</Text>
            ) : null}
            <View style={styles.between}>
              <Text style={styles.text}>
                {row.stock.available} {row.unit} available
              </Text>
              <Text style={{ color: colors.green, fontWeight: "700" }}>
                {money(row.defaultSellingPrice)}
              </Text>
            </View>
            <Text style={styles.muted}>
              Reserved {row.stock.reserved} · At company{" "}
              {row.stock.sentToCompany}
            </Text>
          </Card>
        ))
      ) : (
        <Empty text="No products found in this shop." />
      )}
      <View style={styles.between}>
        <Button
          title="Previous"
          variant="outline"
          disabled={page <= 1 || resource.loading}
          onPress={() => setPage((value) => value - 1)}
        />
        <Text style={styles.muted}>Page {page}</Text>
        <Button
          title="Next"
          variant="outline"
          disabled={
            resource.loading || page * 20 >= (resource.data?.total ?? 0)
          }
          onPress={() => setPage((value) => value + 1)}
        />
      </View>
    </Page>
  );
}
