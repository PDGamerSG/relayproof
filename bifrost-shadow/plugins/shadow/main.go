// Package shadow implements live shadow-traffic evaluation for Bifrost.
//
// The plugin mirrors a sampled share of live chat-completion traffic to one or
// more candidate models, off the request path, and compares each candidate
// answer with the answer the caller actually received: cost, latency, tool-call
// and JSON-structure agreement, lexical and (optionally) embedding similarity,
// and (optionally) an LLM-as-judge verdict. The resulting scorecards tell an
// operator whether a cheaper or newer model is a safe substitute on their real
// traffic, and produce a weighted routing rule to canary it.
//
// Callers never see a candidate answer: shadow calls run asynchronously after
// the primary response is complete, on a bounded worker pool, as internal
// sub-requests that skip the plugin pipeline (so they cannot recurse, and are
// not billed to the caller's virtual key). A full queue drops shadow work rather
// than delaying live traffic, and a daily budget caps what shadowing may spend.
package shadow

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

// ChatExecutor runs a chat completion through the Bifrost client. It mirrors
// the signature of bifrost.Bifrost.ChatCompletionRequest.
type ChatExecutor func(ctx *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError)

// EmbeddingExecutor runs an embedding request through the Bifrost client. It
// mirrors the signature of bifrost.Bifrost.EmbeddingRequest.
type EmbeddingExecutor func(ctx *schemas.BifrostContext, req *schemas.BifrostEmbeddingRequest) (*schemas.BifrostEmbeddingResponse, *schemas.BifrostError)

// PriceFunc prices token usage for a provider/model, typically backed by the
// model catalog. It returns 0 when the model has no known price.
type PriceFunc func(usage *schemas.BifrostLLMUsage, provider schemas.ModelProvider, model string, requestType schemas.RequestType) float64

// ShadowHeader lets a caller control mirroring per request:
// "off" never mirrors the request, "force" always mirrors it (budget still applies).
const ShadowHeader = "x-bf-shadow"

// ResponseHeader is set to "sampled" on responses whose request was mirrored.
const ResponseHeader = "x-bf-shadow"

type shadowMode int

const (
	shadowModeDefault shadowMode = iota
	shadowModeOff
	shadowModeForce
)

// contextKeyMode carries the per-request override parsed from ShadowHeader.
const contextKeyMode schemas.BifrostContextKey = "bf-shadow-mode"

// requestIDHeader is the gateway response header carrying the request ID.
const requestIDHeader = "x-bifrost-request-id"

// staleCaptureAge is how long an unfinished capture is kept before the janitor
// drops it (a primary whose post-hook never ran, e.g. a dropped connection).
const staleCaptureAge = 10 * time.Minute

type executors struct {
	chat  ChatExecutor
	embed EmbeddingExecutor
	price PriceFunc
}

// capture is the per-request state held between PreLLMHook and the final
// PostLLMHook. It lives in the plugin's map keyed by request ID, never in the
// context (see AGENTS.md: no stream-sized data in BifrostContext).
type capture struct {
	mu          sync.Mutex
	createdAt   time.Time
	experiments []*Experiment
	snapshot    []byte // JSON of the primary chat request, decoded fresh per job
	prompt      string
	stream      bool

	// Stream accumulation.
	text         strings.Builder
	toolCalls    map[uint16]*ToolCall
	toolOrder    []uint16
	finishReason string
	usage        *schemas.BifrostLLMUsage
}

// job is one candidate call to run in the background.
type job struct {
	requestID  string
	experiment string
	snapshot   []byte
	prompt     string
	stream     bool
	primary    ModelRef
	candidate  ModelRef
	answer     Answer
	usage      *schemas.BifrostLLMUsage
	latencyMs  int64
	enqueuedAt time.Time
}

// Counters are cumulative since plugin start (or the last reset).
type Counters struct {
	Eligible      int64 `json:"eligible"`
	Sampled       int64 `json:"sampled"`
	Enqueued      int64 `json:"enqueued"`
	Dropped       int64 `json:"dropped"`
	BudgetSkipped int64 `json:"budget_skipped"`
	Completed     int64 `json:"completed"`
	CandidateErrs int64 `json:"candidate_errors"`
	InFlight      int64 `json:"in_flight"`
	QueueDepth    int   `json:"queue_depth"`
}

type trafficCounter struct {
	count int64
	first time.Time
	last  time.Time
}

