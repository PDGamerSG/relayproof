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
	// RolloutRamp: the canary guard moved a ramping canary to its next step.
	RolloutRamp = "ramp"
	// RolloutRampComplete: the canary guard moved a ramping canary to its last
	// step. It replaces the ramp event for that step; the ramp is then done.
	RolloutRampComplete = "ramp_complete"
)

// Ramp limits and defaults.
const (
	DefaultRampHoldSeconds = 60
	MaxRampHoldSeconds     = 7 * 24 * 60 * 60
	MaxRampSteps           = 20
)

// ErrInvalidRamp wraps every reason a promotion's ramp is refused.
var ErrInvalidRamp = errors.New("shadow: invalid ramp")

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
	// Health is the canary's live health at the time of a rollback or a ramp step.
	Health *CanaryHealth `json:"health,omitempty"`
	// Ramp is the canary's ramp after the action: the plan on a promotion that
	// starts one, the new step on ramp and ramp_complete events.
	Ramp *CanaryRamp `json:"ramp,omitempty"`
}

// RampRequest is the optional ramp of a promotion: the weights the canary
// guard moves the canary through, and what each step has to show first.
type RampRequest struct {
	// Steps are the candidate's successive shares of source traffic: strictly
	// ascending, each from MinCanaryWeight to 1, 2 to MaxRampSteps of them. The
	// first is the promoted weight.
	Steps []float64 `json:"steps"`
	// MinRequests is how many live candidate requests a step must serve before
	// the guard moves on. Default and minimum: canary.min_requests.
	MinRequests *int `json:"min_requests,omitempty"`
	// HoldSeconds is the minimum time at each step (default
	// DefaultRampHoldSeconds, at most MaxRampHoldSeconds).
	HoldSeconds *int `json:"hold_seconds,omitempty"`
}

// CanaryRamp is a canary's progressive ramp: the weights it moves through and
// the step it is at. The guard moves it to the next step once the current one
// has served MinRequests candidate requests, HoldSeconds have passed and the
// canary is healthy; live statistics restart at every step, so each step is
// judged on its own traffic. Values are never changed in place: a new step is
// a new CanaryRamp.
type CanaryRamp struct {
	Steps []float64 `json:"steps"`
	// CurrentStep indexes Steps: the weight the canary serves now.
	CurrentStep int `json:"current_step"`
	// StepStartedAt is when the canary reached the current step.
	StepStartedAt time.Time `json:"step_started_at"`
	// StepRequests counts live candidate requests at the current step. It is
	// filled in live views only and restarts with the process.
	StepRequests int64 `json:"step_requests"`
	MinRequests  int   `json:"min_requests"`
	HoldSeconds  int   `json:"hold_seconds"`
	// NextWeight is the next step's weight; absent once the ramp is complete.
	NextWeight float64 `json:"next_weight,omitempty"`
	// Completed is set when the canary reached the last step. The guard keeps
	// watching it (and rolls it back if it turns unhealthy) but moves it no further.
	Completed bool `json:"completed"`
	// Reason says what the ramp is waiting for. Live views only.
	Reason string `json:"reason,omitempty"`

	// blocked is why the gateway refused to move this step on, set on live
	// views only (see canaryState.stuck).
	blocked string
}

func (r *CanaryRamp) clone() *CanaryRamp {
	if r == nil {
		return nil
	}
	cp := *r
	cp.Steps = append([]float64(nil), r.Steps...)
	return &cp
}

// valid reports whether the ramp can be indexed safely.
func (r *CanaryRamp) valid() bool {
	return len(r.Steps) >= 2 && r.CurrentStep >= 0 && r.CurrentStep < len(r.Steps)
}

// settle derives Completed and NextWeight from the current step.
func (r *CanaryRamp) settle() {
	r.Completed = r.CurrentStep >= len(r.Steps)-1
	r.NextWeight = 0
	if !r.Completed {
		r.NextWeight = r.Steps[r.CurrentStep+1]
	}
}

