package shadow

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rampRecorder is a RampFunc that follows the gateway's contract: check
// current, "edit the rule", then call done.
type rampRecorder struct {
	mu     sync.Mutex
	calls  []float64
	err    error
	before func() // runs before the current check, as a concurrent operator action would
}

func (r *rampRecorder) hook(_ context.Context, _, _ string, weight float64, current func() bool, done func(string, string) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.before != nil {
		r.before()
	}
	if current != nil && !current() {
		return ErrCanaryChanged
	}
	r.calls = append(r.calls, weight)
	if r.err != nil {
		return r.err
	}
	return done("rule-1", "Shadow canary: openai/gpt-big -> openai/gpt-small")
}

func (r *rampRecorder) weights() []float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]float64(nil), r.calls...)
}

func intp(n int) *int { return &n }

// promoteRamp records a promotion with a ramp, the way the gateway does, at
// time at. Tests date ramps in the past: a live response whose latency
// reaches back before the current step started is not counted, so steps that
// start "now" would ignore the 300 ms responses serveLive sends.
func promoteRamp(t *testing.T, p *Plugin, req RampRequest, at time.Time) RolloutEvent {
	t.Helper()
	plan, weight, err := p.PlanRamp(req, nil)
	require.NoError(t, err)
	exp := p.config.Experiments[0]
	ev, err := p.RecordRollout(RolloutEvent{
		At:         at,
		Action:     RolloutPromote,
		Experiment: exp.Name,
		Source:     exp.Source,
		Candidate:  exp.Candidates[0],
		Weight:     weight,
		RuleID:     "rule-1",
		RuleName:   "Shadow canary: openai/gpt-big -> openai/gpt-small",
		Ramp:       plan,
	})
	require.NoError(t, err)
	return ev
}

// anHourAgo is the start of a test's timeline: every guard pass happens at a
// later instant that is still in the past.
func anHourAgo() time.Time { return time.Now().Add(-time.Hour) }

func onlyCanary(t *testing.T, p *Plugin) Canary {
	t.Helper()
	r := p.Rollouts()
	require.Len(t, r.Canaries, 1)
	return r.Canaries[0]
}

