package handlers

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/maximhq/bifrost/plugins/shadow"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/valyala/fasthttp"
)

// fakeShadow is an in-memory ShadowReader.
type fakeShadow struct {
	records      []*shadow.Record
	lastFilter   shadow.RecordFilter
	resets       int
	resetErr     error
	ruleErr      error
	lastWeight   float64
	lastPriority []int
	ruleCalls    int
}

func (f *fakeShadow) Summary() shadow.Summary {
	return shadow.Summary{SampleRate: 0.25, Pairs: []shadow.PairSummary{{Experiment: "e", Verdict: shadow.VerdictReady}}}
}

func (f *fakeShadow) Records(filter shadow.RecordFilter) ([]*shadow.Record, int) {
	f.lastFilter = filter
	return f.records, len(f.records)
}

func (f *fakeShadow) Record(id string) *shadow.Record {
	for _, r := range f.records {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func (f *fakeShadow) Reset() error {
	f.resets++
	return f.resetErr
}

func (f *fakeShadow) BuildCanaryRule(experiment, candidate string, weight float64, priority ...int) (*shadow.CanaryRule, error) {
	f.lastWeight = weight
	f.lastPriority = priority
	f.ruleCalls++
	if f.ruleErr != nil {
		return nil, f.ruleErr
	}
	return &shadow.CanaryRule{Name: experiment + "->" + candidate, CelExpression: `model == "x"`}, nil
}

func (f *fakeShadow) PairScorecard(experiment, candidate string) (shadow.PairSummary, error) {
	return shadow.PairSummary{Experiment: experiment, Verdict: shadow.VerdictReady}, nil
}

func (f *fakeShadow) RecordRollout(ev shadow.RolloutEvent) (shadow.RolloutEvent, error) {
	return ev, nil
}

func (f *fakeShadow) Rollouts() shadow.Rollouts { return shadow.Rollouts{} }

func shadowCtx(query string) *fasthttp.RequestCtx {
	ctx := &fasthttp.RequestCtx{}
	ctx.Request.SetRequestURI("/api/shadow/x?" + query)
	return ctx
}

func decode(t *testing.T, ctx *fasthttp.RequestCtx) map[string]any {
	t.Helper()
	var out map[string]any
	require.NoError(t, json.Unmarshal(ctx.Response.Body(), &out), string(ctx.Response.Body()))
	return out
}

func TestShadowHandlerPluginNotLoaded(t *testing.T) {
	h := NewShadowHandler(func() ShadowReader { return nil }, nil)
	for _, fn := range []fasthttp.RequestHandler{h.getSummary, h.listRecords, h.getRecord, h.resetRecords, h.getCanaryRule, h.promote, h.rollback, h.getRollouts, h.export} {
		ctx := shadowCtx("")
		fn(ctx)
		assert.Equal(t, fasthttp.StatusNotFound, ctx.Response.StatusCode())
		assert.Contains(t, string(ctx.Response.Body()), "shadow plugin is not enabled")
	}
}

func TestShadowHandlerSummary(t *testing.T) {
	h := NewShadowHandler(func() ShadowReader { return &fakeShadow{} }, nil)
	ctx := shadowCtx("")
	h.getSummary(ctx)
	assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	body := decode(t, ctx)
	assert.Equal(t, 0.25, body["sample_rate"])
	pairs := body["pairs"].([]any)
	assert.Equal(t, "ready", pairs[0].(map[string]any)["verdict"])
}

func TestShadowHandlerListRecords(t *testing.T) {
	f := &fakeShadow{records: []*shadow.Record{{ID: "r1"}, {ID: "r2"}}}
	h := NewShadowHandler(func() ShadowReader { return f }, nil)
	ctx := shadowCtx("experiment=exp&candidate=openai%2Fgpt-small&outcome=fail&limit=20&offset=40")
	h.listRecords(ctx)
	assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.Equal(t, shadow.RecordFilter{Experiment: "exp", Candidate: "openai/gpt-small", Outcome: "fail", Limit: 20, Offset: 40}, f.lastFilter)
	body := decode(t, ctx)
	assert.Equal(t, float64(2), body["total"])

	for _, q := range []string{"outcome=maybe", "limit=-1", "offset=abc"} {
		ctx := shadowCtx(q)
		h.listRecords(ctx)
		assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode(), q)
	}
}

func TestShadowHandlerGetRecord(t *testing.T) {
	f := &fakeShadow{records: []*shadow.Record{{ID: "r1", Experiment: "e"}}}
	h := NewShadowHandler(func() ShadowReader { return f }, nil)
	ctx := shadowCtx("")
	ctx.SetUserValue("id", "r1")
	h.getRecord(ctx)
	assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.Equal(t, "e", decode(t, ctx)["experiment"])

	ctx = shadowCtx("")
	ctx.SetUserValue("id", "missing")
	h.getRecord(ctx)
	assert.Equal(t, fasthttp.StatusNotFound, ctx.Response.StatusCode())
}

func TestShadowHandlerReset(t *testing.T) {
	f := &fakeShadow{}
	h := NewShadowHandler(func() ShadowReader { return f }, nil)
	ctx := shadowCtx("")
	h.resetRecords(ctx)
	assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.Equal(t, 1, f.resets)

	f.resetErr = errors.New("disk full")
	ctx = shadowCtx("")
	h.resetRecords(ctx)
	assert.Equal(t, fasthttp.StatusInternalServerError, ctx.Response.StatusCode())
}

func TestShadowHandlerCanaryRule(t *testing.T) {
	f := &fakeShadow{}
	h := NewShadowHandler(func() ShadowReader { return f }, nil)

	ctx := shadowCtx("experiment=e&candidate=openai%2Fsmall")
	h.getCanaryRule(ctx)
	assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.Equal(t, 0.1, f.lastWeight, "default canary weight is 10%")
	assert.Equal(t, "e->openai/small", decode(t, ctx)["name"])

	ctx = shadowCtx("experiment=e&candidate=openai%2Fsmall&weight=0.25")
	h.getCanaryRule(ctx)
	assert.Equal(t, 0.25, f.lastWeight)

	ctx = shadowCtx("experiment=e")
	h.getCanaryRule(ctx)
	assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode(), "candidate is required")

	ctx = shadowCtx("experiment=e&candidate=c&weight=lots")
	h.getCanaryRule(ctx)
	assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode())

	f.ruleErr = shadow.ErrUnknownPair
	ctx = shadowCtx("experiment=e&candidate=c")
	h.getCanaryRule(ctx)
	assert.Equal(t, fasthttp.StatusNotFound, ctx.Response.StatusCode())

	f.ruleErr = errors.New("weight must be in (0, 1]")
	ctx = shadowCtx("experiment=e&candidate=c&weight=2")
	h.getCanaryRule(ctx)
	assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode())
}

