package shadow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

// Rollout actions recorded in the rollout log.
const (
	RolloutPromote      = "promote"       // a canary rule was created or its weight changed
	RolloutRollback     = "rollback"      // an operator removed the candidate from its canary rule
	RolloutAutoRollback = "auto_rollback" // the canary guard removed it
)

// Canary health states.
const (
	CanaryWatching  = "watching"  // too few candidate requests to judge yet
	CanaryHealthy   = "healthy"   // within every guard limit
	CanaryUnhealthy = "unhealthy" // a guard limit is breached (rolled back when auto_rollback is on)
)

// Canary guard defaults.
const (
	DefaultCanaryMinRequests   = 20
	DefaultCanaryCheckInterval = 5 * time.Second
	canaryLatencyWindow        = 512 // latency samples kept per target
	maxRolloutEvents           = 500
)

// CanaryConfig configures the canary guard: live health monitoring of promoted
// candidates and, when enabled, automatic rollback.
type CanaryConfig struct {
	// AutoRollback removes a candidate from its canary rule when a guard limit is breached.
	AutoRollback bool `json:"auto_rollback,omitempty"`
	// MinRequests is the number of live candidate requests needed before health is judged.
	MinRequests int `json:"min_requests,omitempty"`
	// MaxErrorRate is the live error rate the candidate may reach (default:
	// thresholds.max_error_rate; an explicit 0 is kept). The guard fires when the
	// 95% Wilson lower bound of the candidate's live error rate passes it, so a
	// single failure among a few requests does not roll a canary back. The limit
	// is never below the source model's own error rate on the same traffic.
	MaxErrorRate *float64 `json:"max_error_rate,omitempty"`
	// MaxLatencyRatio limits candidate p95 latency to this multiple of the source's p95 (0 = off).
	MaxLatencyRatio float64 `json:"max_latency_ratio,omitempty"`
	// RollbackOnNotReady also rolls back when continued shadow evaluation turns the
	// candidate's verdict to not_ready (default true).
	RollbackOnNotReady *bool `json:"rollback_on_not_ready,omitempty"`
}

func (c *CanaryConfig) normalize(t *Thresholds) error {
	if c.MinRequests < 0 || c.MaxLatencyRatio < 0 || (c.MaxErrorRate != nil && (*c.MaxErrorRate < 0 || *c.MaxErrorRate > 1)) {
		return errors.New("shadow: canary limits must be non-negative and max_error_rate at most 1")
	}
	if c.MinRequests == 0 {
		c.MinRequests = DefaultCanaryMinRequests
	}
	if c.MaxErrorRate == nil {
		rate := t.MaxErrorRate
		c.MaxErrorRate = &rate
	}
	if c.RollbackOnNotReady == nil {
		on := true
		c.RollbackOnNotReady = &on
	}
	return nil
}

// RolloutEvent is one entry in the rollout log: who moved traffic, why, and
// the evidence the decision rested on.
type RolloutEvent struct {
	ID         string    `json:"id"`
	At         time.Time `json:"at"`
	Action     string    `json:"action"`
	Experiment string    `json:"experiment"`
	Source     ModelRef  `json:"source"`
	Candidate  ModelRef  `json:"candidate"`
	// Weight is the candidate's share of source traffic after the action (0 after a rollback).
	Weight   float64 `json:"weight"`
	RuleID   string  `json:"rule_id,omitempty"`
	RuleName string  `json:"rule_name,omitempty"`
	// Override marks a promotion of a candidate whose verdict was not "ready".
	Override bool `json:"override,omitempty"`
	// Reason is the operator's override or rollback reason, or the guard's finding.
	Reason string `json:"reason,omitempty"`
	// Actor is "api" for operator actions and "canary_guard" for automatic ones.
	Actor string `json:"actor"`
	// Evidence is the candidate's scorecard at the time of the action.
	Evidence *PairSummary `json:"evidence,omitempty"`
	// Health is the canary's live health at the time of a rollback.
	Health *CanaryHealth `json:"health,omitempty"`
}

// TargetHealth is live traffic served by one target of a canary rule.
type TargetHealth struct {
	Requests  int64   `json:"requests"`
	Errors    int64   `json:"errors"`
	ErrorRate float64 `json:"error_rate"`
	P50Ms     float64 `json:"p50_ms"`
	P95Ms     float64 `json:"p95_ms"`
}

// CanaryHealth compares the candidate with the source on live canary traffic.
type CanaryHealth struct {
	Status    string       `json:"status"`
	Reason    string       `json:"reason"`
	Source    TargetHealth `json:"source"`
	Candidate TargetHealth `json:"candidate"`
	// Verdict is the candidate's current shadow verdict, which keeps updating from
	// the share of traffic the source still serves.
	Verdict string `json:"verdict,omitempty"`
}

// Canary is an active canary: a candidate receiving a share of live traffic
// through a routing rule created by promotion.
type Canary struct {
	Experiment string    `json:"experiment"`
	Source     ModelRef  `json:"source"`
	Candidate  ModelRef  `json:"candidate"`
	Weight     float64   `json:"weight"`
	RuleID     string    `json:"rule_id"`
	RuleName   string    `json:"rule_name"`
	Since      time.Time `json:"since"`
	// Override marks a canary promoted without a ready verdict. The guard then
	// watches only live health: the verdict was already known and overridden.
	Override bool         `json:"override,omitempty"`
	Health   CanaryHealth `json:"health"`
}

// Rollouts is the payload behind GET /api/shadow/rollouts.
type Rollouts struct {
	AutoRollback bool           `json:"auto_rollback"`
	Canaries     []Canary       `json:"canaries"`
	Events       []RolloutEvent `json:"events"`
}

// RollbackFunc removes a candidate from its canary routing rule. The gateway
// wires it (it owns the routing rules); the canary guard calls it. The gateway
// serializes it with promotions: under that one lock it calls current first
// and, if current reports false (the canary changed since the guard judged it,
// for example an operator ramped or re-promoted it), returns ErrCanaryChanged
// without touching the rule; otherwise it edits the rule and then calls done,
// so the rollout log changes in the same critical section as the rule.
type RollbackFunc func(ctx context.Context, experiment, candidate, reason string, current func() bool, done func() error) error

// ErrCanaryChanged is returned by a RollbackFunc that found the canary changed
// since it was judged; the guard judges it again on its next pass.
var ErrCanaryChanged = errors.New("shadow: canary changed since it was judged")

// targetStats accumulates live traffic for one canary target.
type targetStats struct {
	requests int64
	errors   int64
	lat      []float64 // ring of recent latencies, ms
	next     int
}

func (t *targetStats) observe(latencyMs int64, failed bool) {
	t.requests++
	if failed {
		t.errors++
		return
	}
	if latencyMs <= 0 {
		return
	}
	if len(t.lat) < canaryLatencyWindow {
		t.lat = append(t.lat, float64(latencyMs))
		return
	}
	t.lat[t.next] = float64(latencyMs)
	t.next = (t.next + 1) % canaryLatencyWindow
}

func (t *targetStats) health() TargetHealth {
	h := TargetHealth{Requests: t.requests, Errors: t.errors, P50Ms: percentile(t.lat, 50), P95Ms: percentile(t.lat, 95)}
	if t.requests > 0 {
		h.ErrorRate = float64(t.errors) / float64(t.requests)
	}
	return h
}

// canaryState is an active canary and its live statistics.
type canaryState struct {
	Canary
	mu          sync.Mutex
	source      targetStats
	candidate   targetStats
	rollingBack atomic.Bool
}

func (c *canaryState) key() string { return c.Experiment + "\x00" + c.Candidate.String() }

// observe counts one live response to a source-model request.
func (c *canaryState) observe(served ModelRef, latencyMs int64, failed bool) {
	var t *targetStats
	switch {
	case sameModel(served, c.Candidate):
		t = &c.candidate
	case sameModel(served, c.Source):
		t = &c.source
	default:
		return // a fallback or another rule served it
	}
	c.mu.Lock()
	t.observe(latencyMs, failed)
	c.mu.Unlock()
}

func sameModel(a, b ModelRef) bool {
	return strings.EqualFold(a.Model, b.Model) && (a.Provider == "" || b.Provider == "" || a.Provider == b.Provider)
}

// rolloutBook is the rollout log and the set of active canaries. Like the spend
// ledger it is shared per process and persist path, so canaries stay watched
// across plugin reloads, and with a persist path it is saved to
// <persist_path>.rollouts.json.
type rolloutBook struct {
	mu       sync.Mutex
	events   []RolloutEvent
	canaries map[string]*canaryState
	path     string
	// active is a lock-free snapshot of canaries for the request path.
	active atomic.Pointer[[]*canaryState]
}

type rolloutFile struct {
	Events   []RolloutEvent `json:"events"`
	Canaries []Canary       `json:"canaries"`
}

var (
	booksMu sync.Mutex
	books   = map[string]*rolloutBook{}
)

// bookFor returns the process's rollout book for a persist path.
func bookFor(persistPath string) (*rolloutBook, error) {
	key := ledgerKey(persistPath)
	booksMu.Lock()
	defer booksMu.Unlock()
	if b, ok := books[key]; ok {
		return b, nil
	}
	b := &rolloutBook{canaries: map[string]*canaryState{}}
	if persistPath != "" {
		b.path = persistPath + ".rollouts.json"
		if err := b.load(); err != nil {
			return nil, err
		}
	}
	b.publishLocked()
	books[key] = b
	return b, nil
}

func (b *rolloutBook) load() error {
	data, err := os.ReadFile(b.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("shadow: read rollout log: %w", err)
	}
	var f rolloutFile
	if err := json.Unmarshal(data, &f); err != nil {
		return fmt.Errorf("shadow: parse rollout log %s: %w", b.path, err)
	}
	b.events = f.Events
	for _, c := range f.Canaries {
		st := &canaryState{Canary: c}
		st.Health = CanaryHealth{}
		b.canaries[st.key()] = st
	}
	return nil
}

// saveLocked writes the book atomically. Caller holds mu.
func (b *rolloutBook) saveLocked() error {
	if b.path == "" {
		return nil
	}
	f := rolloutFile{Events: b.events, Canaries: make([]Canary, 0, len(b.canaries))}
	for _, c := range b.sortedLocked() {
		cp := c.Canary
		cp.Health = CanaryHealth{}
		f.Canaries = append(f.Canaries, cp)
	}
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(b.path), filepath.Base(b.path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("shadow: write rollout log: %w", err)
	}
	_, werr := tmp.Write(data)
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), b.path)
	}
	if werr != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("shadow: write rollout log: %w", werr)
	}
	return nil
}

func (b *rolloutBook) sortedLocked() []*canaryState {
	out := make([]*canaryState, 0, len(b.canaries))
	for _, c := range b.canaries {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key() < out[j].key() })
	return out
}

// publishLocked refreshes the request-path snapshot. Caller holds mu.
func (b *rolloutBook) publishLocked() {
	list := b.sortedLocked()
	if len(list) == 0 {
		b.active.Store(nil)
		return
	}
	b.active.Store(&list)
}

// record appends an event and applies it to the active canaries.
func (b *rolloutBook) record(ev RolloutEvent) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, ev)
	if len(b.events) > maxRolloutEvents {
		b.events = append([]RolloutEvent(nil), b.events[len(b.events)-maxRolloutEvents:]...)
	}
	key := ev.Experiment + "\x00" + ev.Candidate.String()
	switch ev.Action {
	case RolloutPromote:
		if existing, ok := b.canaries[key]; ok {
			// A ramp keeps the live statistics gathered so far.
			existing.mu.Lock()
			existing.Weight, existing.RuleID, existing.RuleName, existing.Override = ev.Weight, ev.RuleID, ev.RuleName, ev.Override
			existing.mu.Unlock()
		} else {
			b.canaries[key] = &canaryState{Canary: Canary{
				Experiment: ev.Experiment,
				Source:     ev.Source,
				Candidate:  ev.Candidate,
				Weight:     ev.Weight,
				RuleID:     ev.RuleID,
				RuleName:   ev.RuleName,
				Since:      ev.At,
				Override:   ev.Override,
			}}
		}
	case RolloutRollback, RolloutAutoRollback:
		delete(b.canaries, key)
	}
	b.publishLocked()
	return b.saveLocked()
}

// lookup returns the active canary for a pair.
func (b *rolloutBook) lookup(experiment, candidate string) *canaryState {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.canaries[experiment+"\x00"+candidate]
}

// --- Plugin API ---

// SetRollbackHook wires the function the canary guard uses to roll back.
func (p *Plugin) SetRollbackHook(fn RollbackFunc) {
	if fn == nil {
		p.rollbackHook.Store(nil)
		return
	}
	p.rollbackHook.Store(&fn)
}

// PairScorecard returns the current scorecard of one experiment/candidate pair.
func (p *Plugin) PairScorecard(experiment, candidate string) (PairSummary, error) {
	if _, _, err := p.lookupPair(experiment, candidate); err != nil {
		return PairSummary{}, err
	}
	for _, s := range summarize(p.store.snapshot(), p.config, p.trafficRate) {
		if s.Experiment == experiment && s.Candidate.String() == candidate {
			return s, nil
		}
	}
	// A configured pair with no records yet.
	exp, cand, _ := p.lookupPair(experiment, candidate)
	s := PairSummary{Experiment: experiment, Source: exp.Source, Candidate: *cand, PassBasisCounts: map[string]int{}}
	s.Verdict, s.VerdictReason = verdictFor(&s, p.config)
	return s, nil
}

