import { NoPermissionView } from "@/components/noPermissionView";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { createFileRoute } from "@tanstack/react-router";
import ShadowTrafficPage from "./page";

function RouteComponent() {
	// Promoting a candidate creates a routing rule, so the page is gated like the routing pages.
	const hasRoutingRulesAccess = useRbac(RbacResource.RoutingRules, RbacOperation.View);
	if (!hasRoutingRulesAccess) {
		return <NoPermissionView entity="routing rules" />;
	}
	return <ShadowTrafficPage />;
}

export const Route = createFileRoute("/workspace/shadow")({
	component: RouteComponent,
});