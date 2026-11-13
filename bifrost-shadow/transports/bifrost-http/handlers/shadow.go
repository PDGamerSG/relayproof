package handlers

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/bytedance/sonic"
	"github.com/fasthttp/router"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/plugins/shadow"
	"github.com/maximhq/bifrost/transports/v2/bifrost-http/lib"
	"github.com/valyala/fasthttp"
)

// ShadowReader is the contract the handler needs from the shadow plugin.
// Exported so server wiring can supply a resolver and tests a fake.
type ShadowReader interface {
	Summary() shadow.Summary
	Records(f shadow.RecordFilter) ([]*shadow.Record, int)
	AllRecords(f shadow.RecordFilter) []*shadow.Record
	Record(id string) *shadow.Record
	Reset() error
	BuildCanaryRule(experiment, candidate string, weight float64, priority ...int) (*shadow.CanaryRule, error)
	PairScorecard(experiment, candidate string) (shadow.PairSummary, error)
	RecordRollout(ev shadow.RolloutEvent) (shadow.RolloutEvent, error)
	Rollouts() shadow.Rollouts
}

// ShadowResolver returns the currently loaded shadow plugin, or nil. It is called
// per request so plugin reloads through /api/plugins are honored.
type ShadowResolver func() ShadowReader

// ShadowHandler serves the shadow traffic evaluation API.
type ShadowHandler struct {
	resolve ShadowResolver
	rules   ShadowRoutingRules
}

// NewShadowHandler returns a handler that resolves the plugin at request time.
// It is safe to wire unconditionally: when the plugin is not loaded every route
// answers 404 with a clear message. rules may be nil (no config store), in which
// case promotion and rollback answer 503 and everything else works.
func NewShadowHandler(resolve ShadowResolver, rules ShadowRoutingRules) *ShadowHandler {
	return &ShadowHandler{resolve: resolve, rules: rules}
}

// RegisterRoutes registers the shadow routes.
func (h *ShadowHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.GET("/api/shadow/summary", lib.ChainMiddlewares(h.getSummary, middlewares...))
	r.GET("/api/shadow/records", lib.ChainMiddlewares(h.listRecords, middlewares...))
	r.GET("/api/shadow/records/{id}", lib.ChainMiddlewares(h.getRecord, middlewares...))
	r.DELETE("/api/shadow/records", lib.ChainMiddlewares(h.resetRecords, middlewares...))
	r.GET("/api/shadow/canary-rule", lib.ChainMiddlewares(h.getCanaryRule, middlewares...))
	r.POST("/api/shadow/promote", lib.ChainMiddlewares(h.promote, middlewares...))
	r.POST("/api/shadow/rollback", lib.ChainMiddlewares(h.rollback, middlewares...))
	r.GET("/api/shadow/rollouts", lib.ChainMiddlewares(h.getRollouts, middlewares...))
	r.GET("/api/shadow/export", lib.ChainMiddlewares(h.export, middlewares...))
}

func (h *ShadowHandler) plugin(ctx *fasthttp.RequestCtx) ShadowReader {
	p := h.resolve()
	if p == nil {
		SendError(ctx, fasthttp.StatusNotFound, "shadow plugin is not enabled; add it to plugins in config.json or enable it from the plugins page")
	}
	return p
}

func (h *ShadowHandler) getSummary(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	SendJSON(ctx, p.Summary())
}

func (h *ShadowHandler) listRecords(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	filter, ok := recordFilterFromQuery(ctx)
	if !ok {
		return
	}
	records, total := p.Records(filter)
	SendJSON(ctx, map[string]any{
		"records": records,
		"total":   total,
	})
}

