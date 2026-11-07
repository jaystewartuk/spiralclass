# Exemplars

**Copy these, not whatever happens to sit nearest.** An agent imitates the code
around it, and the code around it is uneven: [design/](../design/README.md)
records hundreds of token bypasses that a ratchet tolerates and nothing should
add to. This table names where to start for each common kind of change.

| Kind                  | Copy this                                                          | Its test                                                 | Why this one                                                                                                        |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Screen                | `apps/web/src/app/(app)/payments/page.tsx`                         | `apps/web/src/lib/payments-list.test.ts`                 | Page auth gate, views as URLs, shared `ui/` components, rules moved into a tested module, tenancy an explicit `AND` |
| Client form           | `apps/web/src/app/(app)/settings/captions/caption-timing-form.tsx` | `apps/web/tests/components/caption-timing-form.test.tsx` | Catalog copy, a dirty state, native controls for phones, and the React form-reset trap explained where it bites     |
| Server action         | `apps/web/src/app/actions/caption-timing.ts`                       | `apps/web/tests/actions/caption-timing-action.test.ts`   | Parses input with the shared code its reader uses, and writes only the calling teacher's row                        |
| API handler           | `apps/web/src/app/api/teacher/search/route.ts`                     | `apps/web/tests/api/search-routes.test.ts`               | `handle()` with the API auth gate, so a missing session is a 401 and not a redirect; the response is uncacheable    |
| Tenant-isolation test | `apps/web/tests/search/records.integration.test.ts`                | —                                                        | Seeds two tenants against real Postgres and asserts that neither one sees the other                                 |

An exemplar shows the shape of a change. It does not own the behaviour:
[features/](../features/) still does.

**`apps/web/tests/config/exemplars.test.ts` holds this table to the tree.** Every
path must exist, and an exemplar must have no design-token bypass, no suppressed
lint or type error, no tenancy exemption and no skipped test. If a file stops
qualifying, replace its row rather than excusing it. Add a row when a kind of
change keeps being copied from a poor example, and name the better file.
