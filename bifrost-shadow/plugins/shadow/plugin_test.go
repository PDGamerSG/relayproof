package shadow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var testLogger = bifrost.NewDefaultLogger(schemas.LogLevelError)

const (
	primaryModel   = "gpt-big"
	candidateModel = "gpt-small"
	judgeModel     = "gpt-judge"
)

func ptr[T any](v T) *T { return &v }

func baseConfig() *Config {
	return &Config{
		SampleRate: 1,
		Experiments: []Experiment{{
			Name:       "big-to-small",
			Source:     ModelRef{Provider: "openai", Model: primaryModel},
			Candidates: []ModelRef{{Provider: "openai", Model: candidateModel}},
		}},
		Pricing: map[string]ModelPrice{
			"openai/" + primaryModel:   {InputPerMillion: 10, OutputPerMillion: 30},
			"openai/" + candidateModel: {InputPerMillion: 1, OutputPerMillion: 3},
			"openai/" + judgeModel:     {InputPerMillion: 5, OutputPerMillion: 15},
		},
		Thresholds: Thresholds{MinSamples: 1},
	}
}

func newTestPlugin(t *testing.T, cfg *Config) *Plugin {
	t.Helper()
	// Ledgers are process-wide so they survive plugin reloads; tests start clean.
	resetLedgers()
	p, err := Init(context.Background(), cfg, testLogger)
	require.NoError(t, err)
	t.Cleanup(func() { _ = p.Cleanup() })
	return p
}

func requestCtx(id string) *schemas.BifrostContext {
	ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeyRequestID, id)
	return ctx
}

func chatRequest(stream bool, provider schemas.ModelProvider, model, prompt string) *schemas.BifrostRequest {
	rt := schemas.ChatCompletionRequest
	if stream {
		rt = schemas.ChatCompletionStreamRequest
	}
	sys := "You are helpful."
	return &schemas.BifrostRequest{
		RequestType: rt,
		ChatRequest: &schemas.BifrostChatRequest{
			Provider: provider,
			Model:    model,
			Input: []schemas.ChatMessage{
				{Role: schemas.ChatMessageRoleSystem, Content: &schemas.ChatMessageContent{ContentStr: &sys}},
				{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &prompt}},
			},
			Params: &schemas.ChatParameters{
				Temperature:   ptr(0.2),
				StreamOptions: &schemas.ChatStreamOptions{},
			},
			Fallbacks: []schemas.Fallback{{Provider: "anthropic", Model: "claude"}},
		},
	}
}

func chatResponse(provider schemas.ModelProvider, model, text string, in, out int, latency int64) *schemas.BifrostResponse {
	finish := "stop"
	return &schemas.BifrostResponse{ChatResponse: &schemas.BifrostChatResponse{
		Model: model,
		Choices: []schemas.BifrostResponseChoice{{
			FinishReason: &finish,
			ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{Message: &schemas.ChatMessage{
				Role:    schemas.ChatMessageRoleAssistant,
				Content: &schemas.ChatMessageContent{ContentStr: &text},
			}},
		}},
		Usage: &schemas.BifrostLLMUsage{PromptTokens: in, CompletionTokens: out, TotalTokens: in + out},
		ExtraFields: schemas.BifrostResponseExtraFields{
			RequestType: schemas.ChatCompletionRequest,
			Provider:    provider,
			Latency:     latency,
			RoutingInfo: schemas.RoutingInfo{Provider: provider, Model: model},
		},
	}}
}

// fakeClient stands in for the Bifrost client. It answers candidate calls with
// candidateText and judge calls with judgeReply, and records what it was sent.
type fakeClient struct {
	mu            sync.Mutex
	calls         []*schemas.BifrostChatRequest
	skipPipeline  []bool
	candidateText string
	judgeReply    string
	candidateErr  *schemas.BifrostError
	block         chan struct{}
}

func (f *fakeClient) chat(ctx *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
	if f.block != nil {
		<-f.block
	}
	skip, _ := ctx.Value(schemas.BifrostContextKeySkipPluginPipeline).(bool)
	f.mu.Lock()
	f.calls = append(f.calls, req)
	f.skipPipeline = append(f.skipPipeline, skip)
	f.mu.Unlock()
	if req.Model == judgeModel {
		return chatResponse(req.Provider, req.Model, f.judgeReply, 400, 40, 300).ChatResponse, nil
	}
	if f.candidateErr != nil {
		return nil, f.candidateErr
	}
	return chatResponse(req.Provider, req.Model, f.candidateText, 100, 50, 120).ChatResponse, nil
}

func (f *fakeClient) callsTo(model string) []*schemas.BifrostChatRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*schemas.BifrostChatRequest
	for _, c := range f.calls {
		if c.Model == model {
			out = append(out, c)
		}
	}
	return out
}

func waitForRecords(t *testing.T, p *Plugin, n int) []*Record {
	t.Helper()
	require.Eventually(t, func() bool { return p.store.len() >= n }, 5*time.Second, 5*time.Millisecond)
	recs, _ := p.Records(RecordFilter{Limit: 500})
	return recs
}

// runPrimary drives a non-streaming request through the plugin hooks.
func runPrimary(t *testing.T, p *Plugin, id, prompt, answer string) {
	t.Helper()
	ctx := requestCtx(id)
	req := chatRequest(false, "openai", primaryModel, prompt)
	_, sc, err := p.PreLLMHook(ctx, req)
	require.NoError(t, err)
	require.Nil(t, sc, "shadow must never short-circuit")
	resp := chatResponse("openai", primaryModel, answer, 100, 50, 900)
	out, bErr, err := p.PostLLMHook(ctx, resp, nil)
	require.NoError(t, err)
	require.Nil(t, bErr)
	require.Same(t, resp, out, "the caller's response must be returned untouched")
}

func TestConfigNormalize(t *testing.T) {
	cfg := &Config{Experiments: []Experiment{{Source: ModelRef{Model: "gpt-4o"}, Candidates: []ModelRef{{Provider: "openai", Model: "gpt-4o-mini"}}}}}
	require.NoError(t, cfg.normalize())
	assert.Equal(t, DefaultSampleRate, cfg.SampleRate)
	assert.Equal(t, DefaultMaxConcurrency, cfg.MaxConcurrency)
	assert.Equal(t, "gpt-4o vs openai/gpt-4o-mini", cfg.Experiments[0].Name)
	assert.True(t, cfg.storePayloads())

	bad := []*Config{
		nil,
		{},
		{SampleRate: 2, Experiments: cfg.Experiments},
		{Experiments: []Experiment{{Source: ModelRef{Model: "x"}}}},
		{Experiments: []Experiment{{Source: ModelRef{Model: "x"}, Candidates: []ModelRef{{Model: "y"}}}}},
		{Experiments: []Experiment{{Source: ModelRef{Model: "x"}, Candidates: []ModelRef{{Provider: "p", Model: "y"}}, SampleRate: ptr(0.0)}}},
		{Experiments: cfg.Experiments, Judge: &JudgeConfig{Model: "j"}},
		{Experiments: cfg.Experiments, DailyBudgetUSD: -1},
		{Experiments: cfg.Experiments, Pricing: map[string]ModelPrice{"m": {InputPerMillion: -1}}},
		{Experiments: []Experiment{
			{Name: "dup", Source: ModelRef{Model: "a"}, Candidates: []ModelRef{{Provider: "p", Model: "b"}}},
			{Name: "dup", Source: ModelRef{Model: "c"}, Candidates: []ModelRef{{Provider: "p", Model: "d"}}},
		}},
	}
	for i, c := range bad {
		assert.Error(t, c.normalize(), "case %d should be rejected", i)
	}
}

