# Local ERP engine and device workspace

Pure TypeScript business operations, atomic SQLite storage on native phones and IndexedDB on desktop browsers. The Google-enrolled /device workspace calls this engine directly, without a PC API. Legacy Nest/PostgreSQL screens remain separate development references.

The active `/device` UI now reuses the original ERP's AppShell, Dashboard, ModulePage, forms and dialogs. `workspace-api.ts` translates their existing request/response contracts into local operations. The standalone LocalShop UI was removed at the owner's request; keep desktop and native on the original shared design.

Shop settings preserve the original API contract: `/settings/shop` returns `{value: {name, address, phone}, version}`, while `/shop-profile` returns only the profile fields for the sidebar/invoice. Profile edits are version checked, atomically saved and audited in the shop snapshot, and included in encrypted Drive sync/restore. Do not flatten the settings response into the public profile response.

Implemented: categories, products, customer/supplier contacts, purchases, quantity FIFO sales/costs, individual battery units/serials, calendar-month warranty, before-sale and customer replacement, initial payments, collections, supplier payments, oldest-invoice allocation, transport/manual expenses, chronological running balances displayed newest first, sequential invoices, balanced journals and durable replay.

Battery replacement tracks ownership and custody separately. A customer's replacement never becomes available shop inventory or changes the original invoice/due. Before-sale faulty stock remains a shop asset but cannot be sold; replacement restores availability at its original cost. Customer replacements retain their original warranty end date. Expired claims cannot receive automatic free replacements. Case versions and action dates are checked; duplicate serials/open claims are rejected. Only undispatched intake can be cancelled. Rejection does not silently write off a faulty shop asset.

Format 2 adds unit/replacement/expense maps; format-1 quantity documents upgrade locally after validation. Amount arithmetic uses integer minor units (bigint), strict decimal strings and bounds. JSON snapshots contain decimal strings. Inventory/AR/AP control balances must match balanced journals before commit and restore.

A single CAS document per shop commits business data, stock, journals, audit and replay result atomically. Failed persistence is never acknowledged. This full-document representation favors correctness and encrypted export; it is not scalable relational storage.

LocalDevice binds the engine to Google-approved shop/user grants. First cloud check/restore must finish before posting. Pending upload IDs/payloads and captured business revisions are durable. Upload acknowledgement cannot mark later work synced. Devices remain open together without handoff. Each command automatically holds a short lease across refresh, business commit and acknowledged upload, then releases it. Idle reads take no lease; visible clients refresh every 10 seconds and on foreground. New posting requires connectivity; interrupted local work remains durable for retry. Logout flushes pending work. Google setup and key escrow: ../../google-apps-script/README.md.

The local workspace currently grants approved shop operators full local business access; a separate employee role model is not implemented. Snapshot exports contain the entire authorized shop, not a role-filtered screen response.

Missing in this workspace: returns, posted financial reversals, account/inventory adjustments, full reports/settings/user administration and invoice printing. Never emulate these by editing persisted JSON. No installed app release is included; native encryption and real Google/Drive still need verification after owner setup.

Tests use isolated real SQLite databases, never business data, and cover exact accounting, FIFO, restart/replay, rollback, CAS, shop isolation, batteries/warranty/replacements, lost replies, upload races, second-device restore and preserved conflicts/wrong keys. Browser tests exercise real IndexedDB and Web Crypto with mocked Google/Drive enrollment.
