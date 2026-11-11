/**
 * Shadow Traffic RTK Query API
 * Reads the shadow plugin's scorecard and comparison records, builds canary rules, and resets the store.
 */

import {
	GetShadowCanaryRuleParams,
	GetShadowRecordsParams,
	GetShadowRecordsResponse,
	ResetShadowRecordsResponse,
	ShadowCanaryRule,
	ShadowRecord,
	ShadowSummary,
} from "@/lib/types/shadow";
import { buildShadowCanaryRuleQueryParams, buildShadowRecordsQueryParams } from "@/lib/utils/shadow";
import { baseApi } from "./baseApi";

export const shadowApi = baseApi.injectEndpoints({
	endpoints: (builder) => ({
		// Counters and per-candidate scorecards. 404 while the plugin is not loaded.
		getShadowSummary: builder.query<ShadowSummary, void>({
			query: () => ({ url: "/shadow/summary" }),
			providesTags: ["ShadowSummary"],
		}),

		// Comparison records, newest first.
		getShadowRecords: builder.query<GetShadowRecordsResponse, GetShadowRecordsParams>({
			query: (params) => ({
				url: "/shadow/records",
				params: buildShadowRecordsQueryParams(params),
			}),
			providesTags: ["ShadowRecords"],
		}),

		getShadowRecord: builder.query<ShadowRecord, string>({
			query: (id) => ({ url: `/shadow/records/${encodeURIComponent(id)}` }),
			providesTags: (result, error, id) => [{ type: "ShadowRecords", id }],
		}),

		// Routing rule body that sends `weight` of the source model's traffic to the candidate, at `priority`.
		// A preview: never cached past the dialog, since it depends on live traffic for wildcard sources.
		getShadowCanaryRule: builder.query<ShadowCanaryRule, GetShadowCanaryRuleParams>({
			query: (params) => ({
				url: "/shadow/canary-rule",
				params: buildShadowCanaryRuleQueryParams(params),
			}),
			keepUnusedDataFor: 0,
		}),

		// Clears every stored comparison and counter.
		resetShadowRecords: builder.mutation<ResetShadowRecordsResponse, void>({
			query: () => ({ url: "/shadow/records", method: "DELETE" }),
			invalidatesTags: ["ShadowSummary", "ShadowRecords"],
		}),
	}),
});

export const {
	useGetShadowSummaryQuery,
	useGetShadowRecordsQuery,
	useGetShadowRecordQuery,
	useGetShadowCanaryRuleQuery,
	useResetShadowRecordsMutation,
} = shadowApi;