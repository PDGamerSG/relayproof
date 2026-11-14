package handlers

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/plugins/shadow"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/valyala/fasthttp"
)

func rampBody(candidate, ramp, extra string) string {
	return fmt.Sprintf(`{"experiment":%q,"candidate":%q,"ramp":%s%s}`, testExp, candidate, ramp, extra)
}

// serveCanary feeds live responses for gpt-4o requests served by served.
func serveCanary(t *testing.T, p *shadow.Plugin, served string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		resp := &schemas.BifrostResponse{ChatResponse: chatResp(served, "Paris.")}
		resp.ChatResponse.ExtraFields.RoutingInfo.RequestedProvider = "openai"
		resp.ChatResponse.ExtraFields.RoutingInfo.RequestedModel = "gpt-4o"
		_, _, err := p.PostLLMHook(schemas.NewBifrostContext(context.Background(), schemas.NoDeadline), resp, nil)
		require.NoError(t, err)
	}
}

func TestShadowPromoteWithRamp(t *testing.T) {
	p := newRolloutPlugin(t, 40, &shadow.CanaryConfig{AutoRollback: true, MinRequests: 5})
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)

	// A dry run shows the ramp and writes nothing.
	ctx := postCtx(rampBody(testMini, `{"steps":[0.1,0.25,0.5,1],"min_requests":5,"hold_seconds":30}`, `,"dry_run":true`))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	body := decode(t, ctx)
	ramp := body["ramp"].(map[string]any)
	assert.Equal(t, []any{0.1, 0.25, 0.5, 1.0}, ramp["steps"])
	assert.Equal(t, 0.25, ramp["next_weight"])
	assert.Equal(t, float64(5), ramp["min_requests"])
	assert.Equal(t, float64(30), ramp["hold_seconds"])
	assert.Equal(t, 0.1, targetWeight(t, body, testMini), "weight left out: the canary starts at steps[0]")
	assert.Empty(t, rules.rules)
	assert.Empty(t, p.Rollouts().Events)

	ctx = postCtx(rampBody(testMini, `{"steps":[0.1,0.25,0.5,1],"min_requests":5,"hold_seconds":30}`, `,"weight":0.1`))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	body = decode(t, ctx)
	assert.Equal(t, float64(0), body["ramp"].(map[string]any)["current_step"])
	event := body["event"].(map[string]any)
	assert.Equal(t, "promote", event["action"])
	assert.Equal(t, 0.1, event["weight"])
	assert.Equal(t, body["ramp"], event["ramp"], "the response's ramp is the one recorded")
	assert.Equal(t, map[string]float64{testSource: 0.9, testMini: 0.1}, rules.servingShares(gpt4o))

	c := p.Rollouts().Canaries[0]
	require.NotNil(t, c.Ramp)
	assert.Equal(t, 0, c.Ramp.CurrentStep)
	assert.Equal(t, "step 1 of 4 (10%): 0 of 5 candidate requests", c.Ramp.Reason)
}

func targetWeight(t *testing.T, promotion map[string]any, ref string) float64 {
	t.Helper()
	for _, raw := range promotion["rule"].(map[string]any)["targets"].([]any) {
		target := raw.(map[string]any)
		if target["provider"].(string)+"/"+target["model"].(string) == ref {
			return target["weight"].(float64)
		}
	}
	return 0
}

