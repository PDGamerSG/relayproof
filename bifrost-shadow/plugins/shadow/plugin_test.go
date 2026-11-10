package shadow

import (
	"context"
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
	assert.Equal(t, "lexical", r.PassBasis)
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
	assert.Equal(t, "structural", r.PassBasis)
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
	runPrimary(t, p, "b-2", "hi", "x")
	waitForRecords(t, p, 2)
	assert.True(t, p.budgetExhausted())
	runPrimary(t, p, "b-3", "hi", "x")
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, 2, p.store.len(), "no shadow calls once the budget is spent")
	assert.Equal(t, int64(1), p.budgetSkipped.Load())
	assert.True(t, p.Summary().BudgetExhausted)

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

	start := time.Now()
	for i := 0; i < 10; i++ {
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

func TestShadowStorePayloadsOff(t *testing.T) {
	cfg := baseConfig()
	cfg.StorePayloads = ptr(false)
	p := newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: "secret answer"}).chat, nil, nil)
	runPrimary(t, p, "priv", "my secret question", "secret answer")
	r := waitForRecords(t, p, 1)[0]
	assert.Empty(t, r.Prompt)
	assert.Nil(t, r.PrimaryAnswer)
	assert.Nil(t, r.CandidateAnswer)
	require.NotNil(t, r.Comparison, "metrics are still computed")
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