func TestRampAdvancesStepByStepAndCompletes(t *testing.T) {
	p := newTestPlugin(t, guardConfig()) // canary.min_requests 10
	ramps := &rampRecorder{}
	p.SetRampHook(ramps.hook)
	p.SetRollbackHook((&rollbackRecorder{}).hook)

	start := anHourAgo()
	ev := promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5, 1}, HoldSeconds: intp(60)}, start)
	require.NotNil(t, ev.Ramp)
	assert.Equal(t, 0.1, ev.Weight, "the canary starts at steps[0]")
	assert.Equal(t, 0, ev.Ramp.CurrentStep)
	assert.Equal(t, 10, ev.Ramp.MinRequests, "defaults to canary.min_requests")
	assert.Equal(t, 0.5, ev.Ramp.NextWeight)
	assert.True(t, ev.Ramp.StepStartedAt.Equal(start))

	serveLive(t, p, primaryModel, 50, 0, 900)
	serveLive(t, p, candidateModel, 9, 0, 300)
	c := onlyCanary(t, p)
	require.NotNil(t, c.Ramp)
	assert.Equal(t, int64(9), c.Ramp.StepRequests)
	assert.Equal(t, "step 1 of 3 (10%): 9 of 10 candidate requests", c.Ramp.Reason)
	rolled, advanced := p.guardPass(start.Add(50 * time.Minute))
	assert.Zero(t, rolled)
	assert.Zero(t, advanced, "too few candidate requests, however long it waits")

	serveLive(t, p, candidateModel, 1, 0, 300)
	exp := p.config.Experiments[0]
	early := p.canaryView(p.rollouts.lookup(exp.Name, exp.Candidates[0].String()), nil, start.Add(30*time.Second))
	assert.Equal(t, "step 1 of 3 (10%): 30s left of a 60s hold", early.Ramp.Reason)
	_, advanced = p.guardPass(start.Add(30 * time.Second))
	assert.Zero(t, advanced, "the hold has not passed")

	step2 := start.Add(61 * time.Second)
	_, advanced = p.guardPass(step2)
	assert.Equal(t, 1, advanced)
	assert.Equal(t, []float64{0.5}, ramps.weights())
	r := p.Rollouts()
	c = r.Canaries[0]
	assert.Equal(t, 0.5, c.Weight)
	require.NotNil(t, c.Ramp)
	assert.Equal(t, 1, c.Ramp.CurrentStep)
	assert.Equal(t, 1.0, c.Ramp.NextWeight)
	assert.False(t, c.Ramp.Completed)
	assert.True(t, c.Ramp.StepStartedAt.Equal(step2))
	assert.Zero(t, c.Health.Candidate.Requests, "each step is judged on its own traffic")
	assert.Zero(t, c.Health.Source.Requests)
	assert.True(t, c.Since.Equal(start), "the canary keeps its start time")
	e := r.Events[0]
	assert.Equal(t, RolloutRamp, e.Action)
	assert.Equal(t, "canary_guard", e.Actor)
	assert.Equal(t, 0.5, e.Weight)
	assert.Equal(t, "rule-1", e.RuleID)
	require.NotNil(t, e.Health)
	assert.Equal(t, CanaryHealthy, e.Health.Status)
	assert.Equal(t, int64(10), e.Health.Candidate.Requests, "the health the step rested on")
	require.NotNil(t, e.Ramp)
	assert.Equal(t, 1, e.Ramp.CurrentStep)
	assert.Contains(t, e.Reason, "canary guard: step 1 of 3 (10%) served 10 candidate requests in 1m1s and is healthy")

	serveLive(t, p, candidateModel, 10, 0, 300)
	_, advanced = p.guardPass(step2.Add(59 * time.Second))
	assert.Zero(t, advanced, "every step holds on its own")
	_, advanced = p.guardPass(step2.Add(61 * time.Second))
	assert.Equal(t, 1, advanced)
	r = p.Rollouts()
	c = r.Canaries[0]
	assert.Equal(t, 1.0, c.Weight)
	assert.True(t, c.Ramp.Completed)
	assert.Zero(t, c.Ramp.NextWeight)
	assert.Equal(t, "complete: the canary reached the last step, 100%", c.Ramp.Reason)
	require.Len(t, r.Events, 3)
	assert.Equal(t, RolloutRampComplete, r.Events[0].Action, "the last step is recorded as ramp_complete")
	assert.Equal(t, 1.0, r.Events[0].Weight)
	data, err := json.Marshal(c.Ramp)
	require.NoError(t, err)
	assert.NotContains(t, string(data), "next_weight")

	// A complete ramp moves no further; the canary stays guarded.
	serveLive(t, p, candidateModel, 20, 0, 300)
	_, advanced = p.guardPass(step2.Add(24 * time.Hour))
	assert.Zero(t, advanced)
	assert.Equal(t, []float64{0.5, 1}, ramps.weights())
	serveLive(t, p, candidateModel, 20, 20, 300)
	rolled, _ = p.guardPass(step2.Add(25 * time.Hour))
	assert.Equal(t, 1, rolled, "a completed canary is still rolled back when it turns unhealthy")
}

func TestRampUnhealthyStepRollsBack(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	ramps := &rampRecorder{}
	rollbacks := &rollbackRecorder{}
	p.SetRampHook(ramps.hook)
	p.SetRollbackHook(rollbacks.hook)
	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5}, HoldSeconds: intp(0)}, anHourAgo())

	serveLive(t, p, candidateModel, 10, 8, 300)
	assert.Contains(t, onlyCanary(t, p).Ramp.Reason, "held at step 1 of 2 (10%): the canary is unhealthy and the guard rolls it back")
	rolled, advanced := p.guardPass(time.Now().Add(time.Minute))
	assert.Equal(t, 1, rolled)
	assert.Zero(t, advanced)
	assert.Empty(t, ramps.weights(), "an unhealthy step never advances")
	r := p.Rollouts()
	assert.Empty(t, r.Canaries)
	assert.Equal(t, RolloutAutoRollback, r.Events[0].Action)
	assert.Nil(t, r.Events[0].Ramp)
}

