// The entitlements resolver — THE single place that decides what a teacher's
// plan unlocks — now lives in @spiralclass/shared so web and mobile compute
// entitlements identically. Re-exported here so existing
// `@/lib/subscriptions/entitlements` imports keep working. Edit the resolver in
// packages/shared/src/subscriptions-entitlements.ts.
export {
  type SubscriptionLike,
  type Entitlements,
  effectiveStatus,
  entitlementsFor,
  freeEntitlements,
} from "@spiralclass/shared";