func TestShadowPromoteRampValidation(t *testing.T) {
	p := newRolloutPlugin(t, 40, &shadow.CanaryConfig{AutoRollback: true, MinRequests: 5})
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	cases := map[string]string{
		rampBody(testMini, `{"steps":[0.5,0.25]}`, ""):                        "strictly ascending",
		rampBody(testMini, `{"steps":[0.1]}`, ""):                             "ramp.steps needs 2 to 20 weights, got 1",
		rampBody(testMini, `{}`, ""):                                          "got 0",
		rampBody(testMini, `{"steps":[0,0.5]}`, ""):                           "ramp.steps[0] must be a number from 0.0001 to 1",
		rampBody(testMini, `{"steps":[0.1,1.5]}`, ""):                         "ramp.steps[1] must be a number from 0.0001 to 1",
		rampBody(testMini, `{"steps":[0.1,0.5]}`, `,"weight":0.2`):            "ramp.steps[0] (0.1) must equal weight (0.2)",
		rampBody(testMini, `{"steps":[0.1,0.5],"min_requests":2}`, ""):        "ramp.min_requests must be at least canary.min_requests (5)",
		rampBody(testMini, `{"steps":[0.1,0.5],"hold_seconds":-1}`, ""):       "ramp.hold_seconds must be from 0 to 604800",
		rampBody(testMini, `{"steps":[0.1,0.5],"hold_seconds":99999999}`, ""): "ramp.hold_seconds must be from 0 to 604800",
		rampBody(testMini, `"fast"`, ""):                                      "invalid JSON body",
		rampBody(testMini, `{"steps":["10%"]}`, ""):                           "invalid JSON body",
	}
	for b, want := range cases {
		ctx := postCtx(b)
		h.promote(ctx)
		assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode(), b)
		assert.Contains(t, string(ctx.Response.Body()), want, b)
	}
	assert.Empty(t, rules.rules, "nothing is written")

	// A ramp that could never reach its last step next to another candidate.
	ctx := postCtx(promoteBody(testLlama, 0.2, `,"override_reason":"compare both"`))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	ctx = postCtx(rampBody(testMini, `{"steps":[0.1,0.5,1]}`, ""))
	h.promote(ctx)
	assert.Equal(t, fasthttp.StatusBadRequest, ctx.Response.StatusCode())
	assert.Contains(t, string(ctx.Response.Body()), "the ramp's last step (100%) and the other candidates' 20% of openai/gpt-4o traffic add up to more than 100%")
	ctx = postCtx(rampBody(testMini, `{"steps":[0.1,0.5,0.8]}`, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), "0.8 + 0.2 fits: %s", ctx.Response.Body())
}

// Without a ramp, the promotion response and the rollout log carry no ramp field.
func TestShadowPromoteWithoutRampIsUnchanged(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil)
	h := NewShadowHandler(func() ShadowReader { return p }, &memRules{})
	ctx := postCtx(promoteBody(testMini, 0.1, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode())
	assert.NotContains(t, string(ctx.Response.Body()), `"ramp"`)
	ctx = shadowCtx("")
	h.getRollouts(ctx)
	assert.NotContains(t, string(ctx.Response.Body()), `"ramp"`)
}

