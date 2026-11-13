package shadow

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// liveResponse is a response to a request for requested, served by served.
func liveResponse(requested, served string, latency int64) *schemas.BifrostResponse {
	resp := chatResponse("openai", served, "ok", 10, 5, latency)
	resp.ChatResponse.ExtraFields.RoutingInfo.RequestedProvider = "openai"
	resp.ChatResponse.ExtraFields.RoutingInfo.RequestedModel = requested
	return resp
}

func liveError(requested, served string) *schemas.BifrostError {
	status := 503
	return &schemas.BifrostError{StatusCode: &status, Error: &schemas.ErrorField{Message: "overloaded"}, ExtraFields: schemas.BifrostErrorExtraFields{
		RoutingInfo: schemas.RoutingInfo{Provider: "openai", Model: served, RequestedProvider: "openai", RequestedModel: requested},
	}}
}

// serveLive feeds live canary traffic through PostLLMHook.
func serveLive(t *testing.T, p *Plugin, served string, n, failures int, latency int64) {
	t.Helper()
	for i := 0; i < n; i++ {
		ctx := requestCtx("")
		var err error
		if i < failures {
			_, _, err = p.PostLLMHook(ctx, nil, liveError(primaryModel, served))
		} else {
			_, _, err = p.PostLLMHook(ctx, liveResponse(primaryModel, served, latency), nil)
		}
		require.NoError(t, err)
	}
}

func promote(t *testing.T, p *Plugin, weight float64) RolloutEvent {
	t.Helper()
	exp := p.config.Experiments[0]
	ev, err := p.RecordRollout(RolloutEvent{
		Action:     RolloutPromote,
		Experiment: exp.Name,
		Source:     exp.Source,
		Candidate:  exp.Candidates[0],
		Weight:     weight,
		RuleID:     "rule-1",
		RuleName:   "Shadow canary: openai/gpt-big -> openai/gpt-small",
	})
	require.NoError(t, err)
	return ev
}

type rollbackRecorder struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (r *rollbackRecorder) hook(_ context.Context, experiment, candidate, reason string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, experiment+"|"+candidate+"|"+reason)
	return r.err
}

func guardConfig() *Config {
	cfg := baseConfig()
	cfg.Canary = &CanaryConfig{AutoRollback: true, MinRequests: 10}
	return cfg
}

func TestCanaryGuardRollsBackOnLiveErrors(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	rec := &rollbackRecorder{}
	p.SetRollbackHook(rec.hook)
	promote(t, p, 0.1)

	serveLive(t, p, primaryModel, 90, 0, 900)
	serveLive(t, p, candidateModel, 9, 4, 300)
	assert.Equal(t, 1, p.Summary().ActiveCanaries)
	assert.True(t, p.Summary().AutoRollback)
	view := p.Rollouts().Canaries[0]
	assert.Equal(t, CanaryWatching, view.Health.Status, "9 of 10 candidate requests")
	assert.Zero(t, p.checkCanaries())

	serveLive(t, p, candidateModel, 1, 0, 300)
	view = p.Rollouts().Canaries[0]
	assert.Equal(t, int64(10), view.Health.Candidate.Requests)
	assert.InDelta(t, 0.4, view.Health.Candidate.ErrorRate, 1e-9)
	assert.Equal(t, int64(90), view.Health.Source.Requests)
	assert.Equal(t, CanaryUnhealthy, view.Health.Status)

	assert.Equal(t, 1, p.checkCanaries())
	require.Len(t, rec.calls, 1)
	assert.Contains(t, rec.calls[0], "big-to-small|openai/gpt-small|canary guard: live error rate 40.0% (95% lower bound 16.8%) exceeds 5.0%")

	r := p.Rollouts()
	assert.Empty(t, r.Canaries, "a rolled-back canary is no longer watched")
	assert.Zero(t, p.Summary().ActiveCanaries)
	require.Len(t, r.Events, 2)
	assert.Equal(t, RolloutAutoRollback, r.Events[0].Action, "newest first")
	assert.Equal(t, "canary_guard", r.Events[0].Actor)
	require.NotNil(t, r.Events[0].Health)
	assert.Equal(t, int64(4), r.Events[0].Health.Candidate.Errors)
	assert.Zero(t, p.checkCanaries(), "nothing left to roll back")
}