// lookupPair finds a configured experiment and candidate.
func (p *Plugin) lookupPair(experiment, candidate string) (*Experiment, *ModelRef, error) {
	for i := range p.config.Experiments {
		exp := &p.config.Experiments[i]
		if exp.Name != experiment {
			continue
		}
		for j := range exp.Candidates {
			if exp.Candidates[j].String() == candidate {
				return exp, &exp.Candidates[j], nil
			}
		}
	}
	return nil, nil, ErrUnknownPair
}

// RecordRollout appends an event to the rollout log. A promotion starts (or
// re-weights) a watched canary; a rollback stops watching it.
func (p *Plugin) RecordRollout(ev RolloutEvent) (RolloutEvent, error) {
	if ev.ID == "" {
		ev.ID = uuid.NewString()
	}
	if ev.At.IsZero() {
		ev.At = p.now()
	}
	if ev.Actor == "" {
		ev.Actor = "api"
	}
	switch ev.Action {
	case RolloutPromote, RolloutRollback, RolloutAutoRollback:
	default:
		return ev, fmt.Errorf("shadow: unknown rollout action %q", ev.Action)
	}
	return ev, p.rollouts.record(ev)
}

// Rollouts returns the active canaries with their live health, and the rollout
// log newest first.
func (p *Plugin) Rollouts() Rollouts {
	out := Rollouts{AutoRollback: p.config.Canary != nil && p.config.Canary.AutoRollback, Canaries: []Canary{}}
	var verdicts map[string]string
	if list := p.rollouts.active.Load(); list != nil {
		verdicts = p.verdictsByPair()
		for _, c := range *list {
			out.Canaries = append(out.Canaries, p.canaryView(c, verdicts))
		}
	}
	p.rollouts.mu.Lock()
	out.Events = make([]RolloutEvent, 0, len(p.rollouts.events))
	for i := len(p.rollouts.events) - 1; i >= 0; i-- {
		out.Events = append(out.Events, p.rollouts.events[i])
	}
	p.rollouts.mu.Unlock()
	return out
}

func (p *Plugin) verdictsByPair() map[string]string {
	m := map[string]string{}
	for _, s := range summarize(p.store.snapshot(), p.config, p.trafficRate) {
		m[s.Experiment+"\x00"+s.Candidate.String()] = s.Verdict
	}
	return m
}

// canaryView snapshots a canary with its evaluated health.
func (p *Plugin) canaryView(c *canaryState, verdicts map[string]string) Canary {
	c.mu.Lock()
	view := c.Canary
	view.Health = CanaryHealth{Source: c.source.health(), Candidate: c.candidate.health()}
	c.mu.Unlock()
	view.Health.Verdict = verdicts[c.key()]
	view.Health.Status, view.Health.Reason = p.judgeCanary(&view.Health, view.Override)
	return view
}

// canaryLimits returns the guard configuration in effect.
func (p *Plugin) canaryLimits() CanaryConfig {
	if p.config.Canary != nil {
		return *p.config.Canary
	}
	on := true
	rate := p.config.Thresholds.MaxErrorRate
	return CanaryConfig{MinRequests: DefaultCanaryMinRequests, MaxErrorRate: &rate, RollbackOnNotReady: &on}
}

// judgeCanary decides a canary's health from its live statistics, and from the
// shadow verdict unless the canary was promoted over that verdict.
func (p *Plugin) judgeCanary(h *CanaryHealth, override bool) (string, string) {
	limits := p.canaryLimits()
	if !override && limits.RollbackOnNotReady != nil && *limits.RollbackOnNotReady && h.Verdict == VerdictNotReady {
		return CanaryUnhealthy, "shadow verdict turned not_ready on continued evaluation"
	}
	if h.Candidate.Requests < int64(limits.MinRequests) {
		return CanaryWatching, fmt.Sprintf("%d of %d live candidate requests observed", h.Candidate.Requests, limits.MinRequests)
	}
	maxErr := *limits.MaxErrorRate
	if h.Source.Requests >= int64(limits.MinRequests) && h.Source.ErrorRate > maxErr {
		// Never blame the candidate for an outage the source shares.
		maxErr = h.Source.ErrorRate
	}
	// Act on evidence, not on one unlucky request: the guard fires when even the
	// 95% Wilson lower bound of the candidate's error rate is over the limit.
	if lower := wilsonLowerBound(int(h.Candidate.Errors), int(h.Candidate.Requests)); lower > maxErr {
		return CanaryUnhealthy, fmt.Sprintf("live error rate %.1f%% (95%% lower bound %.1f%%) exceeds %.1f%%", h.Candidate.ErrorRate*100, lower*100, maxErr*100)
	}
	if limits.MaxLatencyRatio > 0 && h.Source.P95Ms > 0 && h.Candidate.P95Ms > limits.MaxLatencyRatio*h.Source.P95Ms {
		return CanaryUnhealthy, fmt.Sprintf("live p95 latency %.0f ms is over %.1fx the source's %.0f ms", h.Candidate.P95Ms, limits.MaxLatencyRatio, h.Source.P95Ms)
	}
	return CanaryHealthy, fmt.Sprintf("live error rate %.1f%% within %.1f%% over %d requests", h.Candidate.ErrorRate*100, maxErr*100, h.Candidate.Requests)
}

