package shadow

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

// Record is one completed (or failed) shadow comparison.
type Record struct {
	ID         string    `json:"id"`
	RequestID  string    `json:"request_id"`
	Experiment string    `json:"experiment"`
	CreatedAt  time.Time `json:"created_at"`
	Stream     bool      `json:"stream"`

	Primary   ModelRef `json:"primary"`
	Candidate ModelRef `json:"candidate"`

	// Prompt is the (truncated) last user turn, kept when store_payloads is on.
	Prompt          string  `json:"prompt,omitempty"`
	PrimaryAnswer   *Answer `json:"primary_answer,omitempty"`
	CandidateAnswer *Answer `json:"candidate_answer,omitempty"`

	PrimaryLatencyMs   int64 `json:"primary_latency_ms"`
	CandidateLatencyMs int64 `json:"candidate_latency_ms"`

	PrimaryInputTokens    int `json:"primary_input_tokens"`
	PrimaryOutputTokens   int `json:"primary_output_tokens"`
	CandidateInputTokens  int `json:"candidate_input_tokens"`
	CandidateOutputTokens int `json:"candidate_output_tokens"`

	PrimaryCostUSD   float64 `json:"primary_cost_usd"`
	CandidateCostUSD float64 `json:"candidate_cost_usd"`
	// EvalCostUSD is what the judge and embedding calls for this pair cost.
	EvalCostUSD float64 `json:"eval_cost_usd"`

	// CandidateError is set when the candidate call failed; metrics are then empty.
	CandidateError string `json:"candidate_error,omitempty"`

	Comparison *Comparison   `json:"comparison,omitempty"`
	Judge      *JudgeVerdict `json:"judge,omitempty"`
	JudgeError string        `json:"judge_error,omitempty"`

	// Pass reports whether the candidate answer is an acceptable substitute.
	Pass bool `json:"pass"`
	// PassBasis names the signal that decided Pass: judge, semantic, structural or lexical.
	PassBasis string `json:"pass_basis,omitempty"`
}

// pairKey groups records by experiment and candidate.
func (r *Record) pairKey() string {
	return r.Experiment + "\x00" + r.Candidate.String()
}

// RecordFilter selects records for listing.
type RecordFilter struct {
	Experiment string
	Candidate  string
	// Outcome is "", "pass", "fail" or "error".
	Outcome string
	Limit   int
	Offset  int
}

// store keeps the most recent comparisons in a ring buffer and optionally
// appends each to a JSONL file. Aggregates are recomputed from the buffer on
// read: the buffer is bounded (max_records) and summaries are requested by
// humans, not on the request path.
type store struct {
	mu      sync.RWMutex
	records []*Record // ring buffer, oldest first after wrap handling
	next    int
	full    bool
	max     int

	persistPath string
	persistMu   sync.Mutex
	file        *os.File
	writer      *bufio.Writer
}

func newStore(max int, persistPath string) (*store, error) {
	s := &store{records: make([]*Record, max), max: max, persistPath: persistPath}
	if persistPath == "" {
		return s, nil
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(persistPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("shadow: open persist file: %w", err)
	}
	s.file = f
	s.writer = bufio.NewWriter(f)
	return s, nil
}

// load replays a persisted JSONL file into the ring buffer.
func (s *store) load() error {
	f, err := os.Open(s.persistPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("shadow: open persist file: %w", err)
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			// A torn final line (crash mid-write) must not block startup.
			continue
		}
		s.insert(&rec)
	}
	return scanner.Err()
}

func (s *store) insert(rec *Record) {
	s.records[s.next] = rec
	s.next = (s.next + 1) % s.max
	if s.next == 0 {
		s.full = true
	}
}

// add stores a record and persists it when configured.
func (s *store) add(rec *Record) error {
	s.mu.Lock()
	s.insert(rec)
	s.mu.Unlock()
	if s.writer == nil {
		return nil
	}
	line, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	if _, err := s.writer.Write(append(line, '\n')); err != nil {
		return err
	}
	return s.writer.Flush()
}

// snapshot returns records oldest-first.
func (s *store) snapshot() []*Record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Record, 0, s.lenLocked())
	if s.full {
		for i := s.next; i < s.max; i++ {
			out = append(out, s.records[i])
		}
	}
	for i := 0; i < s.next; i++ {
		out = append(out, s.records[i])
	}
	return out
}