// An outage the source shares is not the candidate's fault.
func TestCanaryGuardToleratesSharedOutage(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	rec := &rollbackRecorder{}
	p.SetRollbackHook(rec.hook)
	promote(t, p, 0.5)
	serveLive(t, p, primaryModel, 20, 6, 900)   // 30% source errors
	serveLive(t, p, candidateModel, 20, 5, 300) // 25% candidate errors
	assert.Equal(t, CanaryHealthy, p.Rollouts().Canaries[0].Health.Status)
	assert.Zero(t, p.checkCanaries())
	assert.Empty(t, rec.calls)
}

// One failure in a handful of requests is not evidence of an unhealthy candidate.
func TestCanaryGuardIgnoresASingleUnluckyFailure(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	rec := &rollbackRecorder{}
	p.SetRollbackHook(rec.hook)
	promote(t, p, 0.1)
	serveLive(t, p, candidateModel, 17, 1, 300) // 5.9% raw, lower bound 1.0%
	h := p.Rollouts().Canaries[0].Health
	assert.Equal(t, CanaryHealthy, h.Status, h.Reason)
	assert.Zero(t, p.checkCanaries())
	assert.Empty(t, rec.calls)
}

func TestCanaryGuardLatencyLimit(t *testing.T) {
	cfg := guardConfig()
	cfg.Canary.MaxLatencyRatio = 2
	p := newTestPlugin(t, cfg)
	promote(t, p, 0.5)
	serveLive(t, p, primaryModel, 20, 0, 100)
	serveLive(t, p, candidateModel, 20, 0, 250)
	h := p.Rollouts().Canaries[0].Health
	assert.Equal(t, CanaryUnhealthy, h.Status)
	assert.Contains(t, h.Reason, "p95 latency 250 ms is over 2.0x")
}

func TestCanaryGuardRollsBackWhenVerdictTurnsNotReady(t *testing.T) {
	cfg := guardConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	p := newTestPlugin(t, cfg)
	rec := &rollbackRecorder{}
	p.SetRollbackHook(rec.hook)
	promote(t, p, 0.1)
	p.SetExecutors((&fakeClient{candidateText: "wrong", judgeReply: `{"score_a": 9, "score_b": 2, "winner": "A"}`}).chat, nil, nil)
	p.randFloat = func() float64 { return 0.9 } // sample every request; primary shown first
	runPrimary(t, p, "regress-1", "q", "right")
	waitForRecords(t, p, 1)

	h := p.Rollouts().Canaries[0].Health
	assert.Equal(t, VerdictNotReady, h.Verdict)
	assert.Equal(t, CanaryUnhealthy, h.Status)
	assert.Equal(t, 1, p.checkCanaries())
	require.Len(t, rec.calls, 1)
	assert.Contains(t, rec.calls[0], "not_ready")
}

// A canary promoted over a not_ready verdict is guarded on live health only.
func TestCanaryGuardRespectsAnOverride(t *testing.T) {
	cfg := guardConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	p := newTestPlugin(t, cfg)
	rec := &rollbackRecorder{}
	p.SetRollbackHook(rec.hook)
	p.SetExecutors((&fakeClient{candidateText: "wrong", judgeReply: `{"score_a": 9, "score_b": 2, "winner": "A"}`}).chat, nil, nil)
	p.randFloat = func() float64 { return 0.9 }
	runPrimary(t, p, "override-1", "q", "right")
	waitForRecords(t, p, 1)

	exp := p.config.Experiments[0]
	_, err := p.RecordRollout(RolloutEvent{Action: RolloutPromote, Experiment: exp.Name, Source: exp.Source, Candidate: exp.Candidates[0], Weight: 0.05, Override: true, Reason: "load test"})
	require.NoError(t, err)
	c := p.Rollouts().Canaries[0]
	assert.True(t, c.Override)
	assert.Equal(t, VerdictNotReady, c.Health.Verdict)
	assert.Equal(t, CanaryWatching, c.Health.Status)
	assert.Zero(t, p.checkCanaries())

	serveLive(t, p, candidateModel, 20, 10, 300)
	assert.Equal(t, 1, p.checkCanaries(), "live errors still roll it back")
	require.Len(t, rec.calls, 1)
	assert.Contains(t, rec.calls[0], "live error rate 50.0%")
}