func TestShadowHandlerCanaryRuleRejectsUnusableWeights(t *testing.T) {
	f := &fakeShadow{}
	h := NewShadowHandler(func() ShadowReader { return f }, nil)
	for _, w := range []string{"NaN", "nan", "Inf", "%2BInf", "-Inf", "infinity", "0", "-0.5", "0.00001", "1.5", "lots"} {
		ctx := shadowCtx("experiment=e&candidate=c&weight=" + w)
		h.getCanaryRule(ctx)
		assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode(), "weight=%s", w)
		assert.Contains(t, string(ctx.Response.Body()), "weight must be a number from 0.0001 to 1", "weight=%s", w)
	}
	assert.Zero(t, f.ruleCalls, "an unusable weight is rejected before a rule is built")

	ctx := shadowCtx("experiment=e&candidate=c&weight=0.0001")
	h.getCanaryRule(ctx)
	assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), "the smallest routable weight is accepted")
	assert.Equal(t, 0.0001, f.lastWeight)
}

func TestShadowHandlerCanaryRuleRejectsInvalidPriority(t *testing.T) {
	f := &fakeShadow{}
	h := NewShadowHandler(func() ShadowReader { return f }, nil)
	for _, p := range []string{"-1", "abc", "1.5", "1e3"} {
		ctx := shadowCtx("experiment=e&candidate=c&priority=" + p)
		h.getCanaryRule(ctx)
		assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode(), "priority=%s", p)
		assert.Contains(t, string(ctx.Response.Body()), "priority must be a non-negative integer", "priority=%s", p)
	}
	assert.Zero(t, f.ruleCalls)
}

func TestShadowHandlerCanaryRulePriority(t *testing.T) {
	f := &fakeShadow{}
	h := NewShadowHandler(func() ShadowReader { return f }, nil)

	ctx := shadowCtx("experiment=e&candidate=c")
	h.getCanaryRule(ctx)
	assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.Equal(t, []int{shadow.DefaultCanaryPriority}, f.lastPriority, "priority defaults to 10")

	for query, want := range map[string]int{"priority=25": 25, "priority=0": 0} {
		ctx := shadowCtx("experiment=e&candidate=c&" + query)
		h.getCanaryRule(ctx)
		assert.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), query)
		assert.Equal(t, []int{want}, f.lastPriority, query)
	}
}

func TestCSVTextNeutralizesFormulas(t *testing.T) {
	for in, want := range map[string]string{
		"=HYPERLINK(\"http://x\")": "'=HYPERLINK(\"http://x\")",
		"+1":                       "'+1",
		"-2":                       "'-2",
		"@SUM(A1)":                 "'@SUM(A1)",
		"\tx":                      "'\tx",
		"What is 2+2?":             "What is 2+2?",
		"":                         "",
	} {
		assert.Equal(t, want, csvText(in), in)
	}
}