// Without auto_rollback the guard still ramps a healthy canary, and an
// unhealthy step holds the ramp where it is.
func TestRampHoldsWhenUnhealthyWithoutAutoRollback(t *testing.T) {
	cfg := baseConfig()
	cfg.Canary = &CanaryConfig{MinRequests: 10}
	p := newTestPlugin(t, cfg)
	ramps := &rampRecorder{}
	rollbacks := &rollbackRecorder{}
	p.SetRampHook(ramps.hook)
	p.SetRollbackHook(rollbacks.hook)
	start := anHourAgo()
	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5, 1}, HoldSeconds: intp(0)}, start)

	serveLive(t, p, candidateModel, 10, 0, 300)
	rolled, advanced := p.guardPass(start.Add(time.Minute))
	assert.Zero(t, rolled)
	assert.Equal(t, 1, advanced)

	serveLive(t, p, candidateModel, 10, 8, 300)
	rolled, advanced = p.guardPass(time.Now().Add(time.Hour))
	assert.Zero(t, rolled)
	assert.Zero(t, advanced)
	c := onlyCanary(t, p)
	assert.Equal(t, CanaryUnhealthy, c.Health.Status)
	assert.Equal(t, 0.5, c.Weight)
	assert.Equal(t, "held at step 2 of 3 (50%): the canary is unhealthy and canary.auto_rollback is off", c.Ramp.Reason)
	assert.Equal(t, []float64{0.5}, ramps.weights())
	assert.Empty(t, rollbacks.calls)
}

func TestOperatorPromotionReplacesOrCancelsTheRamp(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	ramps := &rampRecorder{}
	p.SetRampHook(ramps.hook)
	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.25, 0.5}, HoldSeconds: intp(0)}, anHourAgo())
	serveLive(t, p, candidateModel, 5, 0, 300)

	// A promotion without a ramp cancels it and keeps the live statistics.
	ev := promote(t, p, 0.2)
	assert.Nil(t, ev.Ramp)
	c := onlyCanary(t, p)
	assert.Nil(t, c.Ramp)
	assert.Equal(t, 0.2, c.Weight)
	assert.Equal(t, int64(5), c.Health.Candidate.Requests)
	serveLive(t, p, candidateModel, 10, 0, 300)
	_, advanced := p.guardPass(time.Now().Add(time.Hour))
	assert.Zero(t, advanced, "a cancelled ramp does not move")

	// A new ramp replaces it, and its first step starts on fresh statistics.
	ev = promoteRamp(t, p, RampRequest{Steps: []float64{0.3, 0.6}, HoldSeconds: intp(0)}, anHourAgo())
	assert.Equal(t, 0.3, ev.Weight)
	c = onlyCanary(t, p)
	require.NotNil(t, c.Ramp)
	assert.Equal(t, []float64{0.3, 0.6}, c.Ramp.Steps)
	assert.Equal(t, 0, c.Ramp.CurrentStep)
	assert.Zero(t, c.Health.Candidate.Requests)

	// A rollback ends the canary and its ramp.
	exp := p.config.Experiments[0]
	_, err := p.RecordRollout(RolloutEvent{Action: RolloutRollback, Experiment: exp.Name, Source: exp.Source, Candidate: exp.Candidates[0], Ramp: c.Ramp})
	require.NoError(t, err)
	assert.Empty(t, p.Rollouts().Canaries)
	assert.Nil(t, p.Rollouts().Events[0].Ramp, "a rollback carries no ramp")
	assert.Empty(t, ramps.weights())
}