func TestShadowMirrorsAndScoresNonStreamingRequest(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	fc := &fakeClient{candidateText: "The capital of France is Paris."}
	p.SetExecutors(fc.chat, nil, nil)

	runPrimary(t, p, "req-1", "What is the capital of France?", "The capital of France is Paris.")
	recs := waitForRecords(t, p, 1)
	r := recs[0]

	assert.Equal(t, "req-1", r.RequestID)
	assert.Equal(t, "big-to-small", r.Experiment)
	assert.Equal(t, ModelRef{Provider: "openai", Model: primaryModel}, r.Primary)
	assert.Equal(t, ModelRef{Provider: "openai", Model: candidateModel}, r.Candidate)
	assert.Empty(t, r.CandidateError)
	assert.True(t, r.Pass)
	assert.Equal(t, BasisExact, r.PassBasis)
	assert.Equal(t, int64(900), r.PrimaryLatencyMs)
	assert.Equal(t, int64(120), r.CandidateLatencyMs)
	// 100 in * $10/M + 50 out * $30/M; candidate 100 * $1/M + 50 * $3/M.
	assert.InDelta(t, 0.0025, r.PrimaryCostUSD, 1e-12)
	assert.InDelta(t, 0.00025, r.CandidateCostUSD, 1e-12)
	assert.Equal(t, "What is the capital of France?", r.Prompt)
	require.NotNil(t, r.PrimaryAnswer)
	require.NotNil(t, r.CandidateAnswer)

	calls := fc.callsTo(candidateModel)
	require.Len(t, calls, 1)
	sent := calls[0]
	assert.Equal(t, schemas.ModelProvider("openai"), sent.Provider)
	assert.Len(t, sent.Input, 2, "the full conversation is replayed")
	assert.Empty(t, sent.Fallbacks, "the candidate is called directly, without fallbacks")
	require.NotNil(t, sent.Params)
	assert.Nil(t, sent.Params.StreamOptions, "stream options are stripped for the unary shadow call")
	assert.InDelta(t, 0.2, *sent.Params.Temperature, 1e-9, "sampling parameters are preserved")
	assert.True(t, fc.skipPipeline[0], "shadow calls must skip the plugin pipeline")
	assert.Equal(t, int64(0), p.active.Load(), "capture state is released")

	sum := p.Summary()
	require.Len(t, sum.Pairs, 1)
	pair := sum.Pairs[0]
	assert.Equal(t, 1, pair.Samples)
	assert.InDelta(t, 90, pair.SavingsPct, 1e-9)
	assert.InDelta(t, 2250, pair.SavingsPerMillionUSD, 1e-6)
	assert.Equal(t, int64(1), sum.Counters.Sampled)
	assert.Equal(t, int64(1), sum.Counters.Completed)
}

func TestShadowUsesJudgeWhenConfigured(t *testing.T) {
	cfg := baseConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	p := newTestPlugin(t, cfg)
	// The candidate answer shares no words with the primary, so only the judge can pass it.
	fc := &fakeClient{candidateText: "Paris.", judgeReply: `{"score_a": 9, "score_b": 9, "winner": "tie", "reason": "both correct"}`}
	p.SetExecutors(fc.chat, nil, nil)

	runPrimary(t, p, "req-j", "Capital of France?", "It is the city of Paris, France.")
	r := waitForRecords(t, p, 1)[0]
	require.NotNil(t, r.Judge, r.JudgeError)
	assert.Equal(t, "judge", r.PassBasis)
	assert.True(t, r.Pass)
	assert.Equal(t, "tie", r.Judge.Winner)
	// Judge cost: 400 * $5/M + 40 * $15/M.
	assert.InDelta(t, 0.0026, r.EvalCostUSD, 1e-12)
	require.Len(t, fc.callsTo(judgeModel), 1)
	judgeCall := fc.callsTo(judgeModel)[0]
	assert.Contains(t, *judgeCall.Input[1].Content.ContentStr, "Capital of France?")
}

func TestShadowJudgeFailingCandidate(t *testing.T) {
	cfg := baseConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	p := newTestPlugin(t, cfg)
	p.randFloat = func() float64 { return 0.9 } // primary shown first (0.9 >= 0.5)
	fc := &fakeClient{candidateText: "London.", judgeReply: `{"score_a": 9, "score_b": 2, "winner": "A", "reason": "B is wrong"}`}
	p.SetExecutors(fc.chat, nil, nil)
	runPrimary(t, p, "req-jf", "Capital of France?", "Paris.")
	r := waitForRecords(t, p, 1)[0]
	require.NotNil(t, r.Judge)
	assert.False(t, r.Pass)
	assert.Equal(t, "primary", r.Judge.Winner)
	assert.Equal(t, 2.0, r.Judge.CandidateScore)
}

func TestShadowEmbeddingSimilarity(t *testing.T) {
	cfg := baseConfig()
	cfg.Embedding = &EmbeddingConfig{Provider: "openai", Model: "embed"}
	p := newTestPlugin(t, cfg)
	fc := &fakeClient{candidateText: "totally different words"}
	embed := func(ctx *schemas.BifrostContext, req *schemas.BifrostEmbeddingRequest) (*schemas.BifrostEmbeddingResponse, *schemas.BifrostError) {
		if len(req.Input) != 2 {
			return nil, &schemas.BifrostError{Error: &schemas.ErrorField{Message: "want 2 inputs"}}
		}
		return &schemas.BifrostEmbeddingResponse{Data: []schemas.EmbeddingData{
			{Index: 0, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0.1}}},
			{Index: 1, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0.12}}},
		}}, nil
	}
	p.SetExecutors(fc.chat, embed, nil)
	runPrimary(t, p, "req-e", "q", "some answer here")
	r := waitForRecords(t, p, 1)[0]
	require.NotNil(t, r.Comparison.SemanticSimilarity)
	assert.Greater(t, *r.Comparison.SemanticSimilarity, 0.99)
	assert.Equal(t, "semantic", r.PassBasis)
	assert.True(t, r.Pass, "semantic similarity overrides low lexical overlap")
}

func TestShadowStreamingAccumulatesChunks(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	fc := &fakeClient{candidateText: "Hello world from the stream"}
	p.SetExecutors(fc.chat, nil, nil)

	ctx := requestCtx("req-stream")
	_, _, err := p.PreLLMHook(ctx, chatRequest(true, "openai", primaryModel, "say hello"))
	require.NoError(t, err)

	deltas := []string{"Hello ", "world ", "from the ", "stream"}
	for i, d := range deltas {
		content := d
		chunk := &schemas.BifrostResponse{ChatResponse: &schemas.BifrostChatResponse{
			Choices: []schemas.BifrostResponseChoice{{
				ChatStreamResponseChoice: &schemas.ChatStreamResponseChoice{Delta: &schemas.ChatStreamResponseChoiceDelta{Content: &content}},
			}},
			ExtraFields: schemas.BifrostResponseExtraFields{
				RequestType: schemas.ChatCompletionStreamRequest,
				Provider:    "openai",
				Latency:     int64(100 * (i + 1)),
				RoutingInfo: schemas.RoutingInfo{Provider: "openai", Model: primaryModel},
			},
		}}
		if i == len(deltas)-1 {
			finish := "stop"
			chunk.ChatResponse.Choices[0].FinishReason = &finish
			chunk.ChatResponse.Usage = &schemas.BifrostLLMUsage{PromptTokens: 10, CompletionTokens: 4}
			ctx.SetValue(schemas.BifrostContextKeyStreamEndIndicator, true)
		}
		_, _, err := p.PostLLMHook(ctx, chunk, nil)
		require.NoError(t, err)
		if i < len(deltas)-1 {
			assert.Equal(t, int64(0), p.enqueued.Load(), "nothing is enqueued before the final chunk")
		}
	}
	r := waitForRecords(t, p, 1)[0]
	assert.True(t, r.Stream)
	assert.Equal(t, "Hello world from the stream", r.PrimaryAnswer.Text)
	assert.Equal(t, "stop", r.PrimaryAnswer.FinishReason)
	assert.Equal(t, int64(400), r.PrimaryLatencyMs, "final chunk latency is the total latency")
	assert.Equal(t, 10, r.PrimaryInputTokens)
	assert.True(t, r.Pass)
}