// stepLabel names the current step for reasons and logs: "step 2 of 4 (25%)".
func (r *CanaryRamp) stepLabel() string {
	return fmt.Sprintf("step %d of %d (%s)", r.CurrentStep+1, len(r.Steps), pct(r.Steps[r.CurrentStep]))
}

func pct(share float64) string { return fmt.Sprintf("%g%%", round4(share*100)) }

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
	// Ramp is set when the canary was promoted with a ramp: the guard then
	// raises its weight step by step while it stays healthy.
	Ramp *CanaryRamp `json:"ramp,omitempty"`
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

// RampFunc moves a ramping canary to its next step: it sets the candidate's
// share of source traffic to weight in the source's existing canary routing
// rule, merging it the way promotion does. The gateway wires it, like
// RollbackFunc, and serializes it with promotions: under that one lock it calls
// current first and, if current reports false, returns ErrCanaryChanged
// without touching the rule; otherwise it edits the rule and then calls done
// with the rule's ID and name, so the rollout log changes in the same critical
// section as the rule. It never creates a rule: with the canary rule gone it
// returns an error and the ramp holds.
type RampFunc func(ctx context.Context, experiment, candidate string, weight float64, current func() bool, done func(ruleID, ruleName string) error) error

// ErrCanaryChanged is returned by a RollbackFunc or RampFunc that found the
// canary changed since it was judged; the guard judges it again on its next pass.
var ErrCanaryChanged = errors.New("shadow: canary changed since it was judged")

// ErrRolloutNotSaved is returned by RecordRollout when the event was applied
// (the log and the active canaries changed in memory) but could not be written
// to <persist_path>.rollouts.json. Callers treat it as done, with a warning.
var ErrRolloutNotSaved = errors.New("shadow: rollout applied but not saved")

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

// canaryState is an active canary and its live statistics. The Canary fields
// change only in rolloutBook.record, which holds both the book's lock and mu;
// a Ramp is replaced, never modified.
type canaryState struct {
	Canary
	mu        sync.Mutex
	source    targetStats
	candidate targetStats
	// busy is set while the guard rolls the canary back or moves its ramp on.
	busy atomic.Bool
	// stuck is why the ramp hook last refused to move the step that started
	// at stuckAt on; a new step clears it. Guarded by mu.
	stuck   string
	stuckAt time.Time
}

func (c *canaryState) key() string { return c.Experiment + "\x00" + c.Candidate.String() }

// ramping reports whether the canary has a ramp the guard still has to move.
func (c *canaryState) ramping() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Ramp != nil && !c.Ramp.Completed
}

// observe counts one live response to a source-model request. For a ramping
// canary, a response that started before the current step (its latency
// reaches back past step_started_at) was routed at the previous weight and
// is not counted; failures carry no latency and are always counted.
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
	if c.Ramp != nil && latencyMs > 0 && time.Now().Add(-time.Duration(latencyMs)*time.Millisecond).Before(c.Ramp.StepStartedAt) {
		c.mu.Unlock()
		return
	}
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
		if st.Ramp != nil {
			// The ramp resumes at its step; the step's live count restarts.
			if st.Ramp.valid() {
				st.Ramp.StepRequests, st.Ramp.Reason = 0, ""
				st.Ramp.settle()
			} else {
				st.Ramp = nil // a damaged entry: keep watching the canary, stop ramping it
			}
		}
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

