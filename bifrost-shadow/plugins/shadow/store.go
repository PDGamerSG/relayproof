package shadow

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	// PassBasis names the signal that decided Pass (see the Basis* constants).
	// BasisUnscored means no usable signal: such a record is not evidence either way.
	PassBasis string `json:"pass_basis,omitempty"`
}

// pairKey groups records by experiment and candidate.
func (r *Record) pairKey() string {
	return r.Experiment + "\x00" + r.Candidate.String()
}

// scored reports whether the record is evidence about the candidate's quality:
// the candidate answered and some signal decided Pass. Records written before
// pass bases existed count as scored.
func (r *Record) scored() bool {
	return r.CandidateError == "" && r.PassBasis != BasisUnscored
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
//
// The file is compacted to the records in the buffer once it holds more than
// twice max_records lines, so its size and the startup replay stay bounded.
//
// Lock order: persistMu, then mu. When persistence is on, every change to the
// buffer (add, reset) happens under persistMu so the buffer and the file move
// together; readers take only mu and never wait on file I/O.
type store struct {
	mu      sync.RWMutex
	records []*Record // ring buffer, oldest first after wrap handling
	next    int
	full    bool
	max     int

	persistPath  string
	persistMu    sync.Mutex
	file         *os.File // nil when not open; add reopens it
	lines        int      // lines in the file, counted rather than stat'ed per write
	compactAt    int      // line count above which the file is compacted
	truncPending bool     // a reset could not truncate the file; the next open must
	closed       bool
}

// errStoreClosed is returned by add after close: the record is kept in memory only.
var errStoreClosed = errors.New("shadow: persist file is closed")

func newStore(max int, persistPath string) (*store, error) {
	s := &store{records: make([]*Record, max), max: max, persistPath: persistPath, compactAt: 2 * max}
	if persistPath == "" {
		return s, nil
	}
	lines, err := s.load()
	if err != nil {
		return nil, err
	}
	s.lines = lines
	if s.lines > s.compactAt {
		// Best effort: a failed compaction leaves the file as it is, retried later.
		if err := s.compactLocked(); err == nil {
			return s, nil
		}
	}
	if s.file == nil {
		if err := s.openLocked(false); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// load replays a persisted JSONL file into the ring buffer and returns its line count.
func (s *store) load() (int, error) {
	f, err := os.Open(s.persistPath)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("shadow: open persist file: %w", err)
	}
	defer f.Close()
	lines := 0
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		lines++
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
	return lines, scanner.Err()
}

// openLocked opens the persist file for appending, truncating it when trunc is
// set. A file whose last line lacks its '\n' (a crash mid-write) is terminated
// first, so the next record does not join the torn line and get skipped with it
// on the next load. Caller holds persistMu.
func (s *store) openLocked(trunc bool) error {
	flag := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if trunc {
		flag |= os.O_TRUNC
	}
	f, err := os.OpenFile(s.persistPath, flag, 0o600)
	if err != nil {
		return fmt.Errorf("shadow: open persist file: %w", err)
	}
	if !trunc {
		torn, err := endsTorn(f, s.persistPath)
		if err == nil && torn {
			_, err = f.Write([]byte{'\n'})
		}
		if err != nil {
			_ = f.Close()
			return fmt.Errorf("shadow: open persist file: %w", err)
		}
	}
	s.file = f
	return nil
}

// endsTorn reports whether the non-empty file f (opened write-only at path)
// does not end with '\n'.
func endsTorn(f *os.File, path string) (bool, error) {
	info, err := f.Stat()
	if err != nil || info.Size() == 0 {
		return false, err
	}
	r, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer r.Close()
	last := make([]byte, 1)
	if _, err := r.ReadAt(last, info.Size()-1); err != nil {
		return false, err
	}
	return last[0] != '\n', nil
}

// closeFileLocked closes the persist file if it is open. Caller holds persistMu.
func (s *store) closeFileLocked() error {
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}

// compactLocked rewrites the persist file with only the records in the ring
// buffer: they are written to a temporary file that then replaces the original.
// On failure the original file is kept and the next attempt is deferred by
// another max_records appends. Caller holds persistMu.
func (s *store) compactLocked() (err error) {
	defer func() {
		if err != nil {
			s.compactAt = s.lines + s.max
			err = fmt.Errorf("shadow: compact persist file: %w", err)
		}
	}()
	recs := s.snapshot()
	tmp, err := os.CreateTemp(filepath.Dir(s.persistPath), filepath.Base(s.persistPath)+".*.tmp")
	if err != nil {
		return err
	}
	written, err := writeRecords(tmp, recs)
	if syncErr := tmp.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	// Windows cannot replace a file that is still open, so the append handle goes first.
	_ = s.closeFileLocked()
	if err := os.Rename(tmp.Name(), s.persistPath); err != nil {
		_ = os.Remove(tmp.Name())
		if openErr := s.openLocked(false); openErr != nil {
			return errors.Join(err, openErr)
		}
		return err
	}
	s.lines = written
	s.compactAt = 2 * s.max
	// A failed reopen leaves the file closed; the next add retries it.
	return s.openLocked(false)
}

// writeRecords writes recs as JSON lines and returns how many it wrote. A record
// that cannot be encoded is skipped: it could never be appended either.
func writeRecords(f *os.File, recs []*Record) (int, error) {
	w := bufio.NewWriter(f)
	written := 0
	for _, rec := range recs {
		line, err := json.Marshal(rec)
		if err != nil {
			continue
		}
		line = append(line, '\n')
		if _, err := w.Write(line); err != nil {
			return written, err
		}
		written++
	}
	return written, w.Flush()
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
	if s.persistPath == "" {
		s.mu.Lock()
		s.insert(rec)
		s.mu.Unlock()
		return nil
	}
	line, marshalErr := json.Marshal(rec)
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	s.insert(rec)
	s.mu.Unlock()
	if marshalErr != nil {
		return marshalErr
	}
	if s.closed {
		return errStoreClosed
	}
	if s.file == nil {
		// An earlier reopen or write failed; try again, finishing a pending reset.
		if err := s.openLocked(s.truncPending); err != nil {
			return err
		}
		if s.truncPending {
			s.truncPending, s.lines, s.compactAt = false, 0, 2*s.max
		}
	}
	if _, err := s.file.Write(append(line, '\n')); err != nil {
		// A failed write can leave a partial line; reopening terminates it.
		_ = s.closeFileLocked()
		return fmt.Errorf("shadow: append to persist file: %w", err)
	}
	s.lines++
	if s.lines > s.compactAt {
		return s.compactLocked()
	}
	return nil
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

// clear empties the ring buffer.
func (s *store) clear() {
	s.mu.Lock()
	s.records = make([]*Record, s.max)
	s.next = 0
	s.full = false
	s.mu.Unlock()
}

// reset clears all records and truncates the persist file. persistMu is held
// across both so a concurrent add lands in both or in neither.
func (s *store) reset() error {
	if s.persistPath == "" {
		s.clear()
		return nil
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.clear()
	if s.closed {
		return nil
	}
	// Reopen with O_TRUNC rather than Truncate: an O_APPEND handle cannot be
	// truncated on Windows.
	_ = s.closeFileLocked()
	if err := s.openLocked(true); err != nil {
		s.truncPending = true
		return fmt.Errorf("shadow: reopen persist file: %w", err)
	}
	s.truncPending, s.lines, s.compactAt = false, 0, 2*s.max
	return nil
}

func (s *store) close() error {
	if s.persistPath == "" {
		return nil
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.closed = true
	return s.closeFileLocked()
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
	// Scored counts completed comparisons that some quality signal decided;
	// Unscored the rest. Agreement is measured over Scored + Errors only.
	Scored   int `json:"scored"`
	Unscored int `json:"unscored"`
	// JudgeErrors counts judge calls that failed or returned an unusable verdict.
	JudgeErrors    int     `json:"judge_errors"`
	JudgeErrorRate float64 `json:"judge_error_rate"`
	// PassBasisCounts shows which signal decided how many comparisons.
	PassBasisCounts map[string]int `json:"pass_basis_counts"`

	ErrorRate           float64 `json:"error_rate"`
	AgreementRate       float64 `json:"agreement_rate"`
	AgreementLowerBound float64 `json:"agreement_lower_bound"`
	ExactMatchRate      float64 `json:"exact_match_rate"`
	FinishReasonMatch   float64 `json:"finish_reason_match_rate"`

	// Agent metrics: how the candidate's tool use compares on turns where either
	// side called a tool. ToolDiffs counts mismatches by kind (see ToolDiff*).
	ToolTurns         int            `json:"tool_turns"`
	ToolNameMatchRate *float64       `json:"tool_name_match_rate,omitempty"`
	ToolDiffs         map[string]int `json:"tool_diffs,omitempty"`

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
		toolNameMatch  int
		exact          int
		finishMatch    int
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
			a.sum.PassBasisCounts = map[string]int{}
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
		if r.JudgeError != "" {
			s.JudgeErrors++
		}
		if r.PassBasis != "" {
			s.PassBasisCounts[r.PassBasis]++
		}
		if r.scored() {
			s.Scored++
			if r.Pass {
				s.Passes++
			}
		} else {
			s.Unscored++
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
			if r.Comparison.ExactMatch {
				a.exact++
			}
			if r.Comparison.FinishReasonMatch {
				a.finishMatch++
			}
			if r.Comparison.ToolCallsMatch != nil {
				a.toolN++
				if *r.Comparison.ToolCallsMatch {
					a.toolMatch++
				}
				if r.Comparison.ToolNamesMatch == nil || *r.Comparison.ToolNamesMatch {
					a.toolNameMatch++
				}
				if d := r.Comparison.ToolCallDiff; d != "" {
					if s.ToolDiffs == nil {
						s.ToolDiffs = map[string]int{}
					}
					s.ToolDiffs[d]++
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
		if judgeAttempts := s.Judged + s.JudgeErrors; judgeAttempts > 0 {
			s.JudgeErrorRate = float64(s.JudgeErrors) / float64(judgeAttempts)
		}
		// Errors count against agreement: a candidate that fails is not a
		// substitute. Unscored comparisons are not evidence either way.
		if evidence := s.Scored + s.Errors; evidence > 0 {
			s.AgreementRate = float64(s.Passes) / float64(evidence)
			s.AgreementLowerBound = wilsonLowerBound(s.Passes, evidence)
		}
		if s.Completed > 0 {
			n := float64(s.Completed)
			s.ExactMatchRate = float64(a.exact) / n
			s.FinishReasonMatch = float64(a.finishMatch) / n
			s.AvgLexicalSimilarity = a.lexSum / n
			if a.semN > 0 {
				v := a.semSum / float64(a.semN)
				s.AvgSemanticSimilarity = &v
			}
			if a.toolN > 0 {
				v := float64(a.toolMatch) / float64(a.toolN)
				s.ToolCallMatchRate = &v
				names := float64(a.toolNameMatch) / float64(a.toolN)
				s.ToolNameMatchRate = &names
				s.ToolTurns = a.toolN
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
		s.Verdict, s.VerdictReason = verdictFor(&s, cfg)
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
// Only scored comparisons and candidate errors are evidence: the sample minimum
// and the agreement bound are both computed over them.
func verdictFor(s *PairSummary, cfg *Config) (string, string) {
	t := &cfg.Thresholds
	if evidence := s.Scored + s.Errors; evidence < t.MinSamples {
		reason := fmt.Sprintf("%d of %d scored samples collected", evidence, t.MinSamples)
		if s.Unscored > 0 {
			reason += fmt.Sprintf("; %d comparisons unscored (%s)", s.Unscored, unscoredCause(s, cfg))
		}
		return VerdictCollecting, reason
	}
	if s.ErrorRate > t.MaxErrorRate {
		return VerdictNotReady, fmt.Sprintf("candidate error rate %.1f%% exceeds %.1f%%", s.ErrorRate*100, t.MaxErrorRate*100)
	}
	if s.JudgeErrorRate > t.MaxJudgeErrorRate {
		return VerdictNotReady, fmt.Sprintf("judge failed on %.1f%% of %d judged pairs (limit %.1f%%); fix the evaluator before trusting this scorecard", s.JudgeErrorRate*100, s.Judged+s.JudgeErrors, t.MaxJudgeErrorRate*100)
	}
	if s.AgreementLowerBound >= t.MinAgreement {
		return VerdictReady, fmt.Sprintf("agreement %.1f%% (95%% lower bound %.1f%%) clears %.0f%%", s.AgreementRate*100, s.AgreementLowerBound*100, t.MinAgreement*100)
	}
	if s.AgreementRate >= t.MinAgreement {
		return VerdictPromising, fmt.Sprintf("agreement %.1f%% clears %.0f%% but the 95%% lower bound (%.1f%%) does not yet; collect more samples", s.AgreementRate*100, t.MinAgreement*100, s.AgreementLowerBound*100)
	}
	return VerdictNotReady, fmt.Sprintf("agreement %.1f%% is below %.0f%%", s.AgreementRate*100, t.MinAgreement*100)
}

// unscoredCause explains why comparisons went unscored, for verdict reasons.
func unscoredCause(s *PairSummary, cfg *Config) string {
	if s.JudgeErrors > 0 {
		return fmt.Sprintf("%d judge failures", s.JudgeErrors)
	}
	if cfg.Judge == nil && cfg.Embedding == nil && cfg.QualityFallback != QualityFallbackLexical {
		return "no quality evaluator: configure a judge or embedding model, or set quality_fallback to \"lexical\""
	}
	return "no judge verdict or embedding similarity"
}

// splitRef parses "provider/model" (provider optional).
func splitRef(s string) ModelRef {
	if i := strings.Index(s, "/"); i > 0 {
		return ModelRef{Provider: modelProvider(s[:i]), Model: s[i+1:]}
	}
	return ModelRef{Model: s}
}

func modelProvider(s string) schemas.ModelProvider { return schemas.ModelProvider(s) }