// Plugin is the shadow traffic plugin.
type Plugin struct {
	config *Config
	logger schemas.Logger
	store  *store

	execs atomic.Pointer[executors]

	captures sync.Map // requestID -> *capture
	active   atomic.Int64

	// marks remembers sampled request IDs until the response-headers hook runs;
	// the gateway runs LLM hooks on a child context, so a context value set in
	// PreLLMHook is not visible there.
	marks  sync.Map // requestID -> time.Time
	marked atomic.Int64

	queue  chan *job
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	startedAt time.Time

	eligible      atomic.Int64
	sampled       atomic.Int64
	enqueued      atomic.Int64
	dropped       atomic.Int64
	budgetSkipped atomic.Int64
	completed     atomic.Int64
	candidateErrs atomic.Int64
	inFlight      atomic.Int64

	spendMu  sync.Mutex
	spendDay string
	spentUSD float64

	trafficMu sync.Mutex
	traffic   map[string]*trafficCounter

	// randFloat is swappable in tests for deterministic sampling.
	randFloat func() float64
	now       func() time.Time
}

// Init creates the plugin and starts its worker pool. Executors are wired
// separately with SetExecutors once the Bifrost client exists.
func Init(ctx context.Context, config *Config, logger schemas.Logger) (*Plugin, error) {
	if err := config.normalize(); err != nil {
		return nil, err
	}
	st, err := newStore(config.MaxRecords, config.PersistPath)
	if err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// Shadow work must outlive any single request but stop with the plugin; it
	// deliberately does not inherit cancellation from the init context, which
	// for reloads is a short-lived API request.
	workerCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	p := &Plugin{
		config:    config,
		logger:    logger,
		store:     st,
		queue:     make(chan *job, config.QueueSize),
		ctx:       workerCtx,
		cancel:    cancel,
		startedAt: time.Now(),
		traffic:   make(map[string]*trafficCounter),
		randFloat: rand.Float64,
		now:       time.Now,
	}
	for i := 0; i < config.MaxConcurrency; i++ {
		p.wg.Add(1)
		go p.worker()
	}
	p.wg.Add(1)
	go p.janitor()
	return p, nil
}

// SetExecutors wires the Bifrost client calls and the pricing function. It is
// safe to call at any time; shadow jobs queued before it is called are
// recorded as candidate errors.
func (p *Plugin) SetExecutors(chat ChatExecutor, embed EmbeddingExecutor, price PriceFunc) {
	p.execs.Store(&executors{chat: chat, embed: embed, price: price})
}

// GetName returns the plugin name.
func (p *Plugin) GetName() string { return PluginName }

// Config returns the normalized configuration (read-only).
func (p *Plugin) Config() Config { return *p.config }

// Cleanup stops the workers, waiting briefly for in-flight shadow calls.
func (p *Plugin) Cleanup() error {
	p.cancel()
	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		p.logger.Warn("shadow: timed out waiting for workers to stop")
	}
	return p.store.close()
}

// --- HTTP transport hooks: per-request opt-in/out and the response marker ---

// HTTPTransportPreAuthHook is unused.
func (p *Plugin) HTTPTransportPreAuthHook(_ *schemas.BifrostContext, _ *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	return nil, nil
}

// HTTPTransportPreHook reads the x-bf-shadow request header.
func (p *Plugin) HTTPTransportPreHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	if req == nil {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimSpace(req.CaseInsensitiveHeaderLookup(ShadowHeader))) {
	case "off", "false", "0", "no", "skip":
		ctx.SetValue(contextKeyMode, shadowModeOff)
	case "force", "on", "true", "1", "yes":
		ctx.SetValue(contextKeyMode, shadowModeForce)
	}
	return nil, nil
}

// HTTPTransportPostHook is unused.
func (p *Plugin) HTTPTransportPostHook(_ *schemas.BifrostContext, _ *schemas.HTTPRequest, _ *schemas.HTTPResponse) error {
	return nil
}

// HTTPTransportResponseHeadersHook marks mirrored responses with x-bf-shadow: sampled.
// The request is matched by the gateway's request-id header, falling back to the
// context, because LLM hooks may run on a child of the transport context.
func (p *Plugin) HTTPTransportResponseHeadersHook(ctx *schemas.BifrostContext, _ *schemas.HTTPRequest, resp *schemas.HTTPResponseMetadata) error {
	if resp == nil || resp.Headers == nil || p.marked.Load() == 0 {
		return nil
	}
	requestID := resp.Header(requestIDHeader)
	if requestID == "" {
		requestID, _ = ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	}
	if requestID == "" {
		return nil
	}
	if _, ok := p.marks.LoadAndDelete(requestID); ok {
		p.marked.Add(-1)
		resp.Headers[ResponseHeader] = "sampled"
	}
	return nil
}

