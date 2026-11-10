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
	StartedAt       time.Time     `json:"started_at"`
	SampleRate      float64       `json:"sample_rate"`
	JudgeModel      string        `json:"judge_model,omitempty"`
	EmbeddingModel  string        `json:"embedding_model,omitempty"`
	DailyBudgetUSD  float64       `json:"daily_budget_usd"`
	SpendTodayUSD   float64       `json:"spend_today_usd"`
	BudgetExhausted bool          `json:"budget_exhausted"`
	Counters        Counters      `json:"counters"`
	Thresholds      Thresholds    `json:"thresholds"`
	Experiments     []Experiment  `json:"experiments"`
	Pairs           []PairSummary `json:"pairs"`
}

// Summary returns counters and per-candidate scorecards.
func (p *Plugin) Summary() Summary {
	s := Summary{
		StartedAt:       p.startedAt,
		SampleRate:      p.config.SampleRate,
		DailyBudgetUSD:  p.config.DailyBudgetUSD,
		SpendTodayUSD:   p.spendToday(),
		BudgetExhausted: p.budgetExhausted(),
		Counters:        p.counters(),
		Thresholds:      p.config.Thresholds,
		Experiments:     p.config.Experiments,
		Pairs:           summarize(p.store.snapshot(), p.config, p.trafficRate),
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

// Records lists stored comparisons newest-first.
func (p *Plugin) Records(f RecordFilter) ([]*Record, int) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 50
	}
	return p.store.list(f)
}

// Record returns one comparison by ID, or nil.
func (p *Plugin) Record(id string) *Record { return p.store.get(id) }

// Reset clears stored comparisons, counters and traffic observations.
func (p *Plugin) Reset() error {
	p.eligible.Store(0)
	p.sampled.Store(0)
	p.enqueued.Store(0)
	p.dropped.Store(0)
	p.budgetSkipped.Store(0)
	p.completed.Store(0)
	p.candidateErrs.Store(0)
	p.trafficMu.Lock()
	p.traffic = make(map[string]*trafficCounter)
	p.trafficMu.Unlock()
	return p.store.reset()
}

// RoutingTarget mirrors the routing rules API target shape.
type RoutingTarget struct {
	Provider string  `json:"provider"`
	Model    string  `json:"model"`
	Weight   float64 `json:"weight"`
}

// CanaryRule is a ready-to-POST body for /api/governance/routing-rules.
type CanaryRule struct {
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Enabled       bool            `json:"enabled"`
	CelExpression string          `json:"cel_expression"`
	Targets       []RoutingTarget `json:"targets"`
	Scope         string          `json:"scope"`
	Priority      int             `json:"priority"`
}

// ErrUnknownPair is returned when no experiment/candidate pair matches a canary request.
var ErrUnknownPair = errors.New("shadow: unknown experiment or candidate")

// BuildCanaryRule returns a weighted routing rule that sends weight (0 < weight <= 1)
// of the source model's traffic to the candidate. For a wildcard source the most
// frequently observed primary model is used, since a rule must name a concrete model.
func (p *Plugin) BuildCanaryRule(experiment, candidate string, weight float64) (*CanaryRule, error) {
	if weight <= 0 || weight > 1 {
		return nil, fmt.Errorf("shadow: weight must be in (0, 1], got %v", weight)
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
	targets := []RoutingTarget{{Provider: string(cand.Provider), Model: cand.Model, Weight: round4(weight)}}
	if weight < 1 {
		targets = append([]RoutingTarget{{Provider: string(source.Provider), Model: source.Model, Weight: round4(1 - weight)}}, targets...)
	}
	return &CanaryRule{
		Name:          fmt.Sprintf("Shadow canary: %s -> %s (%g%%)", source.String(), cand.String(), round4(weight*100)),
		Description:   fmt.Sprintf("Created from shadow experiment %q. Sends %g%% of %s traffic to %s.", experiment, round4(weight*100), source.String(), cand.String()),
		Enabled:       true,
		CelExpression: cel,
		Targets:       targets,
		Scope:         "global",
		Priority:      10,
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