func TestShadowStreamingToolCalls(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	name := "get_weather"
	fc := &fakeClient{}
	// Candidate replies with the same tool call, arguments re-ordered.
	fc2 := func(ctx *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
		finish := "tool_calls"
		return &schemas.BifrostChatResponse{Choices: []schemas.BifrostResponseChoice{{
			FinishReason: &finish,
			ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{Message: &schemas.ChatMessage{
				Role: schemas.ChatMessageRoleAssistant,
				ChatAssistantMessage: &schemas.ChatAssistantMessage{ToolCalls: []schemas.ChatAssistantMessageToolCall{
					{Function: schemas.ChatAssistantMessageToolCallFunction{Name: &name, Arguments: `{"unit":"c","city":"Paris"}`}},
				}},
			}},
		}}}, nil
	}
	_ = fc
	p.SetExecutors(fc2, nil, nil)

	ctx := requestCtx("req-tools")
	_, _, err := p.PreLLMHook(ctx, chatRequest(true, "openai", primaryModel, "weather in paris?"))
	require.NoError(t, err)
	parts := []schemas.ChatAssistantMessageToolCall{
		{Index: 0, Function: schemas.ChatAssistantMessageToolCallFunction{Name: &name, Arguments: `{"city":`}},
		{Index: 0, Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `"Paris","unit":"c"}`}},
	}
	for i, part := range parts {
		chunk := &schemas.BifrostResponse{ChatResponse: &schemas.BifrostChatResponse{
			Choices: []schemas.BifrostResponseChoice{{
				ChatStreamResponseChoice: &schemas.ChatStreamResponseChoice{Delta: &schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{part}}},
			}},
			ExtraFields: schemas.BifrostResponseExtraFields{RequestType: schemas.ChatCompletionStreamRequest, RoutingInfo: schemas.RoutingInfo{Provider: "openai", Model: primaryModel}},
		}}
		if i == len(parts)-1 {
			finish := "tool_calls"
			chunk.ChatResponse.Choices[0].FinishReason = &finish
			ctx.SetValue(schemas.BifrostContextKeyStreamEndIndicator, true)
		}
		_, _, err := p.PostLLMHook(ctx, chunk, nil)
		require.NoError(t, err)
	}
	r := waitForRecords(t, p, 1)[0]
	require.Len(t, r.PrimaryAnswer.ToolCalls, 1)
	assert.Equal(t, `{"city":"Paris","unit":"c"}`, r.PrimaryAnswer.ToolCalls[0].Arguments)
	require.NotNil(t, r.Comparison.ToolCallsMatch)
	assert.True(t, *r.Comparison.ToolCallsMatch)
	assert.Equal(t, BasisExact, r.PassBasis, "a tool-only turn with identical calls is an exact match")
	assert.True(t, r.Pass)
}

func TestShadowSkipsIneligibleRequests(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	fc := &fakeClient{candidateText: "x"}
	p.SetExecutors(fc.chat, nil, nil)

	// Different model: not eligible.
	ctx := requestCtx("other-model")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", "unrelated", "hi"))
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", "unrelated", "x", 1, 1, 1), nil)

	// Non-chat request type: ignored.
	ctx = requestCtx("embedding")
	_, _, _ = p.PreLLMHook(ctx, &schemas.BifrostRequest{RequestType: schemas.EmbeddingRequest})

	// No request ID: ignored.
	_, _, _ = p.PreLLMHook(schemas.NewBifrostContext(context.Background(), schemas.NoDeadline), chatRequest(false, "openai", primaryModel, "hi"))

	// Primary failed: capture dropped, nothing mirrored.
	ctx = requestCtx("primary-error")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	_, _, _ = p.PostLLMHook(ctx, nil, &schemas.BifrostError{Error: &schemas.ErrorField{Message: "boom"}})

	// Semantic cache hit: capture dropped.
	ctx = requestCtx("cache-hit")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	hit := chatResponse("openai", primaryModel, "cached", 1, 1, 1)
	hit.ChatResponse.ExtraFields.CacheDebug = &schemas.BifrostCacheMetadata{CacheHit: true}
	_, _, _ = p.PostLLMHook(ctx, hit, nil)

	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, 0, p.store.len())
	assert.Empty(t, fc.callsTo(candidateModel))
	assert.Equal(t, int64(0), p.active.Load())
	assert.Equal(t, int64(2), p.eligible.Load(), "only the two gpt-big requests were eligible")
}

func TestShadowHeaderOverrides(t *testing.T) {
	cfg := baseConfig()
	cfg.SampleRate = 0.0001
	cfg.AllowForceHeader = true
	p := newTestPlugin(t, cfg)
	p.randFloat = func() float64 { return 0.5 } // never under the sample rate
	fc := &fakeClient{candidateText: "ok"}
	p.SetExecutors(fc.chat, nil, nil)

	// Forced via header.
	ctx := requestCtx("forced")
	_, err := p.HTTPTransportPreHook(ctx, &schemas.HTTPRequest{Headers: map[string]string{"X-Bf-Shadow": "force"}})
	require.NoError(t, err)
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	headers := map[string]string{}
	require.NoError(t, p.HTTPTransportResponseHeadersHook(ctx, nil, &schemas.HTTPResponseMetadata{Headers: headers}))
	assert.Equal(t, "sampled", headers[ResponseHeader])
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "ok", 1, 1, 1), nil)
	waitForRecords(t, p, 1)

	// Opted out via header, even at 100% sampling.
	p.randFloat = func() float64 { return 0 }
	ctx = requestCtx("opted-out")
	_, _ = p.HTTPTransportPreHook(ctx, &schemas.HTTPRequest{Headers: map[string]string{"x-bf-shadow": "off"}})
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	headers = map[string]string{}
	require.NoError(t, p.HTTPTransportResponseHeadersHook(ctx, nil, &schemas.HTTPResponseMetadata{Headers: headers}))
	assert.Empty(t, headers[ResponseHeader])
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "ok", 1, 1, 1), nil)
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, 1, p.store.len())
}

// Without allow_force_header a caller cannot buy unbilled shadow spend: force and
// its aliases are treated like no header (normal sampling); off still opts out.
func TestShadowForceHeaderIgnoredUnlessAllowed(t *testing.T) {
	cfg := baseConfig()
	cfg.SampleRate = 0.0001
	p := newTestPlugin(t, cfg)
	p.randFloat = func() float64 { return 0.5 } // never under the sample rate
	fc := &fakeClient{candidateText: "ok"}
	p.SetExecutors(fc.chat, nil, nil)

	for i, value := range []string{"force", "FORCE", "on", "true", "1", "yes"} {
		ctx := requestCtx(fmt.Sprintf("force-%d", i))
		_, err := p.HTTPTransportPreHook(ctx, &schemas.HTTPRequest{Headers: map[string]string{"x-bf-shadow": value}})
		require.NoError(t, err)
		_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
		_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "ok", 1, 1, 1), nil)
	}
	assert.Equal(t, int64(6), p.eligible.Load(), "forced requests are still sampled normally")
	assert.Zero(t, p.sampled.Load(), "x-bf-shadow: force must not bypass sampling unless allow_force_header is set")

	// Normal sampling still applies to a request carrying the ignored header.
	p.randFloat = func() float64 { return 0 }
	ctx := requestCtx("force-sampled-normally")
	_, _ = p.HTTPTransportPreHook(ctx, &schemas.HTTPRequest{Headers: map[string]string{"x-bf-shadow": "force"}})
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	assert.Equal(t, int64(1), p.sampled.Load())

	// "off" works without the opt-in.
	ctx = requestCtx("off")
	_, _ = p.HTTPTransportPreHook(ctx, &schemas.HTTPRequest{Headers: map[string]string{"x-bf-shadow": "off"}})
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	assert.Equal(t, int64(1), p.sampled.Load())
}

// The HTTP gateway runs transport hooks on a shared request context but LLM hooks
// on a child of it, so a value set in PreLLMHook is not visible to the
// response-headers hook. The sampled marker must survive that split.
func TestShadowResponseHeaderAcrossContexts(t *testing.T) {
	cfg := baseConfig()
	p := newTestPlugin(t, cfg)
	p.randFloat = func() float64 { return 0 }
	fc := &fakeClient{candidateText: "ok"}
	p.SetExecutors(fc.chat, nil, nil)

	transportCtx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
	_, err := p.HTTPTransportPreHook(transportCtx, &schemas.HTTPRequest{Headers: map[string]string{}})
	require.NoError(t, err)
	llmCtx := schemas.NewBifrostContext(transportCtx, schemas.NoDeadline)
	llmCtx.SetValue(schemas.BifrostContextKeyRequestID, "req-split")
	_, _, _ = p.PreLLMHook(llmCtx, chatRequest(false, "openai", primaryModel, "hi"))
	_, _, _ = p.PostLLMHook(llmCtx, chatResponse("openai", primaryModel, "ok", 1, 1, 1), nil)

	headers := map[string]string{"X-Bifrost-Request-Id": "req-split"}
	require.NoError(t, p.HTTPTransportResponseHeadersHook(transportCtx, nil, &schemas.HTTPResponseMetadata{Headers: headers}))
	assert.Equal(t, "sampled", headers[ResponseHeader])
	assert.Equal(t, int64(0), p.marked.Load(), "the marker is consumed by the header hook")

	// An unsampled request on the same split gets no header.
	headers = map[string]string{"X-Bifrost-Request-Id": "req-other"}
	require.NoError(t, p.HTTPTransportResponseHeadersHook(transportCtx, nil, &schemas.HTTPResponseMetadata{Headers: headers}))
	assert.Empty(t, headers[ResponseHeader])
	waitForRecords(t, p, 1)
}