// recordFilterFromQuery parses experiment, candidate, outcome, limit and offset.
// It answers 400 and returns false on a bad value.
func recordFilterFromQuery(ctx *fasthttp.RequestCtx) (shadow.RecordFilter, bool) {
	args := ctx.QueryArgs()
	outcome, err := shadow.ParseOutcome(string(args.Peek("outcome")))
	if err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return shadow.RecordFilter{}, false
	}
	filter := shadow.RecordFilter{
		Experiment: string(args.Peek("experiment")),
		Candidate:  string(args.Peek("candidate")),
		Outcome:    outcome,
	}
	if filter.Limit, err = parseNonNegative(args.Peek("limit")); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "limit must be a non-negative integer")
		return filter, false
	}
	if filter.Offset, err = parseNonNegative(args.Peek("offset")); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "offset must be a non-negative integer")
		return filter, false
	}
	return filter, true
}

func (h *ShadowHandler) getRecord(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	id, _ := ctx.UserValue("id").(string)
	if decoded, err := url.PathUnescape(id); err == nil {
		id = decoded
	}
	rec := p.Record(id)
	if rec == nil {
		SendError(ctx, fasthttp.StatusNotFound, "shadow record not found")
		return
	}
	SendJSON(ctx, rec)
}

func (h *ShadowHandler) resetRecords(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	if err := p.Reset(); err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, "failed to reset shadow records")
		return
	}
	lib.RecordAuditChange(ctx, "shadow.reset", "shadow", "records", "records", nil, nil)
	SendJSON(ctx, map[string]any{"message": "shadow records cleared"})
}

// getCanaryRule returns a routing-rule body for POST /api/routing/rules.
// Query: experiment, candidate ("provider/model"), weight (0.0001 <= w <= 1,
// default 0.1), priority (non-negative integer, default 10; the routing rules
// API allows one rule per priority in a scope). POST /api/shadow/promote does
// the same and also merges with an existing canary, checks for conflicting
// rules, gates on the verdict and records the rollout.
func (h *ShadowHandler) getCanaryRule(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	args := ctx.QueryArgs()
	experiment := string(args.Peek("experiment"))
	candidate := string(args.Peek("candidate"))
	if experiment == "" || candidate == "" {
		SendError(ctx, fasthttp.StatusBadRequest, "experiment and candidate are required")
		return
	}
	weight := 0.1
	if raw := string(args.Peek("weight")); raw != "" {
		w, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			SendError(ctx, fasthttp.StatusBadRequest, fmt.Sprintf("weight must be a number from %g to 1", shadow.MinCanaryWeight))
			return
		}
		// ParseFloat accepts NaN and Inf; reject them and unroutable shares here.
		if err := shadow.ValidateCanaryWeight(w); err != nil {
			SendError(ctx, fasthttp.StatusBadRequest, err.Error())
			return
		}
		weight = w
	}
	priority := shadow.DefaultCanaryPriority
	if raw := args.Peek("priority"); len(raw) > 0 {
		n, err := parseNonNegative(raw)
		if err != nil {
			SendError(ctx, fasthttp.StatusBadRequest, "priority must be a non-negative integer")
			return
		}
		priority = n
	}
	rule, err := p.BuildCanaryRule(experiment, candidate, weight, priority)
	if errors.Is(err, shadow.ErrUnknownPair) {
		SendError(ctx, fasthttp.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	SendJSON(ctx, rule)
}

// shadowPromoteRequest is the body of POST /api/shadow/promote.
type shadowPromoteRequest struct {
	Experiment string `json:"experiment"`
	Candidate  string `json:"candidate"`
	// Weight is the candidate's share of source traffic (default 0.1).
	Weight *float64 `json:"weight,omitempty"`
	// Priority applies to a new canary rule only (default: first free from 10).
	Priority *int `json:"priority,omitempty"`
	// OverrideReason is required to promote a candidate that is not "ready".
	OverrideReason string `json:"override_reason,omitempty"`
	// DryRun returns the plan without writing anything.
	DryRun bool `json:"dry_run,omitempty"`
}

// promote serves POST /api/shadow/promote.
func (h *ShadowHandler) promote(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	if h.rules == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "promotion needs the config store, which holds routing rules; enable config_store")
		return
	}
	var req shadowPromoteRequest
	if err := sonic.Unmarshal(ctx.PostBody(), &req); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Experiment == "" || req.Candidate == "" {
		SendError(ctx, fasthttp.StatusBadRequest, "experiment and candidate are required")
		return
	}
	in := shadowPromoteInput{
		experiment:     req.Experiment,
		candidate:      req.Candidate,
		weight:         0.1,
		priority:       req.Priority,
		overrideReason: req.OverrideReason,
		dryRun:         req.DryRun,
	}
	if req.Weight != nil {
		if err := shadow.ValidateCanaryWeight(*req.Weight); err != nil {
			SendError(ctx, fasthttp.StatusBadRequest, err.Error())
			return
		}
		in.weight = *req.Weight
	}
	if req.Priority != nil && *req.Priority < 0 {
		SendError(ctx, fasthttp.StatusBadRequest, "priority must be a non-negative integer")
		return
	}

	shadowRolloutMu.Lock()
	result, err := promoteShadowCandidate(ctx, p, h.rules, in)
	shadowRolloutMu.Unlock()
	switch {
	case errors.Is(err, shadow.ErrUnknownPair):
		SendError(ctx, fasthttp.StatusNotFound, err.Error())
	case errors.Is(err, errShadowNotReady):
		SendJSONWithStatus(ctx, map[string]any{
			"error":          err.Error(),
			"verdict":        result.Evidence.Verdict,
			"verdict_reason": result.Evidence.VerdictReason,
			"evidence":       result.Evidence,
		}, fasthttp.StatusConflict)
	case errors.Is(err, errShadowRuleConflict):
		SendJSONWithStatus(ctx, map[string]any{
			"error":     err.Error(),
			"conflicts": result.Conflicts,
			"warnings":  result.Warnings,
			"rule":      result.Rule,
		}, fasthttp.StatusConflict)
	case errors.Is(err, configstore.ErrRoutingRulePriorityTaken), errors.Is(err, configstore.ErrAlreadyExists):
		SendError(ctx, fasthttp.StatusConflict, err.Error())
	case errors.Is(err, errShadowStore):
		SendError(ctx, fasthttp.StatusInternalServerError, err.Error())
	case err != nil:
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
	default:
		if !result.DryRun {
			lib.RecordAuditChange(ctx, "shadow.promote", "routing_rule", result.Rule.ID, result.Rule.Name, nil, result.Rule)
		}
		SendJSON(ctx, result)
	}
}

