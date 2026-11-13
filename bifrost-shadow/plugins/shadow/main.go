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
	"errors"
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

// ShadowHeader lets a caller control mirroring per request: "off" never mirrors
// the request; "force" always mirrors it (budget still applies), but only when
// the operator sets allow_force_header, and is otherwise ignored.
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

// contextKeyCaptureToken carries the token (uint64) of the capture this request
// owns. Request IDs are caller-supplied, so the ID alone cannot tell a retried
// attempt of this request from another in-flight request that reuses its ID.
const contextKeyCaptureToken schemas.BifrostContextKey = "bf-shadow-capture"

// mcpAddedConnectToolsKey mirrors core/mcp's unexported addedConnectToolsKey: the
// names of the per-user "<client>-connect" tools MCP injected into a request.
const mcpAddedConnectToolsKey schemas.BifrostContextKey = "bifrost-mcp-added-connect-tools"

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
	mu               sync.Mutex
	token            uint64 // matches contextKeyCaptureToken on the owning request's context
	createdAt        time.Time
	experiments      []*Experiment
	snapshot         []byte // chatSnapshot JSON of the primary request, decoded fresh per job
	passthroughExtra bool   // the caller opted into sending ExtraParams to the provider
	prompt           string
	stream           bool

	// Stream accumulation.
	text         strings.Builder
	refusal      strings.Builder
	toolCalls    map[uint16]*ToolCall
	toolOrder    []uint16
	finishReason string
	usage        *schemas.BifrostLLMUsage
}