// record appends an event and applies it to the active canaries, then saves
// the book. The change is applied even when the save fails.
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
			existing.mu.Lock()
			existing.Weight, existing.RuleID, existing.RuleName, existing.Override = ev.Weight, ev.RuleID, ev.RuleName, ev.Override
			// A promotion replaces any ramp. Without a ramp it cancels the old one
			// and keeps the live statistics gathered so far; with one, the new
			// ramp's first step is judged on its own traffic.
			existing.Ramp = ev.Ramp.clone()
			existing.stuck = ""
			if ev.Ramp != nil {
				existing.source, existing.candidate = targetStats{}, targetStats{}
			}
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
				Ramp:       ev.Ramp.clone(),
			}}
		}
	case RolloutRamp, RolloutRampComplete:
		if existing, ok := b.canaries[key]; ok {
			existing.mu.Lock()
			existing.Weight = ev.Weight
			if ev.RuleID != "" {
				existing.RuleID, existing.RuleName = ev.RuleID, ev.RuleName
			}
			existing.Ramp = ev.Ramp.clone()
			existing.stuck = ""
			// Each step is judged on its own traffic.
			existing.source, existing.candidate = targetStats{}, targetStats{}
			existing.mu.Unlock()
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

// SetRampHook wires the function the canary guard uses to move a ramping
// canary to its next step. Without it a ramp never advances.
func (p *Plugin) SetRampHook(fn RampFunc) {
	if fn == nil {
		p.rampHook.Store(nil)
		return
	}
	p.rampHook.Store(&fn)
}

// PlanRamp validates a promotion's ramp and returns it as it starts: at its
// first step, with defaults filled in. It also returns the weight the canary
// starts at, steps[0]. weight is the promotion's weight, or nil when the
// request left it out; when given it must equal steps[0].
func (p *Plugin) PlanRamp(req RampRequest, weight *float64) (*CanaryRamp, float64, error) {
	n := len(req.Steps)
	if n < 2 || n > MaxRampSteps {
		return nil, 0, fmt.Errorf("%w: ramp.steps needs 2 to %d weights, got %d", ErrInvalidRamp, MaxRampSteps, n)
	}
	steps := make([]float64, n)
	for i, s := range req.Steps {
		if err := ValidateCanaryWeight(s); err != nil {
			return nil, 0, fmt.Errorf("%w: ramp.steps[%d] must be a number from %g to 1, got %v", ErrInvalidRamp, i, MinCanaryWeight, s)
		}
		// Compare the shares the routing rule will hold, not the raw numbers.
		steps[i] = round4(s)
		if i > 0 && steps[i] <= steps[i-1] {
			return nil, 0, fmt.Errorf("%w: ramp.steps must be strictly ascending, but steps[%d] (%g) is not above steps[%d] (%g)", ErrInvalidRamp, i, steps[i], i-1, steps[i-1])
		}
	}
	if weight != nil && round4(*weight) != steps[0] {
		return nil, 0, fmt.Errorf("%w: the ramp starts at the promoted weight, so ramp.steps[0] (%g) must equal weight (%g); leave weight out to start at steps[0]", ErrInvalidRamp, steps[0], round4(*weight))
	}
	guardMin := p.canaryLimits().MinRequests
	minRequests := guardMin
	if req.MinRequests != nil {
		if *req.MinRequests < guardMin {
			return nil, 0, fmt.Errorf("%w: ramp.min_requests must be at least canary.min_requests (%d), since the guard judges a step's health only after that many candidate requests; got %d", ErrInvalidRamp, guardMin, *req.MinRequests)
		}
		minRequests = *req.MinRequests
	}
	hold := DefaultRampHoldSeconds
	if req.HoldSeconds != nil {
		if *req.HoldSeconds < 0 || *req.HoldSeconds > MaxRampHoldSeconds {
			return nil, 0, fmt.Errorf("%w: ramp.hold_seconds must be from 0 to %d (7 days), got %d", ErrInvalidRamp, MaxRampHoldSeconds, *req.HoldSeconds)
		}
		hold = *req.HoldSeconds
	}
	r := &CanaryRamp{Steps: steps, StepStartedAt: p.now(), MinRequests: minRequests, HoldSeconds: hold}
	r.settle()
	return r, steps[0], nil
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
// re-weights) a watched canary and starts, replaces or cancels its ramp; a ramp
// event moves the canary to the ramp's next step; a rollback stops watching it.
// An event's ramp is normalized: a promotion's starts at step 0, and every
// step starts at the event's time. An invalid event returns an error and
// changes nothing; ErrRolloutNotSaved means the event was applied in memory
// but not written to disk.
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
	case RolloutPromote:
	case RolloutRollback, RolloutAutoRollback:
		ev.Ramp = nil
	case RolloutRamp, RolloutRampComplete:
		if ev.Ramp == nil {
			return ev, fmt.Errorf("shadow: a %s event needs the ramp", ev.Action)
		}
	default:
		return ev, fmt.Errorf("shadow: unknown rollout action %q", ev.Action)
	}
	if ev.Ramp != nil {
		r := ev.Ramp.clone()
		if ev.Action == RolloutPromote {
			r.CurrentStep = 0
		}
		if !r.valid() {
			return ev, fmt.Errorf("shadow: ramp step %d is out of range for %d steps", r.CurrentStep, len(r.Steps))
		}
		if round4(ev.Weight) != r.Steps[r.CurrentStep] {
			return ev, fmt.Errorf("shadow: weight %g is not the ramp's step %d (%g)", ev.Weight, r.CurrentStep, r.Steps[r.CurrentStep])
		}
		r.StepStartedAt = ev.At
		r.StepRequests, r.Reason = 0, ""
		r.settle()
		switch {
		case ev.Action == RolloutRamp && r.Completed:
			return ev, fmt.Errorf("shadow: the last ramp step is recorded as %s", RolloutRampComplete)
		case ev.Action == RolloutRampComplete && !r.Completed:
			return ev, fmt.Errorf("shadow: %s needs the ramp's last step", RolloutRampComplete)
		}
		ev.Ramp = r
	}
	if err := p.rollouts.record(ev); err != nil {
		return ev, fmt.Errorf("%w: %w", ErrRolloutNotSaved, err)
	}
	return ev, nil
}