// HTTPTransportStreamChunkHook passes chunks through unchanged.
func (p *Plugin) HTTPTransportStreamChunkHook(_ *schemas.BifrostContext, _ *schemas.HTTPRequest, chunk *schemas.BifrostStreamChunk) (*schemas.BifrostStreamChunk, error) {
	return chunk, nil
}

// --- LLM hooks ---

// PreRequestHook is unused: sampling happens per attempt in PreLLMHook, where
// the provider/model actually being called is known.
func (p *Plugin) PreRequestHook(_ *schemas.BifrostContext, _ *schemas.BifrostRequest) error {
	return nil
}

// PreLLMHook decides whether this attempt is mirrored and snapshots the request.
// Cost for requests that are not sampled: a type check, a context read, and one
// experiment match per configured experiment — no allocation.
func (p *Plugin) PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	if req == nil || req.ChatRequest == nil {
		return req, nil, nil
	}
	if req.RequestType != schemas.ChatCompletionRequest && req.RequestType != schemas.ChatCompletionStreamRequest {
		return req, nil, nil
	}
	requestID, _ := ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	if requestID == "" {
		return req, nil, nil
	}
	// A retried attempt must not inherit a previous attempt's capture.
	if p.active.Load() > 0 {
		p.dropCapture(requestID)
	}

	mode, _ := ctx.Value(contextKeyMode).(shadowMode)
	if mode == shadowModeOff {
		return req, nil, nil
	}
	if !p.virtualKeyAllowed(ctx) {
		return req, nil, nil
	}
	chat := req.ChatRequest
	var sampledExps []*Experiment
	for i := range p.config.Experiments {
		exp := &p.config.Experiments[i]
		if !exp.Source.matches(chat.Provider, chat.Model) {
			continue
		}
		p.eligible.Add(1)
		p.recordTraffic(exp.Name)
		if mode == shadowModeForce || p.randFloat() < p.config.experimentSampleRate(exp) {
			sampledExps = append(sampledExps, exp)
		}
	}
	if len(sampledExps) == 0 {
		return req, nil, nil
	}
	if p.budgetExhausted() {
		p.budgetSkipped.Add(1)
		return req, nil, nil
	}
	snapshot, err := snapshotChatRequest(chat)
	if err != nil {
		return req, nil, fmt.Errorf("shadow: snapshot request: %w", err)
	}
	c := &capture{
		createdAt:   p.now(),
		experiments: sampledExps,
		snapshot:    snapshot,
		stream:      req.RequestType == schemas.ChatCompletionStreamRequest,
	}
	if p.config.storePayloads() {
		c.prompt = truncate(lastUserTurn(chat.Input), p.config.MaxPayloadChars)
	}
	p.captures.Store(requestID, c)
	p.active.Add(1)
	p.sampled.Add(1)
	if _, loaded := p.marks.LoadOrStore(requestID, c.createdAt); !loaded {
		p.marked.Add(1)
	}
	return req, nil, nil
}

// PostLLMHook collects the primary answer (accumulating stream chunks) and,
// once it is complete, enqueues one shadow job per candidate.
func (p *Plugin) PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	if p.active.Load() == 0 {
		return resp, bifrostErr, nil
	}
	requestID, _ := ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	if requestID == "" {
		return resp, bifrostErr, nil
	}
	v, ok := p.captures.Load(requestID)
	if !ok {
		return resp, bifrostErr, nil
	}
	c := v.(*capture)
	if bifrostErr != nil || resp == nil || resp.ChatResponse == nil {
		// A failed primary has nothing to compare against.
		p.dropCapture(requestID)
		return resp, bifrostErr, nil
	}
	chatResp := resp.ChatResponse
	extra := &chatResp.ExtraFields
	if extra.CacheDebug != nil && extra.CacheDebug.CacheHit {
		// Cache replays have no real primary latency or cost to compare.
		p.dropCapture(requestID)
		return resp, bifrostErr, nil
	}

	var answer Answer
	var usage *schemas.BifrostLLMUsage
	if c.stream {
		c.mu.Lock()
		c.accumulate(chatResp)
		final := bifrost.IsFinalChunk(ctx)
		if !final {
			c.mu.Unlock()
			return resp, bifrostErr, nil
		}
		answer = c.streamAnswer()
		usage = c.usage
		c.mu.Unlock()
	} else {
		answer = answerFromChatResponse(chatResp)
		usage = chatResp.Usage
	}

	primary := ModelRef{Provider: extra.RoutingInfo.Provider, Model: extra.RoutingInfo.Model}
	if primary.Provider == "" {
		primary.Provider = extra.Provider
	}
	if primary.Model == "" {
		primary.Model = firstNonEmpty(extra.ResolvedModelUsed, extra.OriginalModelRequested, chatResp.Model)
	}
	p.dropCapture(requestID)

	if !p.config.storePayloads() {
		answer.Text = ""
	}
	for _, exp := range c.experiments {
		for _, cand := range exp.Candidates {
			if cand.Provider == primary.Provider && strings.EqualFold(cand.Model, primary.Model) {
				continue
			}
			j := &job{
				requestID:  requestID,
				experiment: exp.Name,
				snapshot:   c.snapshot,
				prompt:     c.prompt,
				stream:     c.stream,
				primary:    primary,
				candidate:  cand,
				answer:     answer,
				usage:      cloneUsage(usage),
				latencyMs:  extra.Latency,
				enqueuedAt: p.now(),
			}
			select {
			case p.queue <- j:
				p.enqueued.Add(1)
			default:
				p.dropped.Add(1)
			}
		}
	}
	return resp, bifrostErr, nil
}

