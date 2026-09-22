import { permanentRedirect } from "next/navigation";

// The Facebook-groups editor became the marketing COMMUNITIES editor in D-125,
// merged with the per-community social previews it always belonged next to.
//
// A redirect rather than a deletion: this path is in teachers' browser history
// and in the `dashboardPathSuffix` of already-queued growth notifications.
// Both must keep landing somewhere real.
export default function ShareGroupsRedirect() {
  permanentRedirect("/dashboard/get-students/communities");
}
