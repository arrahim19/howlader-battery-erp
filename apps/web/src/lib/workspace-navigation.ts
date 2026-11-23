export const childNavigation: Record<
  string,
  { label: string; view: string; permission?: string }[]
> = {
  purchases: [
    { label: "New Purchase", view: "new" },
    { label: "Purchase List", view: "list" },
  ],
  sales: [
    { label: "New Sale", view: "new" },
    { label: "Sales List", view: "list" },
  ],
  replacements: [
    { label: "Replacement List", view: "list" },
    { label: "New Replacement", view: "new" },
  ],
  customers: [
    { label: "Customer List", view: "list" },
    { label: "Add Customer", view: "new" },
    { label: "Ledger", view: "ledger" },
  ],
  suppliers: [
    { label: "Supplier List", view: "list" },
    { label: "Add Supplier", view: "new" },
    { label: "Company / Brands", view: "groups" },
    { label: "Supplier Dues", view: "credit" },
    { label: "Ledger", view: "ledger" },
  ],
  accounts: [
    { label: "Account Summary", view: "summary" },
    { label: "Transactions", view: "transactions" },
    { label: "Expense Categories", view: "categories" },
    { label: "Reports", view: "reports" },
  ],
};