// accumulate folds one stream chunk into the capture. Caller holds c.mu.
func (c *capture) accumulate(chunk *schemas.BifrostChatResponse) {
	if chunk.Usage != nil {
		c.usage = cloneUsage(chunk.Usage)
	}
	for _, choice := range chunk.Choices {
		if choice.Index != 0 {
			continue
		}
		if choice.FinishReason != nil && *choice.FinishReason != "" {
			c.finishReason = *choice.FinishReason
		}
		if choice.ChatStreamResponseChoice == nil || choice.ChatStreamResponseChoice.Delta == nil {
			// Some providers deliver the final message in non-stream shape.
			if choice.ChatNonStreamResponseChoice != nil && choice.ChatNonStreamResponseChoice.Message != nil && c.text.Len() == 0 {
				c.text.WriteString(messageText(choice.ChatNonStreamResponseChoice.Message.Content))
			}
			continue
		}
		delta := choice.ChatStreamResponseChoice.Delta
		if delta.Content != nil && c.text.Len() < maxAccumulatedChars {
			c.text.WriteString(*delta.Content)
		}
		for _, tc := range delta.ToolCalls {
			if c.toolCalls == nil {
				c.toolCalls = make(map[uint16]*ToolCall)
			}
			call, ok := c.toolCalls[tc.Index]
			if !ok {
				call = &ToolCall{}
				c.toolCalls[tc.Index] = call
				c.toolOrder = append(c.toolOrder, tc.Index)
			}
			if tc.Function.Name != nil && *tc.Function.Name != "" {
				call.Name = *tc.Function.Name
			}
			if len(call.Arguments) < maxAccumulatedChars {
				call.Arguments += tc.Function.Arguments
			}
		}
	}
}

// streamAnswer returns the accumulated stream as an Answer. Caller holds c.mu.
func (c *capture) streamAnswer() Answer {
	a := Answer{Text: c.text.String(), FinishReason: c.finishReason}
	for _, idx := range c.toolOrder {
		a.ToolCalls = append(a.ToolCalls, *c.toolCalls[idx])
	}
	return a
}

func (p *Plugin) dropCapture(requestID string) {
	if _, loaded := p.captures.LoadAndDelete(requestID); loaded {
		p.active.Add(-1)
	}
}

// janitor drops captures whose post-hook never completed.
func (p *Plugin) janitor() {
	defer p.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			cutoff := p.now().Add(-staleCaptureAge)
			p.sweepCaptures(cutoff)
			p.sweepMarks(cutoff)
		}
	}
}

func (p *Plugin) sweepCaptures(cutoff time.Time) int {
	removed := 0
	p.captures.Range(func(key, value any) bool {
		if value.(*capture).createdAt.Before(cutoff) {
			p.dropCapture(key.(string))
			removed++
		}
		return true
	})
	return removed
}

// sweepMarks forgets sampled markers whose response-headers hook never ran
// (Go SDK callers, or requests that failed before headers were written).
func (p *Plugin) sweepMarks(cutoff time.Time) int {
	removed := 0
	p.marks.Range(func(key, value any) bool {
		if value.(time.Time).Before(cutoff) {
			if _, ok := p.marks.LoadAndDelete(key); ok {
				p.marked.Add(-1)
				removed++
			}
		}
		return true
	})
	return removed
}

