/**
 * Shadow Traffic Page
 * Scorecard for candidate models evaluated on mirrored live traffic.
 */

import { ShadowTrafficView } from "./views/shadowTrafficView";

export default function ShadowTrafficPage() {
	return (
		<div className="no-padding-parent mx-auto flex w-full flex-col p-4">
			<ShadowTrafficView />
		</div>
	);
}