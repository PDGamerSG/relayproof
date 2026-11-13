package handlers

import (
	"context"
	"encoding/csv"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/plugins/shadow"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/valyala/fasthttp"
)

const (
	testSource = "openai/gpt-4o"
	testMini   = "openai/gpt-4o-mini"
	testLlama  = "openai/llama-3.1-8b"
	testExp    = "cost-down"
)

// memRules is an in-memory ShadowRoutingRules with the config store's
// one-rule-per-priority-per-scope constraint.
type memRules struct {
	mu    sync.Mutex
	rules []configstoreTables.TableRoutingRule
	err   error
}

func (m *memRules) ListRoutingRules(context.Context) ([]configstoreTables.TableRoutingRule, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return nil, m.err
	}
	return append([]configstoreTables.TableRoutingRule(nil), m.rules...), nil
}

func (m *memRules) CreateRoutingRule(_ context.Context, rule *configstoreTables.TableRoutingRule) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rules {
		if r.Scope == rule.Scope && r.Priority == rule.Priority {
			return fmt.Errorf("priority %d: %w", rule.Priority, configstore.ErrRoutingRulePriorityTaken)
		}
	}
	rule.CreatedAt = time.Now()
	m.rules = append(m.rules, *rule)
	return nil
}

func (m *memRules) UpdateRoutingRule(_ context.Context, rule *configstoreTables.TableRoutingRule) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.rules {
		if m.rules[i].ID == rule.ID {
			m.rules[i] = *rule
			return nil
		}
	}
	return configstore.ErrNotFound
}

func (m *memRules) DeleteRoutingRule(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.rules {
		if m.rules[i].ID == id {
			m.rules = append(m.rules[:i], m.rules[i+1:]...)
			return nil
		}
	}
	return configstore.ErrNotFound
}

// servingShares mimics the routing engine for a plain chat request to source:
// the first enabled global rule (lowest priority) that matches decides, and its
// target weights are the traffic shares. It is the effective-traffic check the
// "second canary is unreachable" finding asked for.
func (m *memRules) servingShares(source shadow.ModelRef) map[string]float64 {
	rules, _ := m.ListRoutingRules(context.Background())
	sort.Slice(rules, func(i, j int) bool { return rules[i].Priority < rules[j].Priority })
	for _, r := range rules {
		if r.Scope != "global" || !r.EnabledValue() || celOverlap(r.CelExpression, source) != overlapYes {
			continue
		}
		shares := map[string]float64{}
		for _, t := range r.Targets {
			shares[targetRef(t).String()] += t.Weight
		}
		return shares
	}
	return map[string]float64{source.String(): 1}
}

// newRolloutPlugin starts a real shadow plugin with two candidates and drives n
// sampled requests through its hooks. gpt-4o-mini repeats the primary answer
// (exact matches: ready after enough samples); llama answers differently and,
// with no judge or embeddings, stays unscored.
func newRolloutPlugin(t *testing.T, n int, canary *shadow.CanaryConfig) *shadow.Plugin {
	t.Helper()
	cfg := &shadow.Config{
		SampleRate: 1,
		Experiments: []shadow.Experiment{{
			Name:       testExp,
			Source:     shadow.ModelRef{Provider: "openai", Model: "gpt-4o"},
			Candidates: []shadow.ModelRef{{Provider: "openai", Model: "gpt-4o-mini"}, {Provider: "openai", Model: "llama-3.1-8b"}},
		}},
		PersistPath: filepath.Join(t.TempDir(), "shadow.jsonl"), // isolates the process-wide rollout log
		Thresholds:  shadow.Thresholds{MinSamples: 20},
		Canary:      canary,
	}
	p, err := shadow.Init(context.Background(), cfg, bifrost.NewDefaultLogger(schemas.LogLevelError))
	require.NoError(t, err)
	t.Cleanup(func() { _ = p.Cleanup() })
	p.SetExecutors(func(_ *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
		text := "Paris is the capital of France."
		if req.Model == "llama-3.1-8b" {
			text = "It might be Lyon."
		}
		return chatResp(req.Model, text), nil
	}, nil, nil)
	for i := 0; i < n; i++ {
		ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
		ctx.SetValue(schemas.BifrostContextKeyRequestID, fmt.Sprintf("req-%d", i))
		prompt := "What is the capital of France?"
		_, _, err := p.PreLLMHook(ctx, &schemas.BifrostRequest{RequestType: schemas.ChatCompletionRequest, ChatRequest: &schemas.BifrostChatRequest{
			Provider: "openai",
			Model:    "gpt-4o",
			Input:    []schemas.ChatMessage{{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &prompt}}},
		}})
		require.NoError(t, err)
		_, _, err = p.PostLLMHook(ctx, &schemas.BifrostResponse{ChatResponse: chatResp("gpt-4o", "Paris is the capital of France.")}, nil)
		require.NoError(t, err)
	}
	require.Eventually(t, func() bool { return p.Summary().Counters.Completed >= int64(2*n) }, 10*time.Second, 5*time.Millisecond)
	return p
}

func chatResp(model, text string) *schemas.BifrostChatResponse {
	finish := "stop"
	return &schemas.BifrostChatResponse{
		Model: model,
		Choices: []schemas.BifrostResponseChoice{{
			FinishReason: &finish,
			ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{Message: &schemas.ChatMessage{
				Role:    schemas.ChatMessageRoleAssistant,
				Content: &schemas.ChatMessageContent{ContentStr: &text},
			}},
		}},
		Usage: &schemas.BifrostLLMUsage{PromptTokens: 10, CompletionTokens: 8},
		ExtraFields: schemas.BifrostResponseExtraFields{
			RequestType: schemas.ChatCompletionRequest,
			Provider:    "openai",
			Latency:     100,
			RoutingInfo: schemas.RoutingInfo{Provider: "openai", Model: model},
		},
	}
}

func postCtx(body string) *fasthttp.RequestCtx {
	ctx := &fasthttp.RequestCtx{}
	ctx.Request.Header.SetMethod(fasthttp.MethodPost)
	ctx.Request.SetRequestURI("/api/shadow/x")
	ctx.Request.SetBodyString(body)
	return ctx
}

func promoteBody(candidate string, weight float64, extra string) string {
	return fmt.Sprintf(`{"experiment":%q,"candidate":%q,"weight":%g%s}`, testExp, candidate, weight, extra)
}

var gpt4o = shadow.ModelRef{Provider: "openai", Model: "gpt-4o"}

func TestShadowPromoteCreatesCanaryAndRecordsEvidence(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)

	ctx := postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	body := decode(t, ctx)
	assert.Equal(t, "create", body["action"])
	assert.Equal(t, "ready", body["evidence"].(map[string]any)["verdict"])
	event := body["event"].(map[string]any)
	assert.Equal(t, "promote", event["action"])
	assert.Equal(t, false, event["override"] == true)

	require.Len(t, rules.rules, 1)
	rule := rules.rules[0]
	assert.Equal(t, `provider == "openai" && model == "gpt-4o"`, rule.CelExpression)
	assert.Equal(t, shadow.DefaultCanaryPriority, rule.Priority)
	assert.Equal(t, "Shadow canary: openai/gpt-4o -> openai/gpt-4o-mini", rule.Name)
	assert.Equal(t, map[string]float64{testSource: 0.9, testMini: 0.1}, rules.servingShares(gpt4o))

	r := p.Rollouts()
	require.Len(t, r.Canaries, 1)
	assert.Equal(t, rule.ID, r.Canaries[0].RuleID)
	assert.Equal(t, shadow.CanaryWatching, r.Canaries[0].Health.Status)
}

func TestShadowPromoteRefusesNotReadyWithoutOverride(t *testing.T) {
	p := newRolloutPlugin(t, 30, nil)
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)

	ctx := postCtx(promoteBody(testLlama, 0.1, ""))
	h.promote(ctx)
	assert.Equal(t, fasthttp.StatusConflict, ctx.Response.StatusCode())
	body := decode(t, ctx)
	assert.Equal(t, "collecting", body["verdict"], "llama pairs are unscored without a judge")
	assert.Contains(t, body["error"], "override_reason")
	assert.Empty(t, rules.rules)

	ctx = postCtx(promoteBody(testLlama, 0.05, `,"override_reason":"load test of the self-hosted model"`))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	event := decode(t, ctx)["event"].(map[string]any)
	assert.Equal(t, true, event["override"])
	assert.Equal(t, "load test of the self-hosted model", event["reason"])
}