func TestShadowSampleRate(t *testing.T) {
	cfg := baseConfig()
	cfg.SampleRate = 0.25
	p := newTestPlugin(t, cfg)
	var n atomic.Int64
	p.randFloat = func() float64 { return float64(n.Add(1)%4) / 4 } // 0.25, 0.5, 0.75, 0, ...
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
	for i := 0; i < 8; i++ {
		ctx := requestCtx(fmt.Sprintf("s-%d", i))
		_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
		_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "x", 1, 1, 1), nil)
	}
	waitForRecords(t, p, 2)
	assert.Equal(t, int64(8), p.eligible.Load())
	assert.Equal(t, int64(2), p.sampled.Load())
}

func TestShadowVirtualKeyAllowList(t *testing.T) {
	cfg := baseConfig()
	cfg.VirtualKeys = []string{"vk-team-a"}
	p := newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)

	ctx := requestCtx("vk-b")
	ctx.SetValue(schemas.BifrostContextKeyGovernanceVirtualKeyID, "vk-team-b")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	assert.Equal(t, int64(0), p.sampled.Load())

	ctx = requestCtx("vk-a")
	ctx.SetValue(schemas.BifrostContextKeyGovernanceVirtualKeyID, "vk-team-a")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	assert.Equal(t, int64(1), p.sampled.Load())
}

func TestShadowCandidateErrorIsRecorded(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	fc := &fakeClient{candidateErr: &schemas.BifrostError{StatusCode: ptr(429), Error: &schemas.ErrorField{Message: "rate limited"}}}
	p.SetExecutors(fc.chat, nil, nil)
	runPrimary(t, p, "req-err", "hi", "hello")
	r := waitForRecords(t, p, 1)[0]
	assert.Equal(t, "HTTP 429: rate limited", r.CandidateError)
	assert.False(t, r.Pass)
	sum := p.Summary()
	assert.Equal(t, 1, sum.Pairs[0].Errors)
	assert.Equal(t, 1.0, sum.Pairs[0].ErrorRate)
	assert.Equal(t, VerdictNotReady, sum.Pairs[0].Verdict)
	assert.Equal(t, int64(1), sum.Counters.CandidateErrs)
}

func TestShadowWithoutExecutorRecordsError(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	runPrimary(t, p, "no-exec", "hi", "hello")
	r := waitForRecords(t, p, 1)[0]
	assert.Contains(t, r.CandidateError, "not configured")
}

func TestShadowDailyBudgetStopsSampling(t *testing.T) {
	cfg := baseConfig()
	cfg.DailyBudgetUSD = 0.0003 // one candidate call costs 0.00025
	p := newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)

	runPrimary(t, p, "b-1", "hi", "x")
	waitForRecords(t, p, 1)
	// $0.00025 spent of $0.0003: another job of the same cost would pass the cap.
	assert.True(t, p.budgetExhausted())
	runPrimary(t, p, "b-2", "hi", "x")
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, 1, p.store.len(), "no shadow calls once the budget has no room for one")
	assert.Equal(t, int64(1), p.budgetSkipped.Load())
	assert.True(t, p.Summary().BudgetExhausted)
	assert.InDelta(t, 0.00025, p.Summary().SpendTodayUSD, 1e-12, "the cap is never passed")

	// The budget resets on a new UTC day.
	p.now = func() time.Time { return time.Now().Add(24 * time.Hour) }
	assert.False(t, p.budgetExhausted())
}

func TestShadowQueueFullDropsWithoutBlocking(t *testing.T) {
	cfg := baseConfig()
	cfg.MaxConcurrency = 1
	cfg.QueueSize = 1
	p := newTestPlugin(t, cfg)
	block := make(chan struct{})
	fc := &fakeClient{candidateText: "x", block: block}
	p.SetExecutors(fc.chat, nil, nil)

	// Hold the only worker on the first job so the queue's one slot fills next.
	runPrimary(t, p, "q-0", "hi", "x")
	require.Eventually(t, func() bool { return p.inFlight.Load() == 1 }, 5*time.Second, time.Millisecond)
	start := time.Now()
	for i := 1; i < 10; i++ {
		runPrimary(t, p, fmt.Sprintf("q-%d", i), "hi", "x")
	}
	assert.Less(t, time.Since(start), time.Second, "a saturated shadow queue must not slow live requests")
	assert.GreaterOrEqual(t, p.dropped.Load(), int64(8), "one in flight, one queued, the rest dropped")
	close(block)
	waitForRecords(t, p, 2)
}

func TestShadowSkipsCandidateEqualToPrimary(t *testing.T) {
	cfg := baseConfig()
	cfg.Experiments[0].Source = ModelRef{Model: "*"}
	p := newTestPlugin(t, cfg)
	fc := &fakeClient{candidateText: "x"}
	p.SetExecutors(fc.chat, nil, nil)
	ctx := requestCtx("same")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", candidateModel, "hi"))
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", candidateModel, "x", 1, 1, 1), nil)
	time.Sleep(50 * time.Millisecond)
	assert.Empty(t, fc.callsTo(candidateModel), "a model is never shadowed against itself")
}

// store_payloads: false keeps prompts and answers out of the stored record only;
// scoring (lexical, embeddings, judge) must still see the real primary answer.
func TestShadowStorePayloadsOff(t *testing.T) {
	const answer = "The secret capital is Paris."
	cfg := baseConfig()
	cfg.StorePayloads = ptr(false)
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	cfg.Embedding = &EmbeddingConfig{Provider: "openai", Model: "embed"}
	p := newTestPlugin(t, cfg)
	fc := &fakeClient{candidateText: answer, judgeReply: `{"score_a": 8, "score_b": 8, "winner": "tie", "reason": "equivalent"}`}
	var embedded []string
	var embedMu sync.Mutex
	embed := func(_ *schemas.BifrostContext, req *schemas.BifrostEmbeddingRequest) (*schemas.BifrostEmbeddingResponse, *schemas.BifrostError) {
		embedMu.Lock()
		for _, in := range req.Input {
			embedded = append(embedded, *in.Content[0].Text)
		}
		embedMu.Unlock()
		return &schemas.BifrostEmbeddingResponse{Data: []schemas.EmbeddingData{
			{Index: 0, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0}}},
			{Index: 1, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0}}},
		}}, nil
	}
	p.SetExecutors(fc.chat, embed, nil)
	runPrimary(t, p, "priv", "my secret question", answer)
	r := waitForRecords(t, p, 1)[0]

	assert.Empty(t, r.Prompt)
	assert.Nil(t, r.PrimaryAnswer)
	assert.Nil(t, r.CandidateAnswer)
	raw, err := json.Marshal(r)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "secret", "the stored record carries no prompt or answer text")

	require.NotNil(t, r.Comparison, "metrics are still computed")
	assert.Equal(t, 1.0, r.Comparison.LexicalSimilarity, "identical answers are scored against the real primary answer")
	require.NotNil(t, r.Comparison.SemanticSimilarity, "embeddings run when payloads are not stored")
	embedMu.Lock()
	assert.Equal(t, []string{answer, answer}, embedded)
	embedMu.Unlock()
	judgeCalls := fc.callsTo(judgeModel)
	require.Len(t, judgeCalls, 1)
	judgePrompt := *judgeCalls[0].Input[1].Content.ContentStr
	assert.NotContains(t, judgePrompt, "(empty response)", "the judge must see the primary answer")
	assert.Equal(t, 2, strings.Count(judgePrompt, answer))
	assert.True(t, r.Pass)
}

func TestJanitorSweepsStaleCaptures(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	ctx := requestCtx("stale")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
	assert.Equal(t, int64(1), p.active.Load())
	assert.Equal(t, 0, p.sweepCaptures(time.Now().Add(-time.Hour)))
	assert.Equal(t, 1, p.sweepCaptures(time.Now().Add(time.Hour)))
	assert.Equal(t, int64(0), p.active.Load())

	// The response-header marker is swept the same way when no HTTP response follows.
	assert.Equal(t, int64(1), p.marked.Load())
	assert.Equal(t, 0, p.sweepMarks(time.Now().Add(-time.Hour)))
	assert.Equal(t, 1, p.sweepMarks(time.Now().Add(time.Hour)))
	assert.Equal(t, int64(0), p.marked.Load())
}