// len returns the number of stored records.
func (s *store) len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lenLocked()
}

// lenLocked is len for callers that already hold s.mu.
func (s *store) lenLocked() int {
	if s.full {
		return s.max
	}
	return s.next
}

// get returns a record by ID.
func (s *store) get(id string) *Record {
	for _, r := range s.snapshot() {
		if r.ID == id {
			return r
		}
	}
	return nil
}

// list returns records newest-first matching the filter, plus the total match count.
func (s *store) list(f RecordFilter) ([]*Record, int) {
	all := s.snapshot()
	matched := make([]*Record, 0, len(all))
	for i := len(all) - 1; i >= 0; i-- {
		r := all[i]
		if f.Experiment != "" && r.Experiment != f.Experiment {
			continue
		}
		if f.Candidate != "" && r.Candidate.String() != f.Candidate {
			continue
		}
		switch f.Outcome {
		case "pass":
			if r.CandidateError != "" || !r.Pass {
				continue
			}
		case "fail":
			if r.CandidateError != "" || r.Pass {
				continue
			}
		case "error":
			if r.CandidateError == "" {
				continue
			}
		}
		matched = append(matched, r)
	}
	total := len(matched)
	if f.Offset > 0 {
		if f.Offset >= len(matched) {
			return []*Record{}, total
		}
		matched = matched[f.Offset:]
	}
	if f.Limit > 0 && len(matched) > f.Limit {
		matched = matched[:f.Limit]
	}
	return matched, total
}