// virtualKeyAllowed applies the virtual_keys allow-list.
func (p *Plugin) virtualKeyAllowed(ctx *schemas.BifrostContext) bool {
	if len(p.config.VirtualKeys) == 0 {
		return true
	}
	candidates := []any{
		ctx.Value(schemas.BifrostContextKeyGovernanceVirtualKeyID),
		ctx.Value(schemas.BifrostContextKeyGovernanceVirtualKeyName),
		ctx.Value(schemas.BifrostContextKeyVirtualKey),
	}
	for _, c := range candidates {
		s, _ := c.(string)
		if s == "" {
			continue
		}
		for _, allowed := range p.config.VirtualKeys {
			if s == allowed {
				return true
			}
		}
	}
	return false
}

func (p *Plugin) recordTraffic(experiment string) {
	now := p.now()
	p.trafficMu.Lock()
	t, ok := p.traffic[experiment]
	if !ok {
		t = &trafficCounter{first: now}
		p.traffic[experiment] = t
	}
	t.count++
	t.last = now
	p.trafficMu.Unlock()
}

// trafficRate returns eligible requests per second observed for an experiment.
// A window shorter than a minute is treated as a minute so a burst of test
// traffic does not project an absurd monthly volume.
func (p *Plugin) trafficRate(experiment string) float64 {
	p.trafficMu.Lock()
	defer p.trafficMu.Unlock()
	t, ok := p.traffic[experiment]
	if !ok || t.count == 0 {
		return 0
	}
	window := p.now().Sub(t.first).Seconds()
	if window < 60 {
		window = 60
	}
	return float64(t.count) / window
}

// --- budget ---

func (p *Plugin) today() string { return p.now().UTC().Format("2006-01-02") }

// budgetExhausted reports whether today's shadow spend reached the daily budget.
func (p *Plugin) budgetExhausted() bool {
	if p.config.DailyBudgetUSD <= 0 {
		return false
	}
	p.spendMu.Lock()
	defer p.spendMu.Unlock()
	if p.spendDay != p.today() {
		return false
	}
	return p.spentUSD >= p.config.DailyBudgetUSD
}

func (p *Plugin) addSpend(usd float64) {
	if usd <= 0 {
		return
	}
	p.spendMu.Lock()
	defer p.spendMu.Unlock()
	if day := p.today(); p.spendDay != day {
		p.spendDay = day
		p.spentUSD = 0
	}
	p.spentUSD += usd
}

func (p *Plugin) spendToday() float64 {
	p.spendMu.Lock()
	defer p.spendMu.Unlock()
	if p.spendDay != p.today() {
		return 0
	}
	return p.spentUSD
}

// cost prices usage, preferring configured overrides over the catalog.
func (p *Plugin) cost(usage *schemas.BifrostLLMUsage, provider schemas.ModelProvider, model string, requestType schemas.RequestType) float64 {
	if usage == nil {
		return 0
	}
	if price, ok := p.config.Pricing[string(provider)+"/"+model]; ok {
		return manualCost(usage, price)
	}
	if price, ok := p.config.Pricing[model]; ok {
		return manualCost(usage, price)
	}
	if ex := p.execs.Load(); ex != nil && ex.price != nil {
		return ex.price(usage, provider, model, requestType)
	}
	return 0
}

func manualCost(usage *schemas.BifrostLLMUsage, price ModelPrice) float64 {
	return float64(usage.PromptTokens)*price.InputPerMillion/1e6 + float64(usage.CompletionTokens)*price.OutputPerMillion/1e6
}

// --- helpers ---

// snapshotChatRequest serializes the parts of a chat request a candidate needs.
// Fallbacks and the raw body are dropped: the candidate is called directly.
func snapshotChatRequest(req *schemas.BifrostChatRequest) ([]byte, error) {
	return json.Marshal(&schemas.BifrostChatRequest{
		Provider: req.Provider,
		Model:    req.Model,
		Input:    req.Input,
		Params:   req.Params,
	})
}

// lastUserTurn returns the text of the most recent user message.
func lastUserTurn(messages []schemas.ChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == schemas.ChatMessageRoleUser {
			return messageText(messages[i].Content)
		}
	}
	return ""
}

func cloneUsage(u *schemas.BifrostLLMUsage) *schemas.BifrostLLMUsage {
	if u == nil {
		return nil
	}
	// Shallow copy: nested detail structs (cached-token counts) are immutable
	// once a response is built and are needed for accurate pricing.
	cp := *u
	return &cp
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