func TestRetriedAttemptReplacesCapture(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	ctx := requestCtx("retry")
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "first"))
	_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "second"))
	assert.Equal(t, int64(1), p.active.Load())
	v, ok := p.captures.Load("retry")
	require.True(t, ok)
	assert.Equal(t, "second", v.(*capture).prompt)
}

// Request IDs come from the caller (x-request-id), so two in-flight requests can
// share one. They must never share a capture: B's answer must not be paired with
// A's prompt, and the active counter must not drift.
func TestDuplicateRequestIDsNeverCrossPair(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	fc := &fakeClient{candidateText: "cand"}
	p.SetExecutors(fc.chat, nil, nil)
	ctxA, ctxB := requestCtx("same"), requestCtx("same")
	_, _, _ = p.PreLLMHook(ctxA, chatRequest(false, "openai", primaryModel, "prompt of A"))
	_, _, _ = p.PreLLMHook(ctxB, chatRequest(false, "openai", primaryModel, "prompt of B"))
	_, _, _ = p.PostLLMHook(ctxA, chatResponse("openai", primaryModel, "answer of A", 1, 1, 1), nil)
	_, _, _ = p.PostLLMHook(ctxB, chatResponse("openai", primaryModel, "answer of B", 1, 1, 1), nil)

	waitForRecords(t, p, 1)
	time.Sleep(50 * time.Millisecond)
	recs, _ := p.Records(RecordFilter{Limit: 10})
	require.Len(t, recs, 1, "only the request that holds the slot is mirrored")
	r := recs[0]
	assert.Equal(t, "prompt of A", r.Prompt)
	require.NotNil(t, r.PrimaryAnswer)
	assert.Equal(t, "answer of A", r.PrimaryAnswer.Text, "the answer is paired with its own prompt")
	calls := fc.callsTo(candidateModel)
	require.Len(t, calls, 1)
	assert.Equal(t, "prompt of A", *calls[0].Input[1].Content.ContentStr, "the candidate is sent the prompt that produced the answer")
	assert.Zero(t, p.active.Load())
	assert.Zero(t, captureCount(p))
}

func TestSharedRequestIDStressKeepsActiveBalanced(t *testing.T) {
	cfg := baseConfig()
	cfg.MaxConcurrency = 8
	cfg.QueueSize = 100000
	cfg.MaxRecords = 100000
	p := newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for g := 0; g < 32; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			<-start
			for i := 0; i < 200; i++ {
				ctx := requestCtx("shared-id")
				tag := fmt.Sprintf("%d-%d", g, i)
				_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "prompt "+tag))
				_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "answer "+tag, 1, 1, 1), nil)
			}
		}(g)
	}
	close(start)
	wg.Wait()
	assert.Zero(t, p.active.Load(), "active must return to zero once every request finished")
	assert.Zero(t, captureCount(p))
	require.Eventually(t, func() bool { return p.completed.Load() == p.enqueued.Load() }, 10*time.Second, 5*time.Millisecond)
	recs, _ := p.store.list(RecordFilter{})
	require.NotEmpty(t, recs)
	for _, r := range recs {
		require.NotNil(t, r.PrimaryAnswer)
		assert.Equal(t, strings.TrimPrefix(r.Prompt, "prompt "), strings.TrimPrefix(r.PrimaryAnswer.Text, "answer "), "record pairs another request's answer with this prompt")
	}
}

func captureCount(p *Plugin) int {
	n := 0
	p.captures.Range(func(_, _ any) bool { n++; return true })
	return n
}

// Cleanup (reload or shutdown) cancels in-flight shadow calls. Those are not
// candidate failures and must not be counted or persisted as such.
func TestCleanupDropsCancelledJobs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	cfg := baseConfig()
	cfg.PersistPath = path
	cfg.MaxConcurrency = 1
	p, err := Init(context.Background(), cfg, testLogger)
	require.NoError(t, err)
	started := make(chan struct{}, 4)
	var calls atomic.Int64
	p.SetExecutors(func(ctx *schemas.BifrostContext, _ *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
		calls.Add(1)
		started <- struct{}{}
		<-ctx.Done() // a real provider call returns when its context is cancelled
		return nil, &schemas.BifrostError{Error: &schemas.ErrorField{Message: ctx.Err().Error()}}
	}, nil, nil)
	runPrimary(t, p, "in-flight", "hi", "x")
	<-started
	runPrimary(t, p, "queued", "hi", "x") // waits in the queue behind the blocked worker
	require.NoError(t, p.Cleanup())

	assert.Zero(t, p.store.len(), "cancelled jobs are dropped, not recorded")
	assert.Zero(t, p.completed.Load())
	assert.Zero(t, p.candidateErrs.Load())
	assert.Equal(t, int64(1), calls.Load(), "a job still queued at shutdown is not started")
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Empty(t, strings.TrimSpace(string(data)), "nothing is persisted for cancelled jobs")
}

// The schema allows 0 for both thresholds; an explicit 0 must be honoured and
// only an absent field gets the default.
func TestThresholdsHonourExplicitZero(t *testing.T) {
	const experiments = `"experiments":[{"source":{"model":"a"},"candidates":[{"provider":"openai","model":"b"}]}]`
	parse := func(t *testing.T, doc string) *Config {
		t.Helper()
		var cfg Config
		require.NoError(t, json.Unmarshal([]byte(doc), &cfg))
		require.NoError(t, cfg.normalize())
		return &cfg
	}

	zero := parse(t, `{`+experiments+`,"thresholds":{"max_error_rate":0,"quality_tolerance":0,"min_samples":1}}`)
	assert.Equal(t, 0.0, zero.Thresholds.MaxErrorRate)
	assert.Equal(t, 0.0, zero.Thresholds.QualityTolerance)

	absent := parse(t, `{`+experiments+`,"thresholds":{"min_samples":1}}`)
	assert.Equal(t, DefaultMaxErrorRate, absent.Thresholds.MaxErrorRate)
	assert.Equal(t, DefaultQualityTolerance, absent.Thresholds.QualityTolerance)
	noBlock := parse(t, `{`+experiments+`}`)
	assert.Equal(t, DefaultMaxErrorRate, noBlock.Thresholds.MaxErrorRate)
	assert.Equal(t, DefaultQualityTolerance, noBlock.Thresholds.QualityTolerance)

	explicit := parse(t, `{`+experiments+`,"thresholds":{"max_error_rate":0.2,"quality_tolerance":2.5}}`)
	assert.Equal(t, 0.2, explicit.Thresholds.MaxErrorRate)
	assert.Equal(t, 2.5, explicit.Thresholds.QualityTolerance)

	// An explicit 0 survives a marshal/parse round trip of the normalized config.
	raw, err := json.Marshal(zero)
	require.NoError(t, err)
	again := parse(t, string(raw))
	assert.Equal(t, 0.0, again.Thresholds.MaxErrorRate)
	assert.Equal(t, 0.0, again.Thresholds.QualityTolerance)

	// The zeroes take effect: one candidate error out of 100 is too many, and a
	// candidate trailing the primary by half a judge point fails.
	recs := make([]*Record, 0, 100)
	for i := 0; i < 100; i++ {
		r := &Record{Experiment: zero.Experiments[0].Name, Candidate: ModelRef{Provider: "openai", Model: "b"}, Comparison: &Comparison{}, Pass: true}
		if i == 0 {
			r.CandidateError, r.Pass = "boom", false
		}
		recs = append(recs, r)
	}
	assert.Equal(t, VerdictNotReady, summarize(recs, zero, nil)[0].Verdict)
	p := &Plugin{config: zero}
	pass, basis := p.decidePass(&Comparison{}, &JudgeVerdict{PrimaryScore: 8, CandidateScore: 7.5}, false)
	assert.Equal(t, "judge", basis)
	assert.False(t, pass)

	var bad Config
	require.NoError(t, json.Unmarshal([]byte(`{`+experiments+`,"thresholds":{"max_error_rate":-0.1}}`), &bad))
	assert.Error(t, bad.normalize(), "negative thresholds are rejected")
}