// An operator who changes the canary between the guard's judgement and its
// ramp step wins, and concurrent guard passes move a step once.
func TestRampSkipsACanaryChangedMeanwhile(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5, 1}, HoldSeconds: intp(0)}, anHourAgo())
	ramps := &rampRecorder{before: func() { promote(t, p, 0.2) }}
	p.SetRampHook(ramps.hook)
	serveLive(t, p, candidateModel, 10, 0, 300)
	_, advanced := p.guardPass(time.Now())
	assert.Zero(t, advanced)
	assert.Empty(t, ramps.weights(), "the rule was not touched")
	c := onlyCanary(t, p)
	assert.Equal(t, 0.2, c.Weight)
	assert.Nil(t, c.Ramp, "the operator's promotion cancelled the ramp")
	for _, e := range p.Rollouts().Events {
		assert.NotEqual(t, RolloutRamp, e.Action)
	}

	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5, 1}, HoldSeconds: intp(0)}, anHourAgo())
	ramps.before = nil
	serveLive(t, p, candidateModel, 10, 0, 300)
	var total atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, n := p.guardPass(time.Now())
			total.Add(int64(n))
		}()
	}
	wg.Wait()
	assert.Equal(t, int64(1), total.Load(), "one step, however many passes judged it")
	assert.Equal(t, []float64{0.5}, ramps.weights())
}

func TestRampHoldsWhenTheHookFailsOrIsMissing(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5}, HoldSeconds: intp(0)}, anHourAgo())
	serveLive(t, p, candidateModel, 10, 0, 300)
	_, advanced := p.guardPass(time.Now())
	assert.Zero(t, advanced, "no ramp hook wired")

	// The gateway refuses the step (for example the shares no longer fit, or
	// the rule was disabled by hand): the ramp says why instead of "moving".
	ramps := &rampRecorder{err: errors.New("candidate shares exceed 100%: candidates would get 120.00% of openai/gpt-big traffic")}
	p.SetRampHook(ramps.hook)
	for i := 0; i < 3; i++ {
		_, advanced = p.guardPass(time.Now())
		assert.Zero(t, advanced)
	}
	c := onlyCanary(t, p)
	assert.Equal(t, 0.1, c.Weight)
	assert.Equal(t, "step 1 of 2 (10%) passed but cannot move to 50%: candidate shares exceed 100%: candidates would get 120.00% of openai/gpt-big traffic", c.Ramp.Reason)

	ramps.err = nil
	_, advanced = p.guardPass(time.Now())
	assert.Equal(t, 1, advanced, "the next pass tries again")
	c = onlyCanary(t, p)
	assert.Equal(t, 0.5, c.Weight)
	assert.Equal(t, "complete: the canary reached the last step, 50%", c.Ramp.Reason, "a new step forgets the old refusal")
}

func TestRampSurvivesRestart(t *testing.T) {
	resetLedgers()
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	cfg := guardConfig()
	cfg.PersistPath = path
	p, err := Init(context.Background(), cfg, testLogger)
	require.NoError(t, err)
	p.SetRampHook((&rampRecorder{}).hook)
	start := anHourAgo()
	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5, 1}, HoldSeconds: intp(0)}, start)
	serveLive(t, p, candidateModel, 10, 0, 300)
	moved := start.Add(time.Minute)
	_, advanced := p.guardPass(moved)
	require.Equal(t, 1, advanced)
	require.NoError(t, p.Cleanup())

	resetLedgers() // a new process: reloaded from <persist_path>.rollouts.json
	cfg2 := guardConfig()
	cfg2.PersistPath = path
	p2, err := Init(context.Background(), cfg2, testLogger)
	require.NoError(t, err)
	t.Cleanup(func() { _ = p2.Cleanup() })
	c := onlyCanary(t, p2)
	assert.Equal(t, 0.5, c.Weight)
	require.NotNil(t, c.Ramp)
	assert.Equal(t, 1, c.Ramp.CurrentStep, "the ramp resumes at its step")
	assert.True(t, c.Ramp.StepStartedAt.Equal(moved), "the step keeps its start")
	assert.Zero(t, c.Ramp.StepRequests, "live statistics restart with the process")
	assert.Equal(t, 1.0, c.Ramp.NextWeight)
	require.Len(t, p2.Rollouts().Events, 2)
	assert.Equal(t, RolloutRamp, p2.Rollouts().Events[0].Action)

	ramps := &rampRecorder{}
	p2.SetRampHook(ramps.hook)
	serveLive(t, p2, candidateModel, 10, 0, 300)
	_, advanced = p2.guardPass(time.Now())
	assert.Equal(t, 1, advanced)
	assert.True(t, onlyCanary(t, p2).Ramp.Completed)
}