// Regression for the review finding "promoting a second candidate for the same
// source can succeed without sending it traffic": both rules matched the same
// source, the first one always won, and the second candidate got nothing.
func TestShadowPromoteSecondCandidateSharesTheSameRule(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)

	ctx := postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))

	ctx = postCtx(promoteBody(testLlama, 0.2, `,"override_reason":"compare both"`))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Equal(t, "update", decode(t, ctx)["action"])

	require.Len(t, rules.rules, 1, "one rule per source, not one per candidate")
	assert.Equal(t, "Shadow canary: openai/gpt-4o -> openai/gpt-4o-mini, openai/llama-3.1-8b", rules.rules[0].Name)
	shares := rules.servingShares(gpt4o)
	assert.InDelta(t, 0.7, shares[testSource], 1e-9)
	assert.InDelta(t, 0.1, shares[testMini], 1e-9)
	assert.InDelta(t, 0.2, shares[testLlama], 1e-9, "the second candidate is reachable")
	assert.Len(t, p.Rollouts().Canaries, 2)

	// Ramping the first candidate keeps the second.
	ctx = postCtx(promoteBody(testMini, 0.5, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	shares = rules.servingShares(gpt4o)
	assert.InDelta(t, 0.3, shares[testSource], 1e-9)
	assert.InDelta(t, 0.5, shares[testMini], 1e-9)
	assert.InDelta(t, 0.2, shares[testLlama], 1e-9)

	// Shares over 100% are refused.
	ctx = postCtx(promoteBody(testMini, 0.9, ""))
	h.promote(ctx)
	assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode())
	assert.Contains(t, string(ctx.Response.Body()), "exceed 100%")
}

func TestShadowPromoteDetectsConflictingRules(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	enabled := true
	other := "anthropic"
	rules := &memRules{rules: []configstoreTables.TableRoutingRule{
		{ID: "pinned", Name: "pin gpt-4o", Enabled: &enabled, Scope: "global", Priority: 5, CelExpression: `model == "gpt-4o"`, Targets: []configstoreTables.TableRoutingTarget{{Provider: &other, Weight: 1}}},
		{ID: "tenant", Name: "tenant override", Enabled: &enabled, Scope: "global", Priority: 1, CelExpression: `headers["x-tenant"] == "acme" && model == "gpt-4o"`, Targets: []configstoreTables.TableRoutingTarget{{Provider: &other, Weight: 1}}},
		{ID: "embeddings", Name: "embeddings", Enabled: &enabled, Scope: "global", Priority: 2, CelExpression: `request_type == "embedding"`, Targets: []configstoreTables.TableRoutingTarget{{Provider: &other, Weight: 1}}},
	}}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)

	ctx := postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	assert.Equal(t, fasthttp.StatusConflict, ctx.Response.StatusCode())
	body := decode(t, ctx)
	conflicts := body["conflicts"].([]any)
	require.Len(t, conflicts, 1)
	assert.Contains(t, conflicts[0], `"pin gpt-4o"`)
	assert.Len(t, rules.rules, 3, "nothing is written")

	// Below the pinning rule the canary is reachable; the tenant rule may still
	// catch some requests, and the pinning rule loses gpt-4o traffic.
	ctx = postCtx(promoteBody(testMini, 0.1, `,"priority":3`))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	warnings := fmt.Sprint(decode(t, ctx)["warnings"])
	assert.Contains(t, warnings, `"tenant override"`)
	assert.Contains(t, warnings, `"pin gpt-4o" (scope global, priority 5) runs after the canary`)
	assert.NotContains(t, warnings, "embeddings")
	assert.InDelta(t, 0.1, rules.servingShares(gpt4o)[testMini], 1e-9)
}