// job is one candidate call to run in the background.
type job struct {
	requestID        string
	experiment       string
	snapshot         []byte
	passthroughExtra bool
	prompt           string
	stream           bool
	primary          ModelRef
	candidate        ModelRef
	answer           Answer
	usage            *schemas.BifrostLLMUsage
	latencyMs        int64
	enqueuedAt       time.Time
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

// trafficSlot counts one experiment's eligible requests for the projected-savings
// rate, with atomics so concurrent requests never serialize on a lock. A slot
// belongs to one collection window, named by the startedAt value it was opened
// under; Reset moves startedAt on, and the next request (or read) that sees the
// stale window zeroes the slot first.
type trafficSlot struct {
	window atomic.Int64 // startedAt (unix ns) of the window this slot counts
	count  atomic.Int64 // eligible requests in the window
	first  atomic.Int64 // unix ns of the window's first eligible request; 0 until one arrives
	_      [40]byte     // pad to a cache line: each experiment's slot is written by every core
}

// Plugin is the shadow traffic plugin.
type Plugin struct {
	config *Config
	logger schemas.Logger
	store  *store
	// storeRecord inserts a finished record; it is store.add, swappable in tests.
	storeRecord func(*Record) error

	execs atomic.Pointer[executors]

	captures   sync.Map     // requestID -> *capture; at most one in-flight request owns an ID
	active     atomic.Int64 // entries in captures: counted on insert, uncounted on removal
	captureSeq atomic.Uint64

	// marks remembers sampled request IDs until the response-headers hook runs;
	// the gateway runs LLM hooks on a child context, so a context value set in
	// PreLLMHook is not visible there.
	marks  sync.Map // requestID -> time.Time
	marked atomic.Int64

	queue  chan *job
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	startedAt atomic.Int64 // unix nanoseconds; plugin start or last reset

	eligible      atomic.Int64
	sampled       atomic.Int64
	enqueued      atomic.Int64
	dropped       atomic.Int64
	budgetSkipped atomic.Int64
	completed     atomic.Int64
	candidateErrs atomic.Int64
	inFlight      atomic.Int64

	// ledger holds today's spend; it is shared with later instances of the plugin
	// (see spendLedger), so reloading the plugin never lifts the daily budget.
	ledger *spendLedger
	// rollouts holds the rollout log and active canaries, shared the same way.
	rollouts       *rolloutBook
	rollbackHook   atomic.Pointer[RollbackFunc]
	canaryInterval time.Duration

	trafficSlots []trafficSlot // one per config.Experiments entry, same order
	// trafficMu serializes the rare rollover of a traffic slot to a new window.
	trafficMu sync.Mutex

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
	ledger, created, err := ledgerFor(config.PersistPath)
	if err != nil {
		_ = st.close()
		return nil, err
	}
	if created && !ledger.loaded && config.PersistPath != "" {
		// Records persisted before the ledger existed still count against today.
		day := time.Now().UTC().Format(time.DateOnly)
		ledger.seed(day, todaysRecordSpend(st.snapshot(), day))
	}
	book, err := bookFor(config.PersistPath)
	if err != nil {
		_ = st.close()
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
		config:         config,
		logger:         logger,
		store:          st,
		ledger:         ledger,
		rollouts:       book,
		canaryInterval: DefaultCanaryCheckInterval,
		queue:          make(chan *job, config.QueueSize),
		ctx:            workerCtx,
		cancel:         cancel,
		trafficSlots:   make([]trafficSlot, len(config.Experiments)),
		randFloat:      rand.Float64,
		now:            time.Now,
	}
	p.storeRecord = st.add
	p.startedAt.Store(p.now().UnixNano())
	for i := range p.trafficSlots {
		p.trafficSlots[i].window.Store(p.startedAt.Load())
	}
	for i := 0; i < config.MaxConcurrency; i++ {
		p.wg.Add(1)
		go p.worker()
	}
	p.wg.Add(2)
	go p.janitor()
	go p.canaryGuard()
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
		// Shadow calls skip governance, so a caller-controlled force would be
		// unbilled spend on demand. Without the opt-in the request is sampled
		// as if it carried no header.
		if p.config.AllowForceHeader {
			ctx.SetValue(contextKeyMode, shadowModeForce)
		}
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
// Cost for requests that are not sampled: a type check, a context read, one
// experiment match per configured experiment and two atomic adds per matching
// experiment (plus one capture-map lookup while any sampled request is in
// flight) — no allocation and no lock.
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
	// A retried attempt must not inherit its previous attempt's capture, and must
	// never take over the capture of another in-flight request that shares the ID.
	slotTaken := p.active.Load() > 0 && !p.claimSlot(ctx, requestID)

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
		p.recordTraffic(i)
		if mode == shadowModeForce || p.randFloat() < p.config.experimentSampleRate(exp) {
			sampledExps = append(sampledExps, exp)
		}
	}
	if len(sampledExps) == 0 || slotTaken {
		return req, nil, nil
	}
	if p.budgetExhausted() {
		p.budgetSkipped.Add(1)
		return req, nil, nil
	}
	snapshot, err := snapshotChatRequest(chat, mcpInjectedTools(ctx))
	if err != nil {
		return req, nil, fmt.Errorf("shadow: snapshot request: %w", err)
	}
	passthrough, _ := ctx.Value(schemas.BifrostContextKeyPassthroughExtraParams).(bool)
	c := &capture{
		token:            p.captureSeq.Add(1),
		createdAt:        p.now(),
		experiments:      sampledExps,
		snapshot:         snapshot,
		passthroughExtra: passthrough,
		stream:           req.RequestType == schemas.ChatCompletionStreamRequest,
	}
	if p.config.storePayloads() {
		c.prompt = truncate(lastUserTurn(chat.Input), p.config.MaxPayloadChars)
	}
	if _, loaded := p.captures.LoadOrStore(requestID, c); loaded {
		// A concurrent request with the same ID claimed the slot first.
		return req, nil, nil
	}
	p.active.Add(1)
	ctx.SetValue(contextKeyCaptureToken, c.token)
	p.sampled.Add(1)
	if _, loaded := p.marks.LoadOrStore(requestID, c.createdAt); !loaded {
		p.marked.Add(1)
	}
	return req, nil, nil
}

// claimSlot reports whether requestID's capture slot is free for the request on
// ctx. A capture left by an earlier attempt of this same request (its token is
// on ctx) is released; one owned by a different in-flight request is kept, and
// the slot is reported taken.
func (p *Plugin) claimSlot(ctx *schemas.BifrostContext, requestID string) bool {
	v, ok := p.captures.Load(requestID)
	if !ok {
		return true
	}
	c := v.(*capture)
	if !p.owns(ctx, c) {
		return false
	}
	p.removeCapture(requestID, c)
	return true
}

// owns reports whether c was created by the request on ctx.
func (p *Plugin) owns(ctx *schemas.BifrostContext, c *capture) bool {
	token, _ := ctx.Value(contextKeyCaptureToken).(uint64)
	return token != 0 && token == c.token
}

// PostLLMHook collects the primary answer (accumulating stream chunks) and,
// once it is complete, enqueues one shadow job per candidate.
func (p *Plugin) PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	p.observeCanaries(ctx, resp, bifrostErr)
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
	if !p.owns(ctx, c) {
		// Another in-flight request reused this caller-supplied ID and owns the capture.
		return resp, bifrostErr, nil
	}
	if bifrostErr != nil || resp == nil || resp.ChatResponse == nil {
		// A failed primary has nothing to compare against.
		p.removeCapture(requestID, c)
		return resp, bifrostErr, nil
	}
	chatResp := resp.ChatResponse
	extra := &chatResp.ExtraFields
	if extra.CacheDebug != nil && extra.CacheDebug.CacheHit {
		// Cache replays have no real primary latency or cost to compare.
		p.removeCapture(requestID, c)
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
	p.removeCapture(requestID, c)

	// The job always carries the full answer: it is what the candidate is scored
	// against. store_payloads only decides what the stored record keeps (runJob).
	for _, exp := range c.experiments {
		for _, cand := range exp.Candidates {
			if cand.Provider == primary.Provider && strings.EqualFold(cand.Model, primary.Model) {
				continue
			}
			j := &job{
				requestID:        requestID,
				experiment:       exp.Name,
				snapshot:         c.snapshot,
				passthroughExtra: c.passthroughExtra,
				prompt:           c.prompt,
				stream:           c.stream,
				primary:          primary,
				candidate:        cand,
				answer:           answer,
				usage:            cloneUsage(usage),
				latencyMs:        extra.Latency,
				enqueuedAt:       p.now(),
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
				msg := choice.ChatNonStreamResponseChoice.Message
				c.text.WriteString(messageText(msg.Content))
				if msg.ChatAssistantMessage != nil && msg.ChatAssistantMessage.Refusal != nil && c.refusal.Len() == 0 {
					c.refusal.WriteString(*msg.ChatAssistantMessage.Refusal)
				}
			}
			continue
		}
		delta := choice.ChatStreamResponseChoice.Delta
		if delta.Content != nil && c.text.Len() < maxAccumulatedChars {
			c.text.WriteString(*delta.Content)
		}
		if delta.Refusal != nil && c.refusal.Len() < maxAccumulatedChars {
			c.refusal.WriteString(*delta.Refusal)
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

// streamAnswer returns the accumulated stream as an Answer. A refusal is the
// answer when there is no content, as answerFromChatResponse does for unary
// responses. Caller holds c.mu.
func (c *capture) streamAnswer() Answer {
	a := Answer{Text: c.text.String(), FinishReason: c.finishReason}
	if a.Text == "" {
		a.Text = c.refusal.String()
	}
	for _, idx := range c.toolOrder {
		a.ToolCalls = append(a.ToolCalls, *c.toolCalls[idx])
	}
	return a
}

// removeCapture deletes c from the map if it is still the entry for requestID,
// keeping active equal to the number of entries.
func (p *Plugin) removeCapture(requestID string, c *capture) {
	if p.captures.CompareAndDelete(requestID, c) {
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
		c := value.(*capture)
		if c.createdAt.Before(cutoff) && p.captures.CompareAndDelete(key, c) {
			p.active.Add(-1)
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

// recordTraffic counts one eligible request for config.Experiments[i]. It is on
// the request path for every eligible request, sampled or not: two atomic loads
// and an atomic add, plus a clock read only for a window's first request.
func (p *Plugin) recordTraffic(i int) {
	s := &p.trafficSlots[i]
	if window := p.startedAt.Load(); s.window.Load() != window {
		p.rollTraffic(s, window)
	}
	s.count.Add(1)
	if s.first.Load() == 0 {
		s.first.CompareAndSwap(0, p.now().UnixNano())
	}
}

// rollTraffic zeroes a slot that still counts a window Reset has closed. A
// request racing the rollover may land in either window; the rate is an estimate.
func (p *Plugin) rollTraffic(s *trafficSlot, window int64) {
	p.trafficMu.Lock()
	defer p.trafficMu.Unlock()
	if s.window.Load() == window {
		return
	}
	s.count.Store(0)
	s.first.Store(0)
	s.window.Store(window)
}

// trafficRate returns eligible requests per second observed for an experiment
// since its first eligible request in the current window. A window shorter than
// a minute is treated as a minute so a burst of test traffic does not project
// an absurd monthly volume.
func (p *Plugin) trafficRate(experiment string) float64 {
	for i := range p.config.Experiments {
		if p.config.Experiments[i].Name != experiment {
			continue
		}
		s := &p.trafficSlots[i]
		if s.window.Load() != p.startedAt.Load() {
			return 0 // nothing counted since the last Reset
		}
		count, first := s.count.Load(), s.first.Load()
		if count == 0 || first == 0 {
			return 0
		}
		window := p.now().Sub(time.Unix(0, first)).Seconds()
		if window < 60 {
			window = 60
		}
		return float64(count) / window
	}
	return 0
}

// --- budget ---

func (p *Plugin) today() string { return p.now().UTC().Format(time.DateOnly) }

// budgetExhausted reports whether today's spent plus in-flight shadow spend
// reached the daily budget.
func (p *Plugin) budgetExhausted() bool {
	return p.ledger.exhausted(p.today(), p.config.DailyBudgetUSD)
}

// addSpend records what a finished job cost.
func (p *Plugin) addSpend(usd float64) {
	if err := p.ledger.add(p.today(), usd); err != nil {
		p.logger.Warn("shadow: %v", err)
	}
}

// spendToday returns today's settled shadow spend.
func (p *Plugin) spendToday() float64 {
	spent, _ := p.ledger.totals(p.today())
	return spent
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

// codeModeToolNames are the meta-tools core/mcp adds for code-mode clients
// (mcp.ToolTypeListToolFiles and friends). They are not on the MCP-added list,
// so they are recognised by name, and only on a request MCP touched.
var codeModeToolNames = map[string]struct{}{
	"listToolFiles":   {},
	"readToolFile":    {},
	"getToolDocs":     {},
	"executeToolCode": {},
}

// mcpInjectedTools returns the names of the tools MCP added to this request:
// its clients' tools, the per-user connect tools and, when any client tool was
// added, the code-mode meta-tools. It returns nil when MCP added nothing, so a
// caller's own tools are never dropped.
func mcpInjectedTools(ctx *schemas.BifrostContext) map[string]struct{} {
	added, _ := ctx.Value(schemas.BifrostContextKeyMCPAddedTools).([]string)
	connect, _ := ctx.Value(mcpAddedConnectToolsKey).([]string)
	if len(added) == 0 && len(connect) == 0 {
		return nil
	}
	names := make(map[string]struct{}, len(added)+len(connect)+len(codeModeToolNames))
	for _, n := range added {
		names[n] = struct{}{}
	}
	for _, n := range connect {
		names[n] = struct{}{}
	}
	if len(added) > 0 {
		for n := range codeModeToolNames {
			names[n] = struct{}{}
		}
	}
	return names
}

// chatSnapshot is a sampled request as stored for its candidates. ExtraParams is
// tagged json:"-" on ChatParameters, so it is carried beside the request.
type chatSnapshot struct {
	Request     *schemas.BifrostChatRequest `json:"request"`
	ExtraParams map[string]any              `json:"extra_params,omitempty"`
}

// snapshotChatRequest serializes the parts of a chat request a candidate needs.
// Fallbacks and the raw body are dropped: the candidate is called directly. Tools
// named in exclude were injected by MCP: a candidate call is internal and cannot
// run them, so they go, and with them the tool choice when no tool is left. The
// live request is never modified.
func snapshotChatRequest(req *schemas.BifrostChatRequest, exclude map[string]struct{}) ([]byte, error) {
	snap := chatSnapshot{Request: &schemas.BifrostChatRequest{
		Provider: req.Provider,
		Model:    req.Model,
		Input:    req.Input,
		Params:   req.Params,
	}}
	if req.Params != nil {
		snap.ExtraParams = req.Params.ExtraParams
		if len(exclude) > 0 && len(req.Params.Tools) > 0 {
			params := *req.Params
			params.Tools = make([]schemas.ChatTool, 0, len(req.Params.Tools))
			for _, tool := range req.Params.Tools {
				if tool.Function != nil {
					if _, injected := exclude[tool.Function.Name]; injected {
						continue
					}
				}
				params.Tools = append(params.Tools, tool)
			}
			if len(params.Tools) == 0 {
				params.Tools = nil
				params.ToolChoice = nil
				params.ParallelToolCalls = nil
			}
			snap.Request.Params = &params
		}
	}
	return json.Marshal(&snap)
}

// decodeSnapshot restores a request stored by snapshotChatRequest.
func decodeSnapshot(data []byte) (*schemas.BifrostChatRequest, error) {
	var snap chatSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, err
	}
	if snap.Request == nil {
		return nil, errors.New("empty request snapshot")
	}
	if len(snap.ExtraParams) > 0 {
		if snap.Request.Params == nil {
			snap.Request.Params = &schemas.ChatParameters{}
		}
		snap.Request.Params.ExtraParams = snap.ExtraParams
	}
	return snap.Request, nil
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
