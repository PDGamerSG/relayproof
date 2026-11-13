package shadow

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Summary is the payload behind GET /api/shadow/summary.
type Summary struct {
	StartedAt      time.Time `json:"started_at"`
	SampleRate     float64   `json:"sample_rate"`
	JudgeModel     string    `json:"judge_model,omitempty"`
	EmbeddingModel string    `json:"embedding_model,omitempty"`
	DailyBudgetUSD float64   `json:"daily_budget_usd"`
	SpendTodayUSD  float64   `json:"spend_today_usd"`
	// SpendReservedUSD is the expected cost of shadow jobs still running; it
	// counts against the budget until they finish.
	SpendReservedUSD float64       `json:"spend_reserved_usd"`
	BudgetExhausted  bool          `json:"budget_exhausted"`
	Counters         Counters      `json:"counters"`
	Thresholds       Thresholds    `json:"thresholds"`
	Experiments      []Experiment  `json:"experiments"`
	Pairs            []PairSummary `json:"pairs"`
}

// Summary returns counters and per-candidate scorecards.
func (p *Plugin) Summary() Summary {
	spent, reserved := p.ledger.totals(p.today())
	s := Summary{
		StartedAt:        time.Unix(0, p.startedAt.Load()),
		SampleRate:       p.config.SampleRate,
		DailyBudgetUSD:   p.config.DailyBudgetUSD,
		SpendTodayUSD:    spent,
		SpendReservedUSD: reserved,
		BudgetExhausted:  p.budgetExhausted(),
		Counters:         p.counters(),
		Thresholds:       p.config.Thresholds,
		Experiments:      p.config.Experiments,
		Pairs:            summarize(p.store.snapshot(), p.config, p.trafficRate),
	}
	if p.config.Judge != nil {
		s.JudgeModel = string(p.config.Judge.Provider) + "/" + p.config.Judge.Model
	}
	if p.config.Embedding != nil {
		s.EmbeddingModel = string(p.config.Embedding.Provider) + "/" + p.config.Embedding.Model
	}
	return s
}

func (p *Plugin) counters() Counters {
	return Counters{
		Eligible:      p.eligible.Load(),
		Sampled:       p.sampled.Load(),
		Enqueued:      p.enqueued.Load(),
		Dropped:       p.dropped.Load(),
		BudgetSkipped: p.budgetSkipped.Load(),
		Completed:     p.completed.Load(),
		CandidateErrs: p.candidateErrs.Load(),
		InFlight:      p.inFlight.Load(),
		QueueDepth:    len(p.queue),
	}
}

// Record listing page sizes.
const (
	DefaultRecordsLimit = 50
	MaxRecordsLimit     = 500
)

// Records lists stored comparisons newest-first. A limit of 0 or less means
// DefaultRecordsLimit; one above MaxRecordsLimit is clamped to it.
func (p *Plugin) Records(f RecordFilter) ([]*Record, int) {
	switch {
	case f.Limit <= 0:
		f.Limit = DefaultRecordsLimit
	case f.Limit > MaxRecordsLimit:
		f.Limit = MaxRecordsLimit
	}
	return p.store.list(f)
}

// Record returns one comparison by ID, or nil.
func (p *Plugin) Record(id string) *Record { return p.store.get(id) }

// Reset clears stored comparisons, counters and traffic observations, and
// restarts the collection window. Today's spend lives in the spend ledger and
// is kept, so clearing results never lifts the daily budget.
func (p *Plugin) Reset() error {
	p.startedAt.Store(p.now().UnixNano())
	p.eligible.Store(0)
	p.sampled.Store(0)
	p.enqueued.Store(0)
	p.dropped.Store(0)
	p.budgetSkipped.Store(0)
	p.completed.Store(0)
	p.candidateErrs.Store(0)
	// Slots roll over lazily when they see the new window; zeroing them here as
	// well keeps a Reset within the same clock tick from keeping old counts.
	window := p.startedAt.Load()
	p.trafficMu.Lock()
	for i := range p.trafficSlots {
		p.trafficSlots[i].count.Store(0)
		p.trafficSlots[i].first.Store(0)
		p.trafficSlots[i].window.Store(window)
	}
	p.trafficMu.Unlock()
	return p.store.reset()
}

// RoutingTarget mirrors the routing rules API target shape.
type RoutingTarget struct {
	Provider string  `json:"provider"`
	Model    string  `json:"model"`
	Weight   float64 `json:"weight"`
}

// CanaryRule is a ready-to-POST body for /api/routing/rules.
type CanaryRule struct {
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Enabled       bool            `json:"enabled"`
	CelExpression string          `json:"cel_expression"`
	Targets       []RoutingTarget `json:"targets"`
	Scope         string          `json:"scope"`
	Priority      int             `json:"priority"`

	// Source and Candidate are the concrete models the rule routes between. They
	// are not part of the routing-rules body.
	Source    ModelRef `json:"-"`
	Candidate ModelRef `json:"-"`
}

// CanaryRuleNamePrefix starts the name of every routing rule the shadow plugin
// creates, followed by the source model; promotion uses it to find and update
// an existing canary for a source instead of adding a second, unreachable rule.
const CanaryRuleNamePrefix = "Shadow canary: "