// observeCanaries counts a live response toward the active canary it belongs
// to: a request for a canary's source model, served by the source or the
// candidate. The cost when no canary is active is one atomic load.
func (p *Plugin) observeCanaries(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) {
	list := p.rollouts.active.Load()
	if list == nil {
		return
	}
	var info schemas.RoutingInfo
	var latency int64
	failed := bifrostErr != nil
	switch {
	case failed:
		if rt := bifrostErr.ExtraFields.RequestType; rt != schemas.ChatCompletionRequest && rt != schemas.ChatCompletionStreamRequest {
			return // a failed embedding or Responses call is not canary chat traffic
		}
		info = bifrostErr.ExtraFields.RoutingInfo
	case resp != nil && resp.ChatResponse != nil:
		if resp.ChatResponse.ExtraFields.RequestType == schemas.ChatCompletionStreamRequest && !bifrost.IsFinalChunk(ctx) {
			return // count a stream once, at its final chunk
		}
		info = resp.ChatResponse.ExtraFields.RoutingInfo
		latency = resp.ChatResponse.ExtraFields.Latency
	default:
		return
	}
	requested := ModelRef{Provider: info.RequestedProvider, Model: info.RequestedModel}
	if requested.Model == "" {
		requested = ModelRef{Provider: info.Provider, Model: info.Model}
	}
	served := ModelRef{Provider: info.Provider, Model: info.Model}
	for _, c := range *list {
		if c.Source.matches(requested.Provider, requested.Model) || sameModel(requested, c.Source) {
			c.observe(served, latency, failed)
		}
	}
}

// canaryGuard checks active canaries and rolls back unhealthy ones when
// auto_rollback is on.
func (p *Plugin) canaryGuard() {
	defer p.wg.Done()
	ticker := time.NewTicker(p.canaryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.checkCanaries()
		}
	}
}

// checkCanaries evaluates every active canary once and returns how many it
// rolled back.
func (p *Plugin) checkCanaries() int {
	if p.config.Canary == nil || !p.config.Canary.AutoRollback {
		return 0
	}
	list := p.rollouts.active.Load()
	if list == nil {
		return 0
	}
	hookPtr := p.rollbackHook.Load()
	verdicts := p.verdictsByPair()
	rolled := 0
	for _, c := range *list {
		view := p.canaryView(c, verdicts)
		if view.Health.Status != CanaryUnhealthy {
			continue
		}
		if hookPtr == nil {
			p.logger.Warn("shadow: canary %s -> %s is unhealthy (%s) but no rollback hook is wired", view.Source, view.Candidate, view.Health.Reason)
			continue
		}
		if !c.rollingBack.CompareAndSwap(false, true) {
			continue
		}
		reason := "canary guard: " + view.Health.Reason
		health := view.Health
		current := func() bool {
			// Same canary (a rollback and re-promotion makes a new one) at the
			// same weight and override state as when it was judged.
			if p.rollouts.lookup(view.Experiment, view.Candidate.String()) != c {
				return false
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.Weight == view.Weight && c.Override == view.Override
		}
		done := func() error {
			_, err := p.RecordRollout(RolloutEvent{
				Action:     RolloutAutoRollback,
				Experiment: view.Experiment,
				Source:     view.Source,
				Candidate:  view.Candidate,
				RuleID:     view.RuleID,
				RuleName:   view.RuleName,
				Reason:     reason,
				Actor:      "canary_guard",
				Health:     &health,
			})
			return err
		}
		ctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
		err := (*hookPtr)(ctx, view.Experiment, view.Candidate.String(), reason, current, done)
		cancel()
		if err != nil {
			c.rollingBack.Store(false)
			if errors.Is(err, ErrCanaryChanged) {
				continue
			}
			p.logger.Warn("shadow: automatic rollback of %s failed: %v", view.Candidate, err)
			continue
		}
		p.logger.Info("shadow: rolled back canary %s -> %s: %s", view.Source, view.Candidate, view.Health.Reason)
		rolled++
	}
	return rolled
}
