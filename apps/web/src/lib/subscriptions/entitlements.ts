// The entitlements resolver — THE single place that decides what a teacher's
// plan unlocks. The resolver itself lives in @spiralclass/shared so the
// handlers and the UI compute entitlements identically; this is the import
// surface the app uses. Edit the resolver in
// packages/shared/src/subscriptions-entitlements.ts.
export {
  type SubscriptionLike,
  type Entitlements,
  effectiveStatus,
  entitlementsFor,
} from "@spiralclass/shared";