// ErrUnknownPair is returned when no experiment/candidate pair matches a canary request.
var ErrUnknownPair = errors.New("shadow: unknown experiment or candidate")

// MinCanaryWeight is the smallest canary share: target weights are rounded to
// four decimals, and a share that rounds to 0 makes a target the routing rules
// API rejects.
const MinCanaryWeight = 0.0001

// DefaultCanaryPriority is the routing rule priority used when none is given.
const DefaultCanaryPriority = 10

// ValidateCanaryWeight checks that weight is a number in [MinCanaryWeight, 1].
// NaN and infinities are rejected.
func ValidateCanaryWeight(weight float64) error {
	if !(weight >= MinCanaryWeight && weight <= 1) {
		return fmt.Errorf("shadow: weight must be a number from %g to 1, got %v", MinCanaryWeight, weight)
	}
	return nil
}

// BuildCanaryRule returns a weighted routing rule that sends weight
// (MinCanaryWeight <= weight <= 1) of the source model's traffic to the
// candidate. The candidate's share is rounded to four decimals and the source
// gets the rest; a share that rounds to 1 yields a single-target full cutover.
// For a wildcard source the most frequently observed primary model is used,
// since a rule must name a concrete model.
//
// priority optionally overrides DefaultCanaryPriority (at most one value, not
// negative): the routing rules API allows one rule per priority in a scope.
// The rule name depends only on the pair, so a caller can find an existing
// canary for it and update its weight instead of creating a second rule.
func (p *Plugin) BuildCanaryRule(experiment, candidate string, weight float64, priority ...int) (*CanaryRule, error) {
	if err := ValidateCanaryWeight(weight); err != nil {
		return nil, err
	}
	rulePriority := DefaultCanaryPriority
	if len(priority) > 1 {
		return nil, errors.New("shadow: at most one priority may be given")
	}
	if len(priority) == 1 {
		if priority[0] < 0 {
			return nil, fmt.Errorf("shadow: priority must be a non-negative integer, got %d", priority[0])
		}
		rulePriority = priority[0]
	}
	var exp *Experiment
	for i := range p.config.Experiments {
		if p.config.Experiments[i].Name == experiment {
			exp = &p.config.Experiments[i]
		}
	}
	if exp == nil {
		return nil, ErrUnknownPair
	}
	var cand *ModelRef
	for i := range exp.Candidates {
		if exp.Candidates[i].String() == candidate {
			cand = &exp.Candidates[i]
		}
	}
	if cand == nil {
		return nil, ErrUnknownPair
	}
	source := exp.Source
	if source.Model == "*" || source.Model == "" || source.Provider == "" {
		observed, ok := p.mostCommonPrimary(experiment, candidate)
		if !ok {
			return nil, fmt.Errorf("shadow: experiment %q has a wildcard source and no observed traffic yet", experiment)
		}
		if source.Model == "*" || source.Model == "" {
			source.Model = observed.Model
		}
		if source.Provider == "" {
			source.Provider = observed.Provider
		}
	}
	cel := fmt.Sprintf("model == %q", source.Model)
	if source.Provider != "" {
		cel = fmt.Sprintf("provider == %q && %s", string(source.Provider), cel)
	}
	// Derive both weights from the rounded share so each is at least
	// MinCanaryWeight and they sum to 1.
	share := round4(weight)
	targets := []RoutingTarget{{Provider: string(cand.Provider), Model: cand.Model, Weight: share}}
	if share < 1 {
		targets = append([]RoutingTarget{{Provider: string(source.Provider), Model: source.Model, Weight: round4(1 - share)}}, targets...)
	}
	return &CanaryRule{
		Source:        source,
		Candidate:     *cand,
		Name:          fmt.Sprintf("%s%s -> %s", CanaryRuleNamePrefix, source.String(), cand.String()),
		Description:   fmt.Sprintf("Created from shadow experiment %q. Sends %g%% of %s traffic to %s.", experiment, round4(share*100), source.String(), cand.String()),
		Enabled:       true,
		CelExpression: cel,
		Targets:       targets,
		Scope:         "global",
		Priority:      rulePriority,
	}, nil
}

func (p *Plugin) mostCommonPrimary(experiment, candidate string) (ModelRef, bool) {
	counts := map[string]int{}
	refs := map[string]ModelRef{}
	for _, r := range p.store.snapshot() {
		if r.Experiment != experiment || r.Candidate.String() != candidate {
			continue
		}
		k := r.Primary.String()
		counts[k]++
		refs[k] = r.Primary
	}
	if len(counts) == 0 {
		return ModelRef{}, false
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if counts[keys[i]] != counts[keys[j]] {
			return counts[keys[i]] > counts[keys[j]]
		}
		return keys[i] < keys[j]
	})
	return refs[keys[0]], true
}

// Round4 rounds a traffic share to the four decimals routing rules use.
func Round4(f float64) float64 { return round4(f) }

func round4(f float64) float64 {
	return float64(int64(f*10000+0.5)) / 10000
}

// ParseOutcome validates an outcome filter value.
func ParseOutcome(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "all":
		return "", nil
	case "pass", "fail", "error":
		return strings.ToLower(strings.TrimSpace(s)), nil
	}
	return "", fmt.Errorf("outcome must be one of all, pass, fail, error")
}