// shadowRollbackRequest is the body of POST /api/shadow/rollback.
type shadowRollbackRequest struct {
	Experiment string `json:"experiment"`
	Candidate  string `json:"candidate"`
	Reason     string `json:"reason,omitempty"`
}

// rollback serves POST /api/shadow/rollback: the candidate leaves its canary
// rule and the source takes its share back.
func (h *ShadowHandler) rollback(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	if h.rules == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "rollback needs the config store, which holds routing rules; enable config_store")
		return
	}
	var req shadowRollbackRequest
	if err := sonic.Unmarshal(ctx.PostBody(), &req); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Experiment == "" || req.Candidate == "" {
		SendError(ctx, fasthttp.StatusBadRequest, "experiment and candidate are required")
		return
	}
	shadowRolloutMu.Lock()
	defer shadowRolloutMu.Unlock()
	result, plan, err := rollbackShadowCanary(ctx, p, h.rules, req.Experiment, req.Candidate)
	if errors.Is(err, shadow.ErrUnknownPair) {
		SendError(ctx, fasthttp.StatusNotFound, err.Error())
		return
	}
	if plan == nil {
		// The pair exists but no rule can be named for it (a wildcard source with no traffic yet).
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	watched := false
	if errors.Is(err, errShadowNoCanary) {
		// No rule left to edit. A canary the plugin still watches (its rule was
		// removed by hand) is closed in the log; anything else is a 404.
		for _, c := range p.Rollouts().Canaries {
			if c.Experiment == req.Experiment && c.Candidate.String() == req.Candidate {
				watched = true
			}
		}
		if !watched {
			SendError(ctx, fasthttp.StatusNotFound, fmt.Sprintf("no canary rule routes %s traffic to %s", plan.Source, req.Candidate))
			return
		}
		err = nil
	}
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, err.Error())
		return
	}
	ev := shadow.RolloutEvent{
		Action:     shadow.RolloutRollback,
		Experiment: req.Experiment,
		Source:     plan.Source,
		Candidate:  plan.Candidate,
		Reason:     strings.TrimSpace(req.Reason),
	}
	if result.Rule != nil {
		ev.RuleID, ev.RuleName = result.Rule.ID, result.Rule.Name
	}
	if recorded, recErr := p.RecordRollout(ev); recErr == nil {
		result.Event = &recorded
	}
	if result.Rule != nil {
		var after any = result.Rule
		if result.Action == "delete" {
			after = nil
		}
		lib.RecordAuditChange(ctx, "shadow.rollback", "routing_rule", result.Rule.ID, result.Rule.Name, nil, after)
	}
	SendJSON(ctx, result)
}