// A panic while storing a finished record must not run finish a second time:
// spend, completed and the record would all be counted twice.
func TestFinishRunsOncePerJob(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	var stores atomic.Int64
	p.storeRecord = func(*Record) error {
		if stores.Add(1) == 1 {
			panic("disk on fire")
		}
		return nil
	}
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
	runPrimary(t, p, "once", "hi", "x")
	require.Eventually(t, func() bool { return p.completed.Load() >= 1 }, 5*time.Second, 5*time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	assert.Equal(t, int64(1), stores.Load(), "the record is stored at most once")
	assert.Equal(t, int64(1), p.completed.Load())
	assert.Zero(t, p.candidateErrs.Load())
	assert.InDelta(t, 0.00025, p.spendToday(), 1e-12, "the candidate call is charged once")
}

// A panic before runJob's own bookkeeping (here: in the external price function)
// must not take the gateway down; the job is recorded as an error, once.
func TestPanickingPriceFuncIsRecordedOnce(t *testing.T) {
	cfg := baseConfig()
	cfg.Pricing = nil // route pricing through the PriceFunc
	p := newTestPlugin(t, cfg)
	var storePanics atomic.Bool
	p.storeRecord = func(r *Record) error {
		if storePanics.Load() {
			panic("store bug")
		}
		return p.store.add(r)
	}
	fc := &fakeClient{candidateText: "x"}
	p.SetExecutors(fc.chat, nil, func(*schemas.BifrostLLMUsage, schemas.ModelProvider, string, schemas.RequestType) float64 {
		panic("catalog bug")
	})
	runPrimary(t, p, "boom", "hi", "x")
	r := waitForRecords(t, p, 1)[0]
	assert.Contains(t, r.CandidateError, "catalog bug")
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, 1, p.store.len())
	assert.Equal(t, int64(1), p.completed.Load())
	assert.Equal(t, int64(1), p.candidateErrs.Load())

	// A panic inside the recovery path itself (storing the error record) is
	// contained by the worker, which keeps serving later jobs.
	storePanics.Store(true)
	runPrimary(t, p, "boom-twice", "hi", "x")
	require.Eventually(t, func() bool { return p.completed.Load() == 2 }, 5*time.Second, 5*time.Millisecond)
	storePanics.Store(false)
	p.SetExecutors(fc.chat, nil, nil)
	runPrimary(t, p, "after", "hi", "x")
	waitForRecords(t, p, 2)
	assert.Equal(t, int64(3), p.completed.Load())
}

// Candidate, judge and embedding calls run through Client.ChatCompletionRequest,
// which injects MCP tools and runs the MCP agent loop. Shadow calls must not be
// offered or allowed to run any MCP tool.
func TestInternalContextExcludesMCP(t *testing.T) {
	cfg := baseConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	cfg.Embedding = &EmbeddingConfig{Provider: "openai", Model: "embed"}
	p := newTestPlugin(t, cfg)

	ctx, cancel := p.internalContext()
	defer cancel()
	assertNoMCP(t, ctx)

	var mu sync.Mutex
	var seen []*schemas.BifrostContext
	fc := &fakeClient{candidateText: "x", judgeReply: `{"score_a": 5, "score_b": 5, "winner": "tie"}`}
	chat := func(ctx *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
		mu.Lock()
		seen = append(seen, ctx)
		mu.Unlock()
		return fc.chat(ctx, req)
	}
	embed := func(ctx *schemas.BifrostContext, _ *schemas.BifrostEmbeddingRequest) (*schemas.BifrostEmbeddingResponse, *schemas.BifrostError) {
		mu.Lock()
		seen = append(seen, ctx)
		mu.Unlock()
		return &schemas.BifrostEmbeddingResponse{Data: []schemas.EmbeddingData{
			{Index: 0, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0}}},
			{Index: 1, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0}}},
		}}, nil
	}
	p.SetExecutors(chat, embed, nil)
	runPrimary(t, p, "mcp", "hi", "x")
	waitForRecords(t, p, 1)
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, seen, 3, "candidate, embedding and judge calls")
	for _, c := range seen {
		assertNoMCP(t, c)
	}
}

func assertNoMCP(t *testing.T, ctx *schemas.BifrostContext) {
	t.Helper()
	clients, ok := ctx.Value(schemas.MCPContextKeyIncludeClients).([]string)
	require.True(t, ok, "include-clients must be set")
	assert.NotNil(t, clients, "a nil list means all clients; it must be a non-nil empty list")
	assert.Empty(t, clients)
	tools, ok := ctx.Value(schemas.MCPContextKeyIncludeTools).([]string)
	require.True(t, ok, "include-tools must be set")
	assert.NotNil(t, tools)
	assert.Empty(t, tools)
}

// MCP injects its tools into the request before plugin pre-hooks run, so the
// snapshot of a sampled request already carries them. The candidate must see
// only the caller's own tools.
func TestSnapshotDropsMCPInjectedTools(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	fc := &fakeClient{candidateText: "x"}
	p.SetExecutors(fc.chat, nil, nil)

	fn := func(name string) schemas.ChatTool {
		return schemas.ChatTool{Type: schemas.ChatToolTypeFunction, Function: &schemas.ChatToolFunction{Name: name}}
	}
	ctx := requestCtx("mcp-tools")
	ctx.SetValue(schemas.BifrostContextKeyMCPAddedTools, []string{"files-read", "files-write", "coder-run"})
	ctx.SetValue(mcpAddedConnectToolsKey, []string{"notion-connect"})
	req := chatRequest(false, "openai", primaryModel, "hi")
	req.ChatRequest.Params.Tools = []schemas.ChatTool{fn("get_weather"), fn("files-read"), fn("files-write"), fn("listToolFiles"), fn("notion-connect")}
	_, _, err := p.PreLLMHook(ctx, req)
	require.NoError(t, err)
	assert.Len(t, req.ChatRequest.Params.Tools, 5, "the live request is never modified")
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "x", 1, 1, 1), nil)
	waitForRecords(t, p, 1)
	calls := fc.callsTo(candidateModel)
	require.Len(t, calls, 1)
	require.NotNil(t, calls[0].Params)
	var names []string
	for _, tool := range calls[0].Params.Tools {
		names = append(names, tool.Function.Name)
	}
	assert.Equal(t, []string{"get_weather"}, names)

	// Only MCP's tools go: with no MCP-added list on the context, every tool is the caller's.
	ctx = requestCtx("caller-tools")
	req = chatRequest(false, "openai", primaryModel, "hi")
	req.ChatRequest.Params.Tools = []schemas.ChatTool{fn("get_weather"), fn("files-read")}
	_, _, _ = p.PreLLMHook(ctx, req)
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "x", 1, 1, 1), nil)
	waitForRecords(t, p, 2)
	calls = fc.callsTo(candidateModel)
	require.Len(t, calls, 2)
	assert.Len(t, calls[1].Params.Tools, 2)

	// When MCP supplied every tool, the tool choice goes with them.
	ctx = requestCtx("only-mcp")
	ctx.SetValue(schemas.BifrostContextKeyMCPAddedTools, []string{"files-read"})
	req = chatRequest(false, "openai", primaryModel, "hi")
	auto := "auto"
	req.ChatRequest.Params.Tools = []schemas.ChatTool{fn("files-read")}
	req.ChatRequest.Params.ToolChoice = &schemas.ChatToolChoice{ChatToolChoiceStr: &auto}
	req.ChatRequest.Params.ParallelToolCalls = ptr(true)
	_, _, _ = p.PreLLMHook(ctx, req)
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "x", 1, 1, 1), nil)
	waitForRecords(t, p, 3)
	calls = fc.callsTo(candidateModel)
	require.Len(t, calls, 3)
	assert.Empty(t, calls[2].Params.Tools)
	assert.Nil(t, calls[2].Params.ToolChoice)
	assert.Nil(t, calls[2].Params.ParallelToolCalls)
	assert.NotNil(t, req.ChatRequest.Params.ToolChoice, "the live request keeps its tool choice")
}

// ExtraParams are tagged json:"-", so a JSON snapshot alone drops them; they and
// the passthrough flag that sends them to the provider must reach the candidate.
func TestCandidateReceivesExtraParams(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	var mu sync.Mutex
	var sent *schemas.BifrostChatRequest
	var passthrough any
	p.SetExecutors(func(ctx *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
		mu.Lock()
		sent, passthrough = req, ctx.Value(schemas.BifrostContextKeyPassthroughExtraParams)
		mu.Unlock()
		return chatResponse(req.Provider, req.Model, "x", 1, 1, 1).ChatResponse, nil
	}, nil, nil)

	ctx := requestCtx("extra")
	ctx.SetValue(schemas.BifrostContextKeyPassthroughExtraParams, true)
	req := chatRequest(false, "openai", primaryModel, "hi")
	req.ChatRequest.Params.ExtraParams = map[string]interface{}{"custom_flag": true, "nested": map[string]interface{}{"k": "v"}}
	_, _, err := p.PreLLMHook(ctx, req)
	require.NoError(t, err)
	_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "x", 1, 1, 1), nil)
	waitForRecords(t, p, 1)

	mu.Lock()
	defer mu.Unlock()
	require.NotNil(t, sent)
	require.NotNil(t, sent.Params)
	assert.Equal(t, map[string]interface{}{"custom_flag": true, "nested": map[string]interface{}{"k": "v"}}, sent.Params.ExtraParams)
	assert.Equal(t, true, passthrough, "the caller's passthrough opt-in carries over to the candidate call")
}

