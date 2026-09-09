// Maps ERD table names to the admin surface that manages that data, so the ERD
// can deep-link "Open in admin" from a table. Only routes that actually exist
// under app/admin belong here — keep this in sync when an admin page is added
// or removed. Keyed by bare table name (schema-agnostic; all tables are in
// `public`).
const TABLE_ADMIN_ROUTES: Record<string, string> = {
  teachers: "/admin/teachers",
  students: "/admin/students",
  packages: "/admin/packages",
  package_templates: "/admin/packages",
  teacher_subscriptions: "/admin/subscriptions",
  subscription_invoices: "/admin/subscriptions",
  disputes: "/admin/disputes",
  notifications: "/admin/notifications",
  payments: "/admin/payments",
  admin_users: "/admin/staff",
  overrides: "/admin/audit",
};

/** Admin route for a table, or null when no management surface exists. */
export function adminRouteForTable(tableName: string): string | null {
  return TABLE_ADMIN_ROUTES[tableName] ?? null;
}