func TestShadowPromoteCancelsOrReplacesARamp(t *testing.T) {
	p := newRolloutPlugin(t, 40, nil) // no canary block: auto_rollback off
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)

	ctx := postCtx(rampBody(testMini, `{"steps":[0.1,0.5,1]}`, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Contains(t, fmt.Sprint(decode(t, ctx)["warnings"]), "canary.auto_rollback is off: an unhealthy step holds the ramp")

	ctx = postCtx(rampBody(testMini, `{"steps":[0.2,0.6]}`, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Contains(t, fmt.Sprint(decode(t, ctx)["warnings"]), "this replaces the canary's ramp at step 1 of 3 (10%); the new ramp starts at 20%")
	c := p.Rollouts().Canaries[0]
	assert.Equal(t, []float64{0.2, 0.6}, c.Ramp.Steps)
	assert.Equal(t, 0.2, c.Weight)

	ctx = postCtx(promoteBody(testMini, 0.3, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	assert.Contains(t, fmt.Sprint(decode(t, ctx)["warnings"]), "this cancels the canary's ramp at step 1 of 2 (20%)")
	c = p.Rollouts().Canaries[0]
	assert.Nil(t, c.Ramp)
	assert.Equal(t, 0.3, c.Weight)
	assert.InDelta(t, 0.3, rules.servingShares(gpt4o)[testMini], 1e-9)
}

// The ramp hook moves the candidate's share in the existing rule through the
// promotion merge, and never creates a rule.
func TestShadowRampHookEditsTheExistingRuleOnly(t *testing.T) {
	p := newRolloutPlugin(t, 40, &shadow.CanaryConfig{AutoRollback: true, MinRequests: 5})
	rules := &memRules{}
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	for _, b := range []string{rampBody(testMini, `{"steps":[0.1,0.5,0.8]}`, ""), promoteBody(testLlama, 0.2, `,"override_reason":"x"`)} {
		ctx := postCtx(b)
		h.promote(ctx)
		require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))
	}
	hook := NewShadowRampHook(p, rules)
	require.NotNil(t, hook)
	assert.Nil(t, NewShadowRampHook(p, nil), "no config store: no ramp")

	var doneRule string
	done := func(id, name string) error { doneRule = id + "|" + name; return nil }
	err := hook(context.Background(), testExp, testMini, 0.5, func() bool { return false }, done)
	assert.ErrorIs(t, err, shadow.ErrCanaryChanged)
	assert.InDelta(t, 0.1, rules.servingShares(gpt4o)[testMini], 1e-9, "a changed canary is left alone")

	require.NoError(t, hook(context.Background(), testExp, testMini, 0.5, func() bool { return true }, done))
	shares := rules.servingShares(gpt4o)
	assert.InDelta(t, 0.3, shares[testSource], 1e-9)
	assert.InDelta(t, 0.5, shares[testMini], 1e-9)
	assert.InDelta(t, 0.2, shares[testLlama], 1e-9, "the other candidate keeps its share")
	require.Len(t, rules.rules, 1)
	assert.Equal(t, rules.rules[0].ID+"|"+rules.rules[0].Name, doneRule)

	// The candidate taken out of the rule by hand: the ramp cannot put it back.
	_, _, err = rollbackShadowCanary(context.Background(), p, rules, testExp, testMini)
	require.NoError(t, err)
	err = hook(context.Background(), testExp, testMini, 0.8, nil, done)
	assert.True(t, errors.Is(err, errShadowNoCanary), err)
	assert.Zero(t, rules.servingShares(gpt4o)[testMini])

	// The rule deleted by hand: nothing is created.
	rules.rules = nil
	err = hook(context.Background(), testExp, testMini, 0.8, nil, done)
	assert.True(t, errors.Is(err, errShadowNoCanary), err)
	assert.Empty(t, rules.rules)
}

// The canary guard ramps a canary through the hook the server wires.
func TestShadowRampHookUsedByCanaryGuard(t *testing.T) {
	p := newRolloutPlugin(t, 40, &shadow.CanaryConfig{AutoRollback: true, MinRequests: 5})
	rules := &memRules{}
	p.SetRollbackHook(NewShadowRollbackHook(p, rules))
	p.SetRampHook(NewShadowRampHook(p, rules))
	h := NewShadowHandler(func() ShadowReader { return p }, rules)
	ctx := postCtx(rampBody(testMini, `{"steps":[0.1,1],"min_requests":5,"hold_seconds":0}`, ""))
	h.promote(ctx)
	require.Equal(t, fasthttp.StatusOK, ctx.Response.StatusCode(), string(ctx.Response.Body()))

	serveCanary(t, p, "gpt-4o", 20)
	serveCanary(t, p, "gpt-4o-mini", 5)
	require.Eventually(t, func() bool {
		r := p.Rollouts()
		return len(r.Events) > 0 && r.Events[0].Action == shadow.RolloutRampComplete
	}, 15*time.Second, 50*time.Millisecond, "the guard checks every few seconds")
	assert.Equal(t, map[string]float64{testMini: 1}, rules.servingShares(gpt4o), "the last step is a full cutover")
	c := p.Rollouts().Canaries[0]
	assert.Equal(t, 1.0, c.Weight)
	assert.True(t, c.Ramp.Completed)
	ev := p.Rollouts().Events[0]
	assert.Equal(t, "canary_guard", ev.Actor)
	assert.Equal(t, rules.rules[0].ID, ev.RuleID)
	require.NotNil(t, ev.Health)
	assert.Equal(t, int64(5), ev.Health.Candidate.Requests)
}