// A streamed refusal is the answer, exactly as it is for a unary response.
func TestShadowStreamingAccumulatesRefusal(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	refusal := "I can't help with that."
	p.SetExecutors(func(_ *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
		finish := "stop"
		return &schemas.BifrostChatResponse{Choices: []schemas.BifrostResponseChoice{{
			FinishReason: &finish,
			ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{Message: &schemas.ChatMessage{
				Role:                 schemas.ChatMessageRoleAssistant,
				ChatAssistantMessage: &schemas.ChatAssistantMessage{Refusal: &refusal},
			}},
		}}}, nil
	}, nil, nil)

	ctx := requestCtx("refusal")
	_, _, err := p.PreLLMHook(ctx, chatRequest(true, "openai", primaryModel, "do something bad"))
	require.NoError(t, err)
	parts := []string{"I can't ", "help with ", "that."}
	for i, part := range parts {
		delta := part
		chunk := &schemas.BifrostResponse{ChatResponse: &schemas.BifrostChatResponse{
			Choices: []schemas.BifrostResponseChoice{{
				ChatStreamResponseChoice: &schemas.ChatStreamResponseChoice{Delta: &schemas.ChatStreamResponseChoiceDelta{Refusal: &delta}},
			}},
			ExtraFields: schemas.BifrostResponseExtraFields{RequestType: schemas.ChatCompletionStreamRequest, RoutingInfo: schemas.RoutingInfo{Provider: "openai", Model: primaryModel}},
		}}
		if i == len(parts)-1 {
			finish := "stop"
			chunk.ChatResponse.Choices[0].FinishReason = &finish
			ctx.SetValue(schemas.BifrostContextKeyStreamEndIndicator, true)
		}
		_, _, err := p.PostLLMHook(ctx, chunk, nil)
		require.NoError(t, err)
	}
	r := waitForRecords(t, p, 1)[0]
	require.NotNil(t, r.PrimaryAnswer)
	assert.Equal(t, refusal, r.PrimaryAnswer.Text)
	assert.Equal(t, 1.0, r.Comparison.LexicalSimilarity)
	assert.True(t, r.Pass)
}

// An embedding call that succeeded was paid for, even when its vectors cannot
// be compared.
func TestEmbeddingCostKeptWhenVectorsUnusable(t *testing.T) {
	cfg := baseConfig()
	cfg.Embedding = &EmbeddingConfig{Provider: "openai", Model: "embed"}
	cfg.Pricing["openai/embed"] = ModelPrice{InputPerMillion: 100}
	p := newTestPlugin(t, cfg)
	embed := func(_ *schemas.BifrostContext, _ *schemas.BifrostEmbeddingRequest) (*schemas.BifrostEmbeddingResponse, *schemas.BifrostError) {
		return &schemas.BifrostEmbeddingResponse{
			Data: []schemas.EmbeddingData{
				{Index: 0, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0}}},
				{Index: 1, Embedding: schemas.EmbeddingStruct{EmbeddingArray: []float64{1, 0, 0}}},
			},
			Usage: &schemas.BifrostLLMUsage{PromptTokens: 1000, TotalTokens: 1000},
		}, nil
	}
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, embed, nil)
	runPrimary(t, p, "embed-cost", "hi", "x")
	r := waitForRecords(t, p, 1)[0]
	assert.Nil(t, r.Comparison.SemanticSimilarity)
	assert.InDelta(t, 0.1, r.EvalCostUSD, 1e-12, "1000 tokens at $100/M")
	assert.InDelta(t, 0.00025+0.1, p.spendToday(), 1e-12)
}

func TestSummaryVerdicts(t *testing.T) {
	cfg := baseConfig()
	cfg.Thresholds = Thresholds{MinSamples: 20, MinAgreement: 0.9}
	require.NoError(t, cfg.normalize())

	mk := func(n, passes, errs int) []*Record {
		var out []*Record
		for i := 0; i < n; i++ {
			r := &Record{Experiment: "big-to-small", Candidate: ModelRef{Provider: "openai", Model: candidateModel}, Primary: ModelRef{Provider: "openai", Model: primaryModel}, CreatedAt: time.Now(), Comparison: &Comparison{}, PrimaryCostUSD: 0.01, CandidateCostUSD: 0.001}
			switch {
			case i < errs:
				r.CandidateError = "boom"
			case i < errs+passes:
				r.Pass = true
			}
			out = append(out, r)
		}
		return out
	}
	verdict := func(recs []*Record) string { return summarize(recs, cfg, nil)[0].Verdict }

	assert.Equal(t, VerdictCollecting, verdict(mk(10, 10, 0)))
	assert.Equal(t, VerdictReady, verdict(mk(400, 396, 0)))
	assert.Equal(t, VerdictPromising, verdict(mk(20, 19, 0)), "95% point estimate, lower bound 76%")
	assert.Equal(t, VerdictNotReady, verdict(mk(100, 70, 0)))
	assert.Equal(t, VerdictNotReady, verdict(mk(100, 90, 10)), "10% errors exceed the 5% limit")

	s := summarize(mk(40, 40, 0), cfg, func(string) float64 { return 1 }) // 1 req/s
	assert.InDelta(t, 90, s[0].SavingsPct, 1e-9)
	assert.InDelta(t, 0.009*30*24*3600, s[0].ProjectedMonthlySavingsUSD, 1e-6)
}

func TestBuildCanaryRule(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	rule, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, 0.1)
	require.NoError(t, err)
	assert.Equal(t, `provider == "openai" && model == "gpt-big"`, rule.CelExpression)
	require.Len(t, rule.Targets, 2)
	assert.Equal(t, RoutingTarget{Provider: "openai", Model: primaryModel, Weight: 0.9}, rule.Targets[0])
	assert.Equal(t, RoutingTarget{Provider: "openai", Model: candidateModel, Weight: 0.1}, rule.Targets[1])
	assert.Equal(t, "global", rule.Scope)

	full, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, 1)
	require.NoError(t, err)
	assert.Len(t, full.Targets, 1)

	_, err = p.BuildCanaryRule("nope", "openai/"+candidateModel, 0.1)
	assert.ErrorIs(t, err, ErrUnknownPair)
	_, err = p.BuildCanaryRule("big-to-small", "openai/other", 0.1)
	assert.ErrorIs(t, err, ErrUnknownPair)
	_, err = p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, 0)
	assert.Error(t, err)
}

func TestBuildCanaryRuleWildcardUsesObservedModel(t *testing.T) {
	cfg := baseConfig()
	cfg.Experiments[0].Source = ModelRef{Model: "*"}
	p := newTestPlugin(t, cfg)
	_, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, 0.1)
	assert.Error(t, err, "no observed traffic yet")

	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
	runPrimary(t, p, "w-1", "hi", "x")
	waitForRecords(t, p, 1)
	rule, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, 0.25)
	require.NoError(t, err)
	assert.Equal(t, `provider == "openai" && model == "gpt-big"`, rule.CelExpression)
	assert.Equal(t, 0.75, rule.Targets[0].Weight)
}

func TestStorePersistenceAndReset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shadow.jsonl")
	cfg := baseConfig()
	cfg.PersistPath = path
	p, err := Init(context.Background(), cfg, testLogger)
	require.NoError(t, err)
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
	runPrimary(t, p, "persist-1", "hi", "x")
	waitForRecords(t, p, 1) // serialize so "newest first" is deterministic
	runPrimary(t, p, "persist-2", "hi", "x")
	waitForRecords(t, p, 2)
	require.NoError(t, p.Cleanup())

	// Append a torn line, as a crash mid-write would leave.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	require.NoError(t, err)
	_, _ = f.WriteString(`{"id":"torn`)
	require.NoError(t, f.Close())

	cfg2 := baseConfig()
	cfg2.PersistPath = path
	p2 := newTestPlugin(t, cfg2)
	recs, total := p2.Records(RecordFilter{})
	assert.Equal(t, 2, total, "records survive a restart; the torn line is skipped")
	assert.Equal(t, "persist-2", recs[0].RequestID, "newest first")
	require.NotNil(t, p2.Record(recs[1].ID))

	require.NoError(t, p2.Reset())
	_, total = p2.Records(RecordFilter{})
	assert.Equal(t, 0, total)
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Empty(t, strings.TrimSpace(string(data)))
}