// getRollouts serves GET /api/shadow/rollouts: active canaries with live
// health, and the rollout log newest first.
func (h *ShadowHandler) getRollouts(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	SendJSON(ctx, p.Rollouts())
}

// export serves GET /api/shadow/export?format=json|csv&kind=scorecards|records.
// JSON (the default) returns the summary, every stored record matching the
// filter, and the rollout log; CSV returns one table, scorecards by default.
// The record filters of /api/shadow/records apply; limit and offset do not.
func (h *ShadowHandler) export(ctx *fasthttp.RequestCtx) {
	p := h.plugin(ctx)
	if p == nil {
		return
	}
	format := strings.ToLower(string(ctx.QueryArgs().Peek("format")))
	kind := strings.ToLower(string(ctx.QueryArgs().Peek("kind")))
	filter, ok := recordFilterFromQuery(ctx)
	if !ok {
		return
	}
	filter.Limit, filter.Offset = 0, 0
	stamp := time.Now().UTC().Format("20060102-150405")
	switch format {
	case "", "json":
		ctx.Response.Header.Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"shadow-export-%s.json\"", stamp))
		SendJSON(ctx, map[string]any{
			"exported_at": time.Now().UTC(),
			"summary":     p.Summary(),
			"records":     p.AllRecords(filter),
			"rollouts":    p.Rollouts(),
		})
	case "csv":
		var buf bytes.Buffer
		w := csv.NewWriter(&buf)
		switch kind {
		case "", "scorecards":
			writeScorecardsCSV(w, p.Summary().Pairs)
			kind = "scorecards"
		case "records":
			writeRecordsCSV(w, p.AllRecords(filter))
		default:
			SendError(ctx, fasthttp.StatusBadRequest, "kind must be scorecards or records")
			return
		}
		w.Flush()
		if err := w.Error(); err != nil {
			SendError(ctx, fasthttp.StatusInternalServerError, "failed to write CSV")
			return
		}
		ctx.SetContentType("text/csv; charset=utf-8")
		ctx.Response.Header.Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"shadow-%s-%s.csv\"", kind, stamp))
		ctx.SetBody(buf.Bytes())
	default:
		SendError(ctx, fasthttp.StatusBadRequest, "format must be json or csv")
	}
}