func TestPlanRamp(t *testing.T) {
	p := newTestPlugin(t, baseConfig()) // no canary block: canary.min_requests is 20
	plan, weight, err := p.PlanRamp(RampRequest{Steps: []float64{0.1, 0.25, 0.5, 1}}, nil)
	require.NoError(t, err)
	assert.Equal(t, 0.1, weight, "weight left out: the ramp starts at steps[0]")
	assert.Equal(t, DefaultCanaryMinRequests, plan.MinRequests)
	assert.Equal(t, DefaultRampHoldSeconds, plan.HoldSeconds)
	assert.Equal(t, 0.25, plan.NextWeight)
	assert.False(t, plan.Completed)

	w := 0.10001
	plan, weight, err = p.PlanRamp(RampRequest{Steps: []float64{0.1, 0.33333}, MinRequests: intp(50), HoldSeconds: intp(0)}, &w)
	require.NoError(t, err, "weights are compared at the four decimals rules keep")
	assert.Equal(t, 0.1, weight)
	assert.Equal(t, []float64{0.1, 0.3333}, plan.Steps)
	assert.Equal(t, 50, plan.MinRequests)
	assert.Equal(t, 0, plan.HoldSeconds, "an explicit 0 is kept")

	two := 0.2
	bad := []struct {
		name   string
		req    RampRequest
		weight *float64
		want   string
	}{
		{"one step", RampRequest{Steps: []float64{0.1}}, nil, "ramp.steps needs 2 to 20 weights, got 1"},
		{"no steps", RampRequest{}, nil, "got 0"},
		{"too many", RampRequest{Steps: make([]float64, 21)}, nil, "got 21"},
		{"descending", RampRequest{Steps: []float64{0.5, 0.25}}, nil, "strictly ascending, but steps[1] (0.25) is not above steps[0] (0.5)"},
		{"repeated", RampRequest{Steps: []float64{0.1, 0.1}}, nil, "strictly ascending"},
		{"equal once rounded", RampRequest{Steps: []float64{0.10001, 0.10002}}, nil, "strictly ascending"},
		{"zero", RampRequest{Steps: []float64{0, 0.5}}, nil, "ramp.steps[0] must be a number from 0.0001 to 1, got 0"},
		{"above one", RampRequest{Steps: []float64{0.5, 1.5}}, nil, "ramp.steps[1] must be a number from 0.0001 to 1, got 1.5"},
		{"weight differs", RampRequest{Steps: []float64{0.1, 0.5}}, &two, "ramp.steps[0] (0.1) must equal weight (0.2)"},
		{"too few requests", RampRequest{Steps: []float64{0.1, 0.5}, MinRequests: intp(5)}, nil, "ramp.min_requests must be at least canary.min_requests (20)"},
		{"negative hold", RampRequest{Steps: []float64{0.1, 0.5}, HoldSeconds: intp(-1)}, nil, "ramp.hold_seconds must be from 0 to 604800"},
		{"hold too long", RampRequest{Steps: []float64{0.1, 0.5}, HoldSeconds: intp(MaxRampHoldSeconds + 1)}, nil, "got 604801"},
	}
	for _, c := range bad {
		_, _, err := p.PlanRamp(c.req, c.weight)
		require.Error(t, err, c.name)
		assert.ErrorIs(t, err, ErrInvalidRamp, c.name)
		assert.Contains(t, err.Error(), c.want, c.name)
	}
}