func TestShadowPromoteDryRunAndValidation(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)

	ctx := postCtx(promoteBody(testMini, 0.25, `,"dry_run":true`))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	body := decode(t, ctx)
	assert.Equal(t, true, body["dry_run"])
	assert.Nil(t, body["event"])
	assert.Empty(t, rules.rules, "a dry run writes nothing")
	assert.Empty(t, p.Rollouts().Events)

	for _, bad := range []string{`{`, `{"experiment":"cost-down"}`, promoteBody(testMini, 0, ""), promoteBody(testMini, 1.5, ""), promoteBody(testMini, 0.1, `,"priority":-1`)} {
		ctx := postCtx(bad)
		h.promote(ctx)
		assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode(), bad)
	}
	ctx = postCtx(promoteBody("openai/unknown", 0.1, ""))
	h.promote(ctx)
	assert.Equal(t, fasthttp.StatusNotFound, ctx.Response.StatusCode())

	// A priority another rule holds is a conflict, not a server error.
	enabled := false
	rules.rules = []configstoreTables.TableRoutingRule{{ID: "x", Name: "disabled", Enabled: &enabled, Scope: "global", Priority: 7, CelExpression: "true"}}
	ctx = postCtx(promoteBody(testMini, 0.1, `,"priority":7`))
	h.promote(ctx)
	assert.Equal(t, fasthttp.StatusConflict, ctx.Response.StatusCode(), string(ctx.Response.Body()))

	// Without the config store there is nowhere to write rules.
	h = NewShadowHandler(func() ShadowReader { return p }, nil)
	ctx = postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	assert.Equal(t, fasthttp.StatusServiceUnavailable, ctx.Response.StatusCode())
}

func TestShadowPromotePicksAFreePriority(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	enabled := true
	rules := &memRules{rules: []configstoreTables.TableRoutingRule{
		{ID: "a", Name: "a", Enabled: &enabled, Scope: "global", Priority: 10, CelExpression: `model == "other"`},
		{ID: "b", Name: "b", Enabled: &enabled, Scope: "global", Priority: 11, CelExpression: `model == "other2"`},
	}}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	ctx := postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Equal(t, float64(12), decode(t, ctx)["rule"].(map[string]any)["priority"])
}