func TestCanaryGuardOffOnlyReports(t *testing.T) {
	p := newTestPlugin(t, baseConfig()) // no canary block: watch, never act
	rec := &rollbackRecorder{}
	p.SetRollbackHook(rec.hook)
	promote(t, p, 0.1)
	serveLive(t, p, candidateModel, 30, 30, 300)
	assert.Equal(t, CanaryUnhealthy, p.Rollouts().Canaries[0].Health.Status)
	assert.False(t, p.Rollouts().AutoRollback)
	assert.Zero(t, p.checkCanaries())
	assert.Empty(t, rec.calls)
}

func TestCanaryRampKeepsStatsAndRollbackStopsWatching(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	promote(t, p, 0.1)
	serveLive(t, p, candidateModel, 5, 0, 300)
	promote(t, p, 0.5)
	c := p.Rollouts().Canaries[0]
	assert.Equal(t, 0.5, c.Weight)
	assert.Equal(t, int64(5), c.Health.Candidate.Requests, "a ramp keeps live statistics")

	exp := p.config.Experiments[0]
	_, err := p.RecordRollout(RolloutEvent{Action: RolloutRollback, Experiment: exp.Name, Source: exp.Source, Candidate: exp.Candidates[0], Reason: "manual"})
	require.NoError(t, err)
	assert.Empty(t, p.Rollouts().Canaries)
	serveLive(t, p, candidateModel, 5, 0, 300) // no canary: nothing to count, no panic

	_, err = p.RecordRollout(RolloutEvent{Action: "explode"})
	assert.Error(t, err)
}

func TestCanaryCountsStreamsOnceAndIgnoresOtherModels(t *testing.T) {
	p := newTestPlugin(t, guardConfig())
	promote(t, p, 0.5)
	for i := 0; i < 3; i++ {
		ctx := requestCtx("")
		resp := liveResponse(primaryModel, candidateModel, 100)
		resp.ChatResponse.ExtraFields.RequestType = schemas.ChatCompletionStreamRequest
		if i == 2 {
			ctx.SetValue(schemas.BifrostContextKeyStreamEndIndicator, true)
		}
		_, _, err := p.PostLLMHook(ctx, resp, nil)
		require.NoError(t, err)
	}
	// A request for another model, and a fallback served by a third model.
	_, _, _ = p.PostLLMHook(requestCtx(""), liveResponse("unrelated", candidateModel, 1), nil)
	_, _, _ = p.PostLLMHook(requestCtx(""), liveResponse(primaryModel, "fallback-model", 1), nil)
	h := p.Rollouts().Canaries[0].Health
	assert.Equal(t, int64(1), h.Candidate.Requests)
	assert.Zero(t, h.Source.Requests)
}

func TestCanariesSurvivePluginReload(t *testing.T) {
	resetLedgers()
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	cfg := guardConfig()
	cfg.PersistPath = path
	p, err := Init(context.Background(), cfg, testLogger)
	require.NoError(t, err)
	promote(t, p, 0.1)
	require.NoError(t, p.Cleanup())

	cfg2 := guardConfig()
	cfg2.PersistPath = path
	p2, err := Init(context.Background(), cfg2, testLogger)
	require.NoError(t, err)
	require.Len(t, p2.Rollouts().Canaries, 1, "same process: the canary stays watched")
	require.NoError(t, p2.Cleanup())

	resetLedgers() // new process: reloaded from <persist_path>.rollouts.json
	cfg3 := guardConfig()
	cfg3.PersistPath = path
	p3, err := Init(context.Background(), cfg3, testLogger)
	require.NoError(t, err)
	t.Cleanup(func() { _ = p3.Cleanup() })
	r := p3.Rollouts()
	require.Len(t, r.Canaries, 1)
	assert.Equal(t, "rule-1", r.Canaries[0].RuleID)
	require.Len(t, r.Events, 1)
	assert.Equal(t, RolloutPromote, r.Events[0].Action)
}

func TestPairScorecard(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	s, err := p.PairScorecard("big-to-small", "openai/gpt-small")
	require.NoError(t, err)
	assert.Equal(t, VerdictCollecting, s.Verdict, "a configured pair with no records")
	_, err = p.PairScorecard("big-to-small", "openai/nope")
	assert.ErrorIs(t, err, ErrUnknownPair)

	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
	runPrimary(t, p, "sc-1", "hi", "x")
	waitForRecords(t, p, 1)
	s, err = p.PairScorecard("big-to-small", "openai/gpt-small")
	require.NoError(t, err)
	assert.Equal(t, 1, s.Samples)
	assert.Equal(t, VerdictPromising, s.Verdict, "1 of 1 passes: the lower bound is only 21%")
}