func TestRecordRolloutChecksRampEvents(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	exp := p.config.Experiments[0]
	base := RolloutEvent{Experiment: exp.Name, Source: exp.Source, Candidate: exp.Candidates[0]}
	steps := []float64{0.1, 0.5, 1}

	ev := base
	ev.Action, ev.Weight = RolloutRamp, 0.5
	_, err := p.RecordRollout(ev)
	assert.ErrorContains(t, err, "needs the ramp")

	ev.Ramp = &CanaryRamp{Steps: steps, CurrentStep: 1}
	ev.Weight = 0.4
	_, err = p.RecordRollout(ev)
	assert.ErrorContains(t, err, "weight 0.4 is not the ramp's step 1 (0.5)")

	ev.Weight, ev.Ramp = 1, &CanaryRamp{Steps: steps, CurrentStep: 2}
	_, err = p.RecordRollout(ev)
	assert.ErrorContains(t, err, "recorded as ramp_complete")

	ev.Action, ev.Weight, ev.Ramp = RolloutRampComplete, 0.5, &CanaryRamp{Steps: steps, CurrentStep: 1}
	_, err = p.RecordRollout(ev)
	assert.ErrorContains(t, err, "needs the ramp's last step")

	ev = base
	ev.Action, ev.Weight, ev.Ramp = RolloutPromote, 0.5, &CanaryRamp{Steps: steps, CurrentStep: 1}
	_, err = p.RecordRollout(ev)
	assert.ErrorContains(t, err, "not the ramp's step 0", "a promotion starts its ramp at step 0")

	ev.Ramp = &CanaryRamp{Steps: []float64{0.5}}
	_, err = p.RecordRollout(ev)
	assert.ErrorContains(t, err, "out of range")
	assert.Empty(t, p.Rollouts().Events, "nothing invalid is logged")
}

// Without a ramp the canary, the event and the rollouts payload look exactly
// as they did before ramps existed.
func TestNoRampKeepsTheJSONUnchanged(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	promote(t, p, 0.1)
	serveLive(t, p, candidateModel, 3, 0, 300)
	data, err := json.Marshal(p.Rollouts())
	require.NoError(t, err)
	assert.NotContains(t, string(data), `"ramp"`)
	_, advanced := p.guardPass(time.Now().Add(time.Hour))
	assert.Zero(t, advanced)
}

// Live traffic, readers and guard passes running at once while a ramp moves
// through ten steps; run with -race.
func TestRampUnderConcurrentTraffic(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	ramps := &rampRecorder{}
	p.SetRampHook(ramps.hook)
	steps := []float64{0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1}
	start := anHourAgo()
	promoteRamp(t, p, RampRequest{Steps: steps, HoldSeconds: intp(0)}, start)

	var traffic sync.WaitGroup
	for g := 0; g < 4; g++ {
		traffic.Add(1)
		go func() {
			defer traffic.Done()
			for i := 0; i < 100; i++ {
				// Not serveLive: require must not fail a test from another goroutine.
				_, _, _ = p.PostLLMHook(requestCtx(""), liveResponse(primaryModel, candidateModel, 300), nil)
				_, _, _ = p.PostLLMHook(requestCtx(""), liveResponse(primaryModel, primaryModel, 900), nil)
			}
		}()
	}
	stop := make(chan struct{})
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		for {
			select {
			case <-stop:
				return
			default:
				_ = p.Rollouts()
				_ = p.Summary()
			}
		}
	}()
	go func() {
		defer readers.Done()
		for i := 1; ; i++ {
			select {
			case <-stop:
				return
			default:
				p.guardPass(start.Add(time.Duration(i) * time.Millisecond))
			}
		}
	}()
	traffic.Wait()
	close(stop)
	readers.Wait()

	// Whatever the interleaving, the steps were taken in order, once each.
	got := ramps.weights()
	require.NotEmpty(t, got)
	for i, w := range got {
		assert.Equal(t, steps[i+1], w)
	}
	c := onlyCanary(t, p)
	assert.Equal(t, got[len(got)-1], c.Weight)
	assert.Equal(t, len(got), c.Ramp.CurrentStep)
}