func TestShadowRollback(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	for _, body := range []string{promoteBody(testMini, 0.1, ""), promoteBody(testLlama, 0.2, `,"override_reason":"x"`)} {
		ctx := postCtx(body)
		h.promote(ctx)
		require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	}

	ctx := postCtx(fmt.Sprintf(`{"experiment":%q,"candidate":%q,"reason":"too slow"}`, testExp, testLlama))
	h.rollback(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Equal(t, "update", decode(t, ctx)["action"])
	assert.Equal(t, map[string]float64{testSource: 0.9, testMini: 0.1}, rules.servingShares(gpt4o))
	assert.Equal(t, "Shadow canary: openai/gpt-4o -> openai/gpt-4o-mini", rules.rules[0].Name)

	ctx = postCtx(fmt.Sprintf(`{"experiment":%q,"candidate":%q}`, testExp, testMini))
	h.rollback(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Equal(t, "delete", decode(t, ctx)["action"])
	assert.Empty(t, rules.rules, "a rule left with only the source is deleted")
	assert.Equal(t, map[string]float64{testSource: 1}, rules.servingShares(gpt4o))

	r := p.Rollouts()
	assert.Empty(t, r.Canaries)
	require.Len(t, r.Events, 4)
	assert.Equal(t, shadow.RolloutRollback, r.Events[0].Action)
	assert.Equal(t, "too slow", r.Events[1].Reason)

	ctx = postCtx(fmt.Sprintf(`{"experiment":%q,"candidate":%q}`, testExp, testMini))
	h.rollback(ctx)
	assert.Equal(t, fasthttp.StatusNotFound, ctx.Response.StatusCode(), "nothing left to roll back")
}

// A canary whose rule was deleted by hand is closed in the log by a rollback.
func TestShadowRollbackOfRemovedRuleClosesTheCanary(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	ctx := postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	rules.rules = nil

	ctx = postCtx(fmt.Sprintf(`{"experiment":%q,"candidate":%q}`, testExp, testMini))
	h.rollback(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Equal(t, "none", decode(t, ctx)["action"])
	assert.Empty(t, p.Rollouts().Canaries)
}

// The canary guard rolls an unhealthy canary back through the hook the server wires.
func TestShadowRollbackHookUsedByCanaryGuard(t *testing.T) {
	p := newRolloutPlugin(t, 40, &shadow.CanaryConfig{AutoRollback: true, MinRequests: 5})
	rules := &memRules{}
	p.SetRollbackHook(NewShadowRollbackHook(p, rules))
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	ctx := postCtx(promoteBody(testMini, 0.5, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())

	// Live canary traffic: every candidate request fails.
	status := 500
	for i := 0; i < 10; i++ {
		_, _, err := p.PostLLMHook(schemas.NewBifrostContext(context.Background(), schemas.NoDeadline), nil, &schemas.BifrostError{
			StatusCode: &status,
			Error:      &schemas.ErrorField{Message: "boom"},
			ExtraFields: schemas.BifrostErrorExtraFields{RequestType: schemas.ChatCompletionRequest, RoutingInfo: schemas.RoutingInfo{
				Provider: "openai", Model: "gpt-4o-mini", RequestedProvider: "openai", RequestedModel: "gpt-4o",
			}},
		})
		require.NoError(t, err)
	}
	require.Eventually(t, func() bool { return len(p.Rollouts().Canaries) == 0 }, 15*time.Second, 50*time.Millisecond, "the guard checks every few seconds")
	assert.Empty(t, rules.rules, "the canary rule is gone")
	ev := p.Rollouts().Events[0]
	assert.Equal(t, shadow.RolloutAutoRollback, ev.Action)
	assert.Contains(t, ev.Reason, "live error rate 100.0%")
}

func TestCELOverlap(t *testing.T) {
	cases := map[string]ruleOverlap{
		``:                  overlapYes,
		`true`:              overlapYes,
		`model == "gpt-4o"`: overlapYes,
		`provider == "openai" && model == "gpt-4o"`:  overlapYes,
		`model.startsWith("gpt-4")`:                  overlapYes,
		`model == "gpt-4o-mini"`:                     overlapNone,
		`provider == "anthropic"`:                    overlapNone,
		`request_type == "embedding"`:                overlapNone,
		`request_type == "chat_completion_stream"`:   overlapMaybe,
		`request_type.startsWith("chat_completion")`: overlapYes,
		`headers["x-tenant"] == "acme"`:              overlapMaybe,
		`budget_used > 80.0 && model == "gpt-4o"`:    overlapMaybe,
		`budget_used > 80.0 && model == "other"`:     overlapNone,
		`this is not cel`:                            overlapMaybe,
	}
	for expr, want := range cases {
		assert.Equal(t, want, celOverlap(expr, gpt4o), expr)
	}
}

func TestShadowRolloutsAndExport(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	ctx := postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())

	ctx = shadowCtx("")
	h.getRollouts(ctx)
	body := decode(t, ctx)
	assert.Len(t, body["canaries"], 1)
	assert.Len(t, body["events"], 1)

	ctx = shadowCtx("")
	h.export(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.Contains(t, string(ctx.Response.Header.Peek("Content-Disposition")), "shadow-export-")
	body = decode(t, ctx)
	assert.Len(t, body["records"], 80, "every record, not one page")
	assert.NotNil(t, body["summary"])
	assert.NotNil(t, body["rollouts"])

	ctx = shadowCtx("format=csv")
	h.export(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.Equal(t, "text/csv; charset=utf-8", string(ctx.Response.Header.ContentType()))
	rows, err := csv.NewReader(strings.NewReader(string(ctx.Response.Body()))).ReadAll()
	require.NoError(t, err)
	require.Len(t, rows, 3, "header and one row per candidate")
	assert.Equal(t, "experiment", rows[0][0])
	assert.Equal(t, "ready", rows[1][3])

	ctx = shadowCtx("format=csv&kind=records&candidate=" + testMini)
	h.export(ctx)
	rows, err = csv.NewReader(strings.NewReader(string(ctx.Response.Body()))).ReadAll()
	require.NoError(t, err)
	assert.Len(t, rows, 41)
	assert.Equal(t, "exact", rows[1][8])

	for _, q := range []string{"format=xml", "format=csv&kind=everything", "outcome=maybe"} {
		ctx = shadowCtx(q)
		h.export(ctx)
		assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode(), q)
	}
}