func fmtFloat(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// csvText neutralizes free text a spreadsheet would run as a formula: prompts and
// answers come from end users and models, and the file is meant to be opened.
func csvText(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

func fmtOptFloat(f *float64) string {
	if f == nil {
		return ""
	}
	return fmtFloat(*f)
}

func writeScorecardsCSV(w *csv.Writer, pairs []shadow.PairSummary) {
	_ = w.Write([]string{
		"experiment", "source", "candidate", "verdict", "verdict_reason",
		"samples", "scored", "unscored", "errors", "passes", "judged", "judge_errors",
		"agreement_rate", "agreement_lower_bound", "error_rate", "judge_error_rate", "exact_match_rate",
		"avg_primary_score", "avg_candidate_score", "tool_turns", "tool_name_match_rate", "tool_call_match_rate",
		"primary_p50_ms", "candidate_p50_ms", "primary_p95_ms", "candidate_p95_ms",
		"avg_primary_cost_usd", "avg_candidate_cost_usd", "savings_pct", "savings_per_million_usd", "projected_monthly_savings_usd",
	})
	for _, s := range pairs {
		_ = w.Write([]string{
			csvText(s.Experiment), s.Source.String(), s.Candidate.String(), s.Verdict, csvText(s.VerdictReason),
			strconv.Itoa(s.Samples), strconv.Itoa(s.Scored), strconv.Itoa(s.Unscored), strconv.Itoa(s.Errors), strconv.Itoa(s.Passes), strconv.Itoa(s.Judged), strconv.Itoa(s.JudgeErrors),
			fmtFloat(s.AgreementRate), fmtFloat(s.AgreementLowerBound), fmtFloat(s.ErrorRate), fmtFloat(s.JudgeErrorRate), fmtFloat(s.ExactMatchRate),
			fmtFloat(s.AvgPrimaryScore), fmtFloat(s.AvgCandidateScore), strconv.Itoa(s.ToolTurns), fmtOptFloat(s.ToolNameMatchRate), fmtOptFloat(s.ToolCallMatchRate),
			fmtFloat(s.PrimaryLatency.P50), fmtFloat(s.CandidateLatency.P50), fmtFloat(s.PrimaryLatency.P95), fmtFloat(s.CandidateLatency.P95),
			fmtFloat(s.AvgPrimaryCostUSD), fmtFloat(s.AvgCandidateCostUSD), fmtFloat(s.SavingsPct), fmtFloat(s.SavingsPerMillionUSD), fmtFloat(s.ProjectedMonthlySavingsUSD),
		})
	}
}

func writeRecordsCSV(w *csv.Writer, records []*shadow.Record) {
	_ = w.Write([]string{
		"id", "created_at", "request_id", "experiment", "primary", "candidate", "stream",
		"pass", "pass_basis", "candidate_error", "judge_primary_score", "judge_candidate_score", "judge_winner", "judge_reason", "judge_error",
		"exact_match", "lexical_similarity", "semantic_similarity", "tool_call_diff", "json_match",
		"primary_latency_ms", "candidate_latency_ms", "primary_cost_usd", "candidate_cost_usd", "eval_cost_usd", "prompt",
	})
	for _, r := range records {
		var judgeP, judgeC, winner, reason string
		if r.Judge != nil {
			judgeP, judgeC, winner, reason = fmtFloat(r.Judge.PrimaryScore), fmtFloat(r.Judge.CandidateScore), r.Judge.Winner, csvText(r.Judge.Reason)
		}
		var exact, lexical, semantic, toolDiff, jsonMatch string
		if c := r.Comparison; c != nil {
			exact, lexical, semantic, toolDiff = strconv.FormatBool(c.ExactMatch), fmtFloat(c.LexicalSimilarity), fmtOptFloat(c.SemanticSimilarity), c.ToolCallDiff
			if c.JSONMatch != nil {
				jsonMatch = strconv.FormatBool(*c.JSONMatch)
			}
		}
		_ = w.Write([]string{
			r.ID, r.CreatedAt.UTC().Format(time.RFC3339Nano), csvText(r.RequestID), csvText(r.Experiment), r.Primary.String(), r.Candidate.String(), strconv.FormatBool(r.Stream),
			strconv.FormatBool(r.Pass), r.PassBasis, csvText(r.CandidateError), judgeP, judgeC, winner, reason, csvText(r.JudgeError),
			exact, lexical, semantic, toolDiff, jsonMatch,
			strconv.FormatInt(r.PrimaryLatencyMs, 10), strconv.FormatInt(r.CandidateLatencyMs, 10), fmtFloat(r.PrimaryCostUSD), fmtFloat(r.CandidateCostUSD), fmtFloat(r.EvalCostUSD), csvText(r.Prompt),
		})
	}
}

func parseNonNegative(raw []byte) (int, error) {
	if len(raw) == 0 {
		return 0, nil
	}
	n, err := strconv.Atoi(string(raw))
	if err != nil || n < 0 {
		return 0, errors.New("invalid")
	}
	return n, nil
}