// A response that started before the current step was routed at the previous
// weight: it does not count toward the new step. Failures carry no latency
// and are counted.
func TestRampIgnoresResponsesFromBeforeTheStep(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	promoteRamp(t, p, RampRequest{Steps: []float64{0.1, 0.5}, HoldSeconds: intp(0)}, time.Now())
	serveLive(t, p, candidateModel, 3, 0, 5000) // started 5 s before the step
	serveLive(t, p, primaryModel, 3, 0, 5000)
	h := onlyCanary(t, p).Health
	assert.Zero(t, h.Candidate.Requests)
	assert.Zero(t, h.Source.Requests)

	serveLive(t, p, candidateModel, 2, 1, 0) // undated: one failure, one response without latency
	h = onlyCanary(t, p).Health
	assert.Equal(t, int64(2), h.Candidate.Requests)
	assert.Equal(t, int64(1), h.Candidate.Errors)

	// A canary without a ramp counts everything, as before.
	promote(t, p, 0.1)
	serveLive(t, p, candidateModel, 3, 0, 5000)
	assert.Equal(t, int64(5), onlyCanary(t, p).Health.Candidate.Requests)
}

// unsavable points the rollout book at a directory that does not exist.
func unsavable(t *testing.T, p *Plugin) {
	p.rollouts.mu.Lock()
	p.rollouts.path = filepath.Join(t.TempDir(), "gone", "shadow.jsonl.rollouts.json")
	p.rollouts.mu.Unlock()
}

// A rollout log that cannot be written does not undo or misreport a change
// that already happened: the event is applied, and the guard counts the step
// or rollback as done instead of retrying it.
func TestRolloutSaveFailureStillApplies(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	ramps := &rampRecorder{}
	rollbacks := &rollbackRecorder{}
	p.SetRampHook(ramps.hook)
	p.SetRollbackHook(rollbacks.hook)
	unsavable(t, p)

	plan, weight, err := p.PlanRamp(RampRequest{Steps: []float64{0.1, 0.5, 1}, HoldSeconds: intp(0)}, nil)
	require.NoError(t, err)
	exp := p.config.Experiments[0]
	ev, err := p.RecordRollout(RolloutEvent{At: anHourAgo(), Action: RolloutPromote, Experiment: exp.Name, Source: exp.Source, Candidate: exp.Candidates[0], Weight: weight, Ramp: plan})
	assert.ErrorIs(t, err, ErrRolloutNotSaved)
	assert.NotEmpty(t, ev.ID)
	require.Len(t, p.Rollouts().Canaries, 1, "applied in memory")

	serveLive(t, p, candidateModel, 10, 0, 300)
	_, advanced := p.guardPass(time.Now().Add(-time.Minute))
	assert.Equal(t, 1, advanced, "the step happened, so it is not reported as held")
	_, advanced = p.guardPass(time.Now().Add(-time.Minute))
	assert.Zero(t, advanced, "and it is not taken twice")
	assert.Equal(t, []float64{0.5}, ramps.weights())
	assert.Equal(t, 0.5, onlyCanary(t, p).Weight)

	serveLive(t, p, candidateModel, 10, 10, 300)
	rolled, _ := p.guardPass(time.Now())
	assert.Equal(t, 1, rolled)
	assert.Empty(t, p.Rollouts().Canaries)
	assert.Len(t, rollbacks.calls, 1)
}

// BenchmarkPostLLMHookRampingCanary: a response a ramping canary counts (one
// clock read more than a plain canary, to date it against the step).
func BenchmarkPostLLMHookRampingCanary(b *testing.B) {
	resetLedgers()
	p, err := Init(context.Background(), guardConfig(), testLogger)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = p.Cleanup() })
	plan, weight, err := p.PlanRamp(RampRequest{Steps: []float64{0.1, 0.5}}, nil)
	if err != nil {
		b.Fatal(err)
	}
	exp := p.config.Experiments[0]
	if _, err := p.RecordRollout(RolloutEvent{At: time.Now().Add(-time.Hour), Action: RolloutPromote, Experiment: exp.Name, Source: exp.Source, Candidate: exp.Candidates[0], Weight: weight, Ramp: plan}); err != nil {
		b.Fatal(err)
	}
	ctx := requestCtx("")
	resp := liveResponse(primaryModel, candidateModel, 100)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = p.PostLLMHook(ctx, resp, nil)
	}
}
