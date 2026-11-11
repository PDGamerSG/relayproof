package handlers

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"

	"github.com/fasthttp/router"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/plugins/shadow"
	"github.com/maximhq/bifrost/transports/v2/bifrost-http/lib"
	"github.com/valyala/fasthttp"
)

// ShadowReader is the contract the handler needs from the shadow plugin.
// Exported so server wiring can supply a resolver and tests a fake.
type ShadowReader interface {
	Summary() shadow.Summary
	Records(f shadow.RecordFilter) ([]*shadow.Record, int)
	Record(id string) *shadow.Record
	Reset() error
	BuildCanaryRule(experiment, candidate string, weight float64, priority ...int) (*shadow.CanaryRule, error)
}

// ShadowResolver returns the currently loaded shadow plugin, or nil. It is called
// per request so plugin reloads through /api/plugins are honored.
type ShadowResolver func() ShadowReader

// ShadowHandler serves the shadow traffic evaluation API.
type ShadowHandler struct {
	resolve ShadowResolver
}

// NewShadowHandler returns a handler that resolves the plugin at request time.
// It is safe to wire unconditionally: when the plugin is not loaded every route
// answers 404 with a clear message.
func NewShadowHandler(resolve ShadowResolver) *ShadowHandler {
	return &ShadowHandler{resolve: resolve}
}

// RegisterRoutes registers the shadow routes.
func (h *ShadowHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.GET("/api/shadow/summary", lib.ChainMiddlewares(h.getSummary, middlewares...))
	r.GET("/api/shadow/records", lib.ChainMiddlewares(h.listRecords, middlewares...))
	r.GET("/api/shadow/records/{id}", lib.ChainMiddlewares(h.getRecord, middlewares...))
	r.DELETE("/api/shadow/records", lib.ChainMiddlewares(h.resetRecords, middlewares...))
	r.GET("/api/shadow/canary-rule", lib.ChainMiddlewares(h.getCanaryRule, middlewares...))
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
	args := ctx.QueryArgs()
	outcome, err := shadow.ParseOutcome(string(args.Peek("outcome")))
	if err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	filter := shadow.RecordFilter{
		Experiment: string(args.Peek("experiment")),
		Candidate:  string(args.Peek("candidate")),
		Outcome:    outcome,
	}
	if filter.Limit, err = parseNonNegative(args.Peek("limit")); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "limit must be a non-negative integer")
		return
	}
	if filter.Offset, err = parseNonNegative(args.Peek("offset")); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "offset must be a non-negative integer")
		return
	}
	records, total := p.Records(filter)
	SendJSON(ctx, map[string]any{
		"records": records,
		"total":   total,
	})
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
// API allows one rule per priority in a scope).
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