// Rollouts returns the active canaries with their live health, and the rollout
// log newest first.
func (p *Plugin) Rollouts() Rollouts {
	out := Rollouts{AutoRollback: p.config.Canary != nil && p.config.Canary.AutoRollback, Canaries: []Canary{}}
	var verdicts map[string]string
	if list := p.rollouts.active.Load(); list != nil {
		verdicts = p.verdictsByPair()
		now := p.now()
		for _, c := range *list {
			out.Canaries = append(out.Canaries, p.canaryView(c, verdicts, now))
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

// canaryView snapshots a canary with its evaluated health and, for a ramping
// canary, where its ramp stands at now.
func (p *Plugin) canaryView(c *canaryState, verdicts map[string]string, now time.Time) Canary {
	c.mu.Lock()
	view := c.Canary
	view.Health = CanaryHealth{Source: c.source.health(), Candidate: c.candidate.health()}
	var stuck string
	if view.Ramp != nil && c.stuck != "" && c.stuckAt.Equal(view.Ramp.StepStartedAt) {
		stuck = c.stuck
	}
	c.mu.Unlock()
	view.Health.Verdict = verdicts[c.key()]
	view.Health.Status, view.Health.Reason = p.judgeCanary(&view.Health, view.Override)
	if view.Ramp != nil {
		view.Ramp = view.Ramp.clone()
		view.Ramp.blocked = stuck
		view.Ramp.StepRequests = view.Health.Candidate.Requests
		_, view.Ramp.Reason = p.rampDue(&view, now)
	}
	return view
}

// rampDue reports whether a ramping canary's current step is done, so the
// guard moves it to the next one, and says what it is waiting for otherwise.
// A step is done once it has served the ramp's min_requests candidate
// requests, its hold time has passed and the canary is healthy.
func (p *Plugin) rampDue(view *Canary, now time.Time) (bool, string) {
	r := view.Ramp
	at := r.stepLabel()
	if r.Completed {
		return false, "complete: the canary reached the last step, " + pct(r.Steps[r.CurrentStep])
	}
	if view.Health.Status == CanaryUnhealthy {
		if p.config.Canary != nil && p.config.Canary.AutoRollback {
			return false, fmt.Sprintf("held at %s: the canary is unhealthy and the guard rolls it back", at)
		}
		return false, fmt.Sprintf("held at %s: the canary is unhealthy and canary.auto_rollback is off", at)
	}
	if r.StepRequests < int64(r.MinRequests) {
		return false, fmt.Sprintf("%s: %d of %d candidate requests", at, r.StepRequests, r.MinRequests)
	}
	if left := r.StepStartedAt.Add(time.Duration(r.HoldSeconds) * time.Second).Sub(now); left > 0 {
		secs := int64((left + time.Second - 1) / time.Second)
		return false, fmt.Sprintf("%s: %ds left of a %ds hold", at, secs, r.HoldSeconds)
	}
	if view.Health.Status != CanaryHealthy {
		return false, fmt.Sprintf("%s: waiting for the guard to judge health (%s)", at, view.Health.Reason)
	}
	if r.blocked != "" {
		// Still due, so the guard keeps trying; the reason says why it has not moved.
		return true, fmt.Sprintf("%s passed but cannot move to %s: %s", at, pct(r.NextWeight), r.blocked)
	}
	return true, fmt.Sprintf("%s passed: moving to %s at the guard's next check", at, pct(r.NextWeight))
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

// canaryGuard checks active canaries: it rolls back unhealthy ones when
// auto_rollback is on, and moves ramping canaries on to their next step.
func (p *Plugin) canaryGuard() {
	defer p.wg.Done()
	ticker := time.NewTicker(p.canaryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.guardPass(p.now())
		}
	}
}

// checkCanaries runs one guard pass now and returns how many canaries it
// rolled back.
func (p *Plugin) checkCanaries() int {
	rolled, _ := p.guardPass(p.now())
	return rolled
}

// guardPass evaluates every active canary once, as of now. An unhealthy canary
// is rolled back when auto_rollback is on, and is never ramped: without
// auto_rollback its ramp holds at the current step. A healthy ramping canary
// whose step is done moves to the next step. It returns how many canaries it
// rolled back and how many it moved on.
func (p *Plugin) guardPass(now time.Time) (rolled, advanced int) {
	list := p.rollouts.active.Load()
	if list == nil {
		return 0, 0
	}
	autoRollback := p.config.Canary != nil && p.config.Canary.AutoRollback
	if !autoRollback {
		ramping := false
		for _, c := range *list {
			if c.ramping() {
				ramping = true
				break
			}
		}
		if !ramping {
			return 0, 0 // nothing to act on: the guard only reports
		}
	}
	verdicts := p.verdictsByPair()
	for _, c := range *list {
		view := p.canaryView(c, verdicts, now)
		if view.Health.Status == CanaryUnhealthy {
			if autoRollback && p.rollBack(c, view) {
				rolled++
			}
			continue
		}
		if view.Ramp != nil && p.advanceRamp(c, view, now) {
			advanced++
		}
	}
	return rolled, advanced
}

// rollBack removes an unhealthy canary through the rollback hook and reports
// whether it did.
func (p *Plugin) rollBack(c *canaryState, view Canary) bool {
	hookPtr := p.rollbackHook.Load()
	if hookPtr == nil {
		p.logger.Warn("shadow: canary %s -> %s is unhealthy (%s) but no rollback hook is wired", view.Source, view.Candidate, view.Health.Reason)
		return false
	}
	if !c.busy.CompareAndSwap(false, true) {
		return false
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
		return p.appliedIfOnlyUnsaved(err)
	}
	ctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
	err := (*hookPtr)(ctx, view.Experiment, view.Candidate.String(), reason, current, done)
	cancel()
	if err != nil {
		c.busy.Store(false)
		if !errors.Is(err, ErrCanaryChanged) {
			p.logger.Warn("shadow: automatic rollback of %s failed: %v", view.Candidate, err)
		}
		return false
	}
	p.logger.Info("shadow: rolled back canary %s -> %s: %s", view.Source, view.Candidate, view.Health.Reason)
	return true
}

// advanceRamp moves a healthy ramping canary whose current step is done to the
// next step through the ramp hook, and reports whether it did. The new step's
// event carries the health the step rested on.
func (p *Plugin) advanceRamp(c *canaryState, view Canary, now time.Time) bool {
	r := view.Ramp
	if due, _ := p.rampDue(&view, now); !due {
		return false
	}
	hookPtr := p.rampHook.Load()
	if hookPtr == nil {
		p.logger.Warn("shadow: canary %s -> %s finished %s but no ramp hook is wired", view.Source, view.Candidate, r.stepLabel())
		return false
	}
	if !c.busy.CompareAndSwap(false, true) {
		return false
	}
	defer c.busy.Store(false)
	next := &CanaryRamp{Steps: r.Steps, CurrentStep: r.CurrentStep + 1, MinRequests: r.MinRequests, HoldSeconds: r.HoldSeconds}
	next.settle()
	weight := next.Steps[next.CurrentStep]
	action := RolloutRamp
	if next.Completed {
		action = RolloutRampComplete
	}
	health := view.Health
	reason := fmt.Sprintf("canary guard: %s served %d candidate requests in %s and is healthy (%s)",
		r.stepLabel(), r.StepRequests, now.Sub(r.StepStartedAt).Round(time.Second), view.Health.Reason)
	current := func() bool {
		// Same canary, still at the step that was judged: an operator's
		// promotion or another pass of the guard since then wins.
		if p.rollouts.lookup(view.Experiment, view.Candidate.String()) != c {
			return false
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.Weight == view.Weight && c.Override == view.Override && c.Ramp != nil &&
			c.Ramp.CurrentStep == r.CurrentStep && c.Ramp.StepStartedAt.Equal(r.StepStartedAt)
	}
	done := func(ruleID, ruleName string) error {
		_, err := p.RecordRollout(RolloutEvent{
			At:         now,
			Action:     action,
			Experiment: view.Experiment,
			Source:     view.Source,
			Candidate:  view.Candidate,
			Weight:     weight,
			RuleID:     ruleID,
			RuleName:   ruleName,
			Override:   view.Override,
			Reason:     reason,
			Actor:      "canary_guard",
			Health:     &health,
			Ramp:       next,
		})
		return p.appliedIfOnlyUnsaved(err)
	}
	ctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
	err := (*hookPtr)(ctx, view.Experiment, view.Candidate.String(), weight, current, done)
	cancel()
	if err != nil {
		if errors.Is(err, ErrCanaryChanged) {
			return false
		}
		c.mu.Lock()
		repeated := c.stuck == err.Error() && c.stuckAt.Equal(r.StepStartedAt)
		c.stuck, c.stuckAt = err.Error(), r.StepStartedAt
		c.mu.Unlock()
		if !repeated { // log once per step and cause, not on every pass
			p.logger.Warn("shadow: moving canary %s -> %s to %s failed, the ramp holds: %v", view.Source, view.Candidate, pct(weight), err)
		}
		return false
	}
	p.logger.Info("shadow: canary %s -> %s moved to %s (%s)", view.Source, view.Candidate, pct(weight), action)
	return true
}

// appliedIfOnlyUnsaved turns ErrRolloutNotSaved from a guard's done callback
// into success: the rule and the book already changed, so the guard must not
// report the action as failed or try it again.
func (p *Plugin) appliedIfOnlyUnsaved(err error) error {
	if errors.Is(err, ErrRolloutNotSaved) {
		p.logger.Warn("%v", err)
		return nil
	}
	return err
}