func TestResetRestartsCollectionWindowAndKeepsSpend(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	started := p.Summary().StartedAt
	require.False(t, started.IsZero())

	p.sampled.Store(7)
	p.addSpend(0.25)
	later := started.Add(90 * time.Minute)
	p.now = func() time.Time { return later }

	require.NoError(t, p.Reset())
	s := p.Summary()
	assert.True(t, s.StartedAt.Equal(later), "counters restart at reset, so the collection window must too")
	assert.Zero(t, s.Counters.Sampled)
	assert.InDelta(t, 0.25, s.SpendTodayUSD, 1e-9, "today's spend survives a reset so the daily budget still applies")
}

func TestStoreRingBufferAndFilters(t *testing.T) {
	st, err := newStore(3, "")
	require.NoError(t, err)
	for i := 0; i < 5; i++ {
		r := &Record{ID: fmt.Sprintf("r%d", i), Experiment: "e", Candidate: ModelRef{Provider: "p", Model: "m"}, Pass: i%2 == 0}
		if i == 4 {
			r.CandidateError = "x"
		}
		require.NoError(t, st.add(r))
	}
	all, total := st.list(RecordFilter{})
	assert.Equal(t, 3, total, "oldest records are evicted")
	assert.Equal(t, []string{"r4", "r3", "r2"}, []string{all[0].ID, all[1].ID, all[2].ID})
	passes, _ := st.list(RecordFilter{Outcome: "pass"})
	assert.Len(t, passes, 1)
	fails, _ := st.list(RecordFilter{Outcome: "fail"})
	assert.Len(t, fails, 1)
	errs, _ := st.list(RecordFilter{Outcome: "error"})
	assert.Len(t, errs, 1)
	page, total := st.list(RecordFilter{Limit: 1, Offset: 1})
	assert.Equal(t, 3, total)
	assert.Equal(t, "r3", page[0].ID)
	none, _ := st.list(RecordFilter{Candidate: "p/other"})
	assert.Empty(t, none)
	assert.Nil(t, st.get("r0"))
}

func TestParseOutcome(t *testing.T) {
	for _, ok := range []string{"", "all", "pass", "FAIL", "error"} {
		_, err := ParseOutcome(ok)
		assert.NoError(t, err, ok)
	}
	_, err := ParseOutcome("maybe")
	assert.Error(t, err)
}

func TestConcurrentTraffic(t *testing.T) {
	cfg := baseConfig()
	cfg.MaxConcurrency = 8
	cfg.QueueSize = 1000
	p := newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				id := fmt.Sprintf("c-%d-%d", g, i)
				ctx := requestCtx(id)
				_, _, _ = p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "hi"))
				_, _, _ = p.PostLLMHook(ctx, chatResponse("openai", primaryModel, "x", 1, 1, 1), nil)
				_ = p.Summary()
			}
		}(g)
	}
	wg.Wait()
	waitForRecords(t, p, 400)
	assert.Equal(t, int64(0), p.active.Load())
	assert.Equal(t, int64(400), p.completed.Load())
}

// --- request-path cost (see AGENTS.md: every change states its cost) ---

func BenchmarkPreLLMHookNotEligible(b *testing.B) {
	p, _ := Init(context.Background(), baseConfig(), testLogger)
	defer p.Cleanup()
	ctx := requestCtx("bench")
	req := chatRequest(false, "openai", "some-other-model", "hi")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = p.PreLLMHook(ctx, req)
	}
}

func BenchmarkPreLLMHookEligibleNotSampled(b *testing.B) {
	cfg := baseConfig()
	cfg.SampleRate = 0.0001
	p, _ := Init(context.Background(), cfg, testLogger)
	defer p.Cleanup()
	p.randFloat = func() float64 { return 0.5 }
	ctx := requestCtx("bench")
	req := chatRequest(false, "openai", primaryModel, "hi")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = p.PreLLMHook(ctx, req)
	}
}

// BenchmarkPreLLMHookEligibleNotSampledParallel is the common case under load:
// every core hits the eligible-but-unsampled path at once.
func BenchmarkPreLLMHookEligibleNotSampledParallel(b *testing.B) {
	cfg := baseConfig()
	cfg.SampleRate = 0.0001
	p, _ := Init(context.Background(), cfg, testLogger)
	defer p.Cleanup()
	p.randFloat = func() float64 { return 0.5 }
	req := chatRequest(false, "openai", primaryModel, "hi")
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		ctx := requestCtx("bench")
		for pb.Next() {
			_, _, _ = p.PreLLMHook(ctx, req)
		}
	})
}

// BenchmarkStreamChunkInterceptorOnePlugin mirrors lib.pluginChunkInterceptor for
// this plugin alone: what every streamed chunk pays because the plugin is an
// HTTPTransportPlugin (sampled or not). The scope wrapper is core's, not ours.
func BenchmarkStreamChunkInterceptorOnePlugin(b *testing.B) {
	p, _ := Init(context.Background(), baseConfig(), testLogger)
	defer p.Cleanup()
	var plugin schemas.HTTPTransportPlugin = p
	ctx := requestCtx("bench")
	chunk := &schemas.BifrostStreamChunk{}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		name := plugin.GetName()
		func() {
			scoped := ctx.WithPluginScope(&name)
			defer scoped.ReleasePluginScope()
			_, _ = plugin.HTTPTransportStreamChunkHook(scoped, nil, chunk)
		}()
	}
}

// BenchmarkStreamChunkHook is the plugin's own share of the per-chunk cost.
func BenchmarkStreamChunkHook(b *testing.B) {
	p, _ := Init(context.Background(), baseConfig(), testLogger)
	defer p.Cleanup()
	ctx := requestCtx("bench")
	chunk := &schemas.BifrostStreamChunk{}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = p.HTTPTransportStreamChunkHook(ctx, nil, chunk)
	}
}

// BenchmarkUnsampledWhileActive is an unsampled eligible request while another
// sampled request is in flight, so both hooks take the capture-map path.
func BenchmarkUnsampledWhileActive(b *testing.B) {
	cfg := baseConfig()
	cfg.SampleRate = 0.0001
	p, _ := Init(context.Background(), cfg, testLogger)
	defer p.Cleanup()
	p.randFloat = func() float64 { return 0 }
	_, _, _ = p.PreLLMHook(requestCtx("inflight"), chatRequest(false, "openai", primaryModel, "x"))
	p.randFloat = func() float64 { return 0.5 }
	req := chatRequest(false, "openai", primaryModel, "hi")
	resp := chatResponse("openai", primaryModel, "x", 1, 1, 1)
	ctx := requestCtx("bench")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = p.PreLLMHook(ctx, req)
		_, _, _ = p.PostLLMHook(ctx, resp, nil)
	}
}

func BenchmarkPostLLMHookNoCapture(b *testing.B) {
	p, _ := Init(context.Background(), baseConfig(), testLogger)
	defer p.Cleanup()
	ctx := requestCtx("bench")
	resp := chatResponse("openai", primaryModel, "x", 1, 1, 1)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = p.PostLLMHook(ctx, resp, nil)
	}
}

func BenchmarkResponseHeadersHookNotSampled(b *testing.B) {
	p, _ := Init(context.Background(), baseConfig(), testLogger)
	defer p.Cleanup()
	ctx := requestCtx("bench")
	resp := &schemas.HTTPResponseMetadata{Headers: map[string]string{"X-Bifrost-Request-Id": "bench"}}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = p.HTTPTransportResponseHeadersHook(ctx, nil, resp)
	}
}

func BenchmarkSampledRequest(b *testing.B) {
	cfg := baseConfig()
	cfg.QueueSize = 1 // measure the hook path; jobs beyond the queue are dropped
	p, _ := Init(context.Background(), cfg, testLogger)
	defer p.Cleanup()
	block := make(chan struct{})
	defer close(block)
	p.SetExecutors((&fakeClient{block: block}).chat, nil, nil)
	req := chatRequest(false, "openai", primaryModel, "What is the capital of France?")
	resp := chatResponse("openai", primaryModel, "Paris", 10, 1, 1)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ctx := requestCtx("bench")
		_, _, _ = p.PreLLMHook(ctx, req)
		_, _, _ = p.PostLLMHook(ctx, resp, nil)
	}
}