// reset clears all records and truncates the persist file.
func (s *store) reset() error {
	s.mu.Lock()
	s.records = make([]*Record, s.max)
	s.next = 0
	s.full = false
	s.mu.Unlock()
	if s.file == nil {
		return nil
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	if err := s.writer.Flush(); err != nil {
		return err
	}
	// Reopen with O_TRUNC rather than Truncate: an O_APPEND handle cannot be
	// truncated on Windows.
	if err := s.file.Close(); err != nil {
		return err
	}
	f, err := os.OpenFile(s.persistPath, os.O_CREATE|os.O_TRUNC|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		s.file, s.writer = nil, nil
		return fmt.Errorf("shadow: reopen persist file: %w", err)
	}
	s.file = f
	s.writer = bufio.NewWriter(f)
	return nil
}

func (s *store) close() error {
	if s.file == nil {
		return nil
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	if err := s.writer.Flush(); err != nil {
		return err
	}
	return s.file.Close()
}

// Readiness verdicts.
const (
	VerdictCollecting = "collecting"
	VerdictReady      = "ready"
	VerdictPromising  = "promising"
	VerdictNotReady   = "not_ready"
)

// LatencyStats summarizes latency in milliseconds.
type LatencyStats struct {
	P50 float64 `json:"p50_ms"`
	P95 float64 `json:"p95_ms"`
}

// PairSummary is the scorecard for one candidate within one experiment.
type PairSummary struct {
	Experiment string   `json:"experiment"`
	Source     ModelRef `json:"source"`
	Candidate  ModelRef `json:"candidate"`
	// PrimaryModels lists the concrete primary models observed (a "*" source can cover several).
	PrimaryModels []string `json:"primary_models"`

	Samples   int `json:"samples"`   // all comparisons, including candidate errors
	Completed int `json:"completed"` // comparisons where the candidate answered
	Errors    int `json:"errors"`
	Passes    int `json:"passes"`
	Judged    int `json:"judged"`

	ErrorRate           float64 `json:"error_rate"`
	AgreementRate       float64 `json:"agreement_rate"`
	AgreementLowerBound float64 `json:"agreement_lower_bound"`

	JudgeWins         int     `json:"judge_candidate_wins"`
	JudgeTies         int     `json:"judge_ties"`
	JudgeLosses       int     `json:"judge_candidate_losses"`
	AvgPrimaryScore   float64 `json:"avg_primary_score"`
	AvgCandidateScore float64 `json:"avg_candidate_score"`

	AvgLexicalSimilarity  float64  `json:"avg_lexical_similarity"`
	AvgSemanticSimilarity *float64 `json:"avg_semantic_similarity,omitempty"`
	ToolCallMatchRate     *float64 `json:"tool_call_match_rate,omitempty"`
	JSONMatchRate         *float64 `json:"json_match_rate,omitempty"`

	PrimaryLatency   LatencyStats `json:"primary_latency"`
	CandidateLatency LatencyStats `json:"candidate_latency"`

	AvgPrimaryCostUSD   float64 `json:"avg_primary_cost_usd"`
	AvgCandidateCostUSD float64 `json:"avg_candidate_cost_usd"`
	// SavingsPct is the relative cost reduction per request (negative = candidate is pricier).
	SavingsPct float64 `json:"savings_pct"`
	// SavingsPerMillionUSD is the projected saving per one million requests.
	SavingsPerMillionUSD float64 `json:"savings_per_million_usd"`
	// ProjectedMonthlySavingsUSD extrapolates the observed live request rate for this source.
	ProjectedMonthlySavingsUSD float64 `json:"projected_monthly_savings_usd"`
	EvalSpendUSD               float64 `json:"eval_spend_usd"`
	ShadowSpendUSD             float64 `json:"shadow_spend_usd"`

	Verdict       string `json:"verdict"`
	VerdictReason string `json:"verdict_reason"`

	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
}

// trafficRate reports the observed eligible request rate per second for an experiment.
type trafficRate func(experiment string) float64

// summarize builds per-pair scorecards from the stored records.
func summarize(records []*Record, cfg *Config, rate trafficRate) []PairSummary {
	type acc struct {
		sum            PairSummary
		primaryLat     []float64
		candidateLat   []float64
		lexSum         float64
		semSum         float64
		semN           int
		toolMatch      int
		toolN          int
		jsonMatch      int
		jsonN          int
		pScore, cScore float64
		primaryCost    float64
		candidateCost  float64
		models         map[string]struct{}
	}
	pairs := make(map[string]*acc)
	order := make([]string, 0)
	for _, r := range records {
		key := r.pairKey()
		a, ok := pairs[key]
		if !ok {
			a = &acc{models: map[string]struct{}{}}
			a.sum.Experiment = r.Experiment
			a.sum.Candidate = r.Candidate
			a.sum.FirstSeen = r.CreatedAt
			for _, exp := range cfg.Experiments {
				if exp.Name == r.Experiment {
					a.sum.Source = exp.Source
				}
			}
			pairs[key] = a
			order = append(order, key)
		}
		s := &a.sum
		s.Samples++
		if r.CreatedAt.Before(s.FirstSeen) {
			s.FirstSeen = r.CreatedAt
		}
		if r.CreatedAt.After(s.LastSeen) {
			s.LastSeen = r.CreatedAt
		}
		a.models[r.Primary.String()] = struct{}{}
		s.EvalSpendUSD += r.EvalCostUSD
		s.ShadowSpendUSD += r.CandidateCostUSD
		if r.CandidateError != "" {
			s.Errors++
			continue
		}
		s.Completed++
		if r.Pass {
			s.Passes++
		}
		a.primaryLat = append(a.primaryLat, float64(r.PrimaryLatencyMs))
		a.candidateLat = append(a.candidateLat, float64(r.CandidateLatencyMs))
		a.primaryCost += r.PrimaryCostUSD
		a.candidateCost += r.CandidateCostUSD
		if r.Comparison != nil {
			a.lexSum += r.Comparison.LexicalSimilarity
			if r.Comparison.SemanticSimilarity != nil {
				a.semSum += *r.Comparison.SemanticSimilarity
				a.semN++
			}
			if r.Comparison.ToolCallsMatch != nil {
				a.toolN++
				if *r.Comparison.ToolCallsMatch {
					a.toolMatch++
				}
			}
			if r.Comparison.JSONMatch != nil {
				a.jsonN++
				if *r.Comparison.JSONMatch {
					a.jsonMatch++
				}
			}
		}
		if r.Judge != nil {
			s.Judged++
			a.pScore += r.Judge.PrimaryScore
			a.cScore += r.Judge.CandidateScore
			switch r.Judge.Winner {
			case "candidate":
				s.JudgeWins++
			case "primary":
				s.JudgeLosses++
			default:
				s.JudgeTies++
			}
		}
	}

	out := make([]PairSummary, 0, len(order))
	for _, key := range order {
		a := pairs[key]
		s := a.sum
		for m := range a.models {
			s.PrimaryModels = append(s.PrimaryModels, m)
		}
		sort.Strings(s.PrimaryModels)
		if s.Samples > 0 {
			s.ErrorRate = float64(s.Errors) / float64(s.Samples)
		}
		if s.Completed > 0 {
			n := float64(s.Completed)
			// Errors count against agreement: a candidate that fails is not a substitute.
			s.AgreementRate = float64(s.Passes) / float64(s.Samples)
			s.AgreementLowerBound = wilsonLowerBound(s.Passes, s.Samples)
			s.AvgLexicalSimilarity = a.lexSum / n
			if a.semN > 0 {
				v := a.semSum / float64(a.semN)
				s.AvgSemanticSimilarity = &v
			}
			if a.toolN > 0 {
				v := float64(a.toolMatch) / float64(a.toolN)
				s.ToolCallMatchRate = &v
			}
			if a.jsonN > 0 {
				v := float64(a.jsonMatch) / float64(a.jsonN)
				s.JSONMatchRate = &v
			}
			s.PrimaryLatency = LatencyStats{P50: percentile(a.primaryLat, 50), P95: percentile(a.primaryLat, 95)}
			s.CandidateLatency = LatencyStats{P50: percentile(a.candidateLat, 50), P95: percentile(a.candidateLat, 95)}
			s.AvgPrimaryCostUSD = a.primaryCost / n
			s.AvgCandidateCostUSD = a.candidateCost / n
			if s.AvgPrimaryCostUSD > 0 {
				s.SavingsPct = (s.AvgPrimaryCostUSD - s.AvgCandidateCostUSD) / s.AvgPrimaryCostUSD * 100
			}
			perReq := s.AvgPrimaryCostUSD - s.AvgCandidateCostUSD
			s.SavingsPerMillionUSD = perReq * 1_000_000
			if rate != nil {
				s.ProjectedMonthlySavingsUSD = perReq * rate(s.Experiment) * 30 * 24 * 3600
			}
		}
		if s.Judged > 0 {
			s.AvgPrimaryScore = a.pScore / float64(s.Judged)
			s.AvgCandidateScore = a.cScore / float64(s.Judged)
		}
		s.Verdict, s.VerdictReason = verdictFor(&s, &cfg.Thresholds)
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Experiment != out[j].Experiment {
			return out[i].Experiment < out[j].Experiment
		}
		return out[i].Candidate.String() < out[j].Candidate.String()
	})
	return out
}

// verdictFor maps a scorecard onto a readiness verdict with a human reason.
func verdictFor(s *PairSummary, t *Thresholds) (string, string) {
	if s.Samples < t.MinSamples {
		return VerdictCollecting, fmt.Sprintf("%d of %d samples collected", s.Samples, t.MinSamples)
	}
	if s.ErrorRate > t.MaxErrorRate {
		return VerdictNotReady, fmt.Sprintf("candidate error rate %.1f%% exceeds %.1f%%", s.ErrorRate*100, t.MaxErrorRate*100)
	}
	if s.AgreementLowerBound >= t.MinAgreement {
		return VerdictReady, fmt.Sprintf("agreement %.1f%% (95%% lower bound %.1f%%) clears %.0f%%", s.AgreementRate*100, s.AgreementLowerBound*100, t.MinAgreement*100)
	}
	if s.AgreementRate >= t.MinAgreement {
		return VerdictPromising, fmt.Sprintf("agreement %.1f%% clears %.0f%% but the 95%% lower bound (%.1f%%) does not yet; collect more samples", s.AgreementRate*100, t.MinAgreement*100, s.AgreementLowerBound*100)
	}
	return VerdictNotReady, fmt.Sprintf("agreement %.1f%% is below %.0f%%", s.AgreementRate*100, t.MinAgreement*100)
}

// splitRef parses "provider/model" (provider optional).
func splitRef(s string) ModelRef {
	if i := strings.Index(s, "/"); i > 0 {
		return ModelRef{Provider: modelProvider(s[:i]), Model: s[i+1:]}
	}
	return ModelRef{Model: s}
}

func modelProvider(s string) schemas.ModelProvider { return schemas.ModelProvider(s) }
