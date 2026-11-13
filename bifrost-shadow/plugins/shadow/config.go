package shadow

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
)

// PluginName is the registered name of the shadow traffic plugin.
const PluginName = "shadow"

// Defaults applied by Config.normalize when a field is left unset.
const (
	DefaultSampleRate       = 0.1
	DefaultMaxConcurrency   = 4
	DefaultQueueSize        = 256
	DefaultTimeoutSeconds   = 60
	DefaultMaxRecords       = 5000
	DefaultMaxPayloadChars  = 8000
	DefaultMinSamples       = 20
	DefaultMinAgreement     = 0.9
	DefaultMaxErrorRate     = 0.05
	DefaultQualityTolerance = 1.0
	DefaultLexicalThreshold = 0.6
	DefaultSemanticThresh   = 0.85
	DefaultMaxJudgeErrRate  = 0.1
	maxAccumulatedChars     = 64 * 1024
)

// Quality fallbacks: what scores a pair that no judge verdict, exact match,
// tool-call match or embedding similarity could score.
const (
	// QualityFallbackNone leaves such a pair unscored: it counts toward neither
	// agreement nor the sample minimum. This is the default.
	QualityFallbackNone = "none"
	// QualityFallbackLexical scores such a pair by token overlap. Overlap does not
	// check meaning ("approved: true" and "approved: false" overlap heavily), so
	// it is an explicit operator choice for setups without a judge or embeddings.
	QualityFallbackLexical = "lexical"
)

// ModelRef names a provider/model pair. An empty Provider matches any provider
// and the model "*" matches any model when the reference is used as a source.
type ModelRef struct {
	Provider schemas.ModelProvider `json:"provider,omitempty"`
	Model    string                `json:"model"`
}

// String renders the reference the way routing rules and logs do: provider/model.
func (m ModelRef) String() string {
	if m.Provider == "" {
		return m.Model
	}
	return string(m.Provider) + "/" + m.Model
}

// matches reports whether the attempted provider/model is covered by this
// source reference.
func (m ModelRef) matches(provider schemas.ModelProvider, model string) bool {
	if m.Provider != "" && m.Provider != provider {
		return false
	}
	return m.Model == "*" || m.Model == "" || strings.EqualFold(m.Model, model)
}

// Experiment mirrors traffic of one source model to one or more candidates.
type Experiment struct {
	// Name identifies the experiment in reports. Defaults to "<source> vs candidates".
	Name string `json:"name,omitempty"`
	// Source selects which live requests are eligible (provider optional, model "*" = all).
	Source ModelRef `json:"source"`
	// Candidates receive a copy of each sampled request.
	Candidates []ModelRef `json:"candidates"`
	// SampleRate overrides the plugin-wide sample rate for this experiment (0 < rate <= 1).
	SampleRate *float64 `json:"sample_rate,omitempty"`
}

// JudgeConfig configures the optional LLM-as-judge comparison.
type JudgeConfig struct {
	Provider schemas.ModelProvider `json:"provider"`
	Model    string                `json:"model"`
	// SampleRate is the share of completed shadow pairs that are judged (default 1.0).
	SampleRate *float64 `json:"sample_rate,omitempty"`
}

// EmbeddingConfig configures the optional embedding-similarity comparison.
type EmbeddingConfig struct {
	Provider schemas.ModelProvider `json:"provider"`
	Model    string                `json:"model"`
}

// ModelPrice is a manual price used when the model catalog has no entry for a
// model (self-hosted models, mocks) or when the operator wants to override it.
type ModelPrice struct {
	InputPerMillion  float64 `json:"input_per_million"`
	OutputPerMillion float64 `json:"output_per_million"`
}

// Thresholds decide when a candidate is ready to receive live traffic.
//
// A ratio left out of the config gets its default; one the config sets, 0
// included, is kept as given (see UnmarshalJSON). Built in Go, a zero ratio
// still means "use the default".
type Thresholds struct {
	// MinSamples is the number of completed comparisons needed before a verdict.
	MinSamples int `json:"min_samples,omitempty"`
	// MinAgreement is the minimum share of comparisons the candidate must pass.
	// "ready" requires the 95% Wilson lower bound to clear it; "promising" only the point estimate.
	MinAgreement float64 `json:"min_agreement"`
	// MaxErrorRate is the maximum share of candidate calls allowed to fail.
	MaxErrorRate float64 `json:"max_error_rate"`
	// QualityTolerance is how many judge points (1-10 scale) the candidate may trail by and still pass.
	QualityTolerance float64 `json:"quality_tolerance"`
	// LexicalThreshold is the token-overlap similarity needed to pass when neither judge nor embeddings ran.
	LexicalThreshold float64 `json:"lexical_threshold"`
	// SemanticThreshold is the embedding cosine similarity needed to pass when the judge did not run.
	SemanticThreshold float64 `json:"semantic_threshold"`
	// MaxJudgeErrorRate is the largest share of judge calls that may fail before a
	// candidate's verdict is withheld: a failing evaluator cannot vouch for anything.
	MaxJudgeErrorRate float64 `json:"max_judge_error_rate"`

	explicit thresholdFields // ratios the parsed config named, so an explicit 0 is kept
}

// thresholdFields flags Thresholds ratios that a parsed config set explicitly.
type thresholdFields uint8

const (
	explicitMinAgreement thresholdFields = 1 << iota
	explicitMaxErrorRate
	explicitQualityTolerance
	explicitLexicalThreshold
	explicitSemanticThreshold
	explicitMaxJudgeErrorRate
)

// UnmarshalJSON records which ratios the document sets, so normalize can tell an
// explicit 0 (honoured; the schema allows it) from an absent field (defaulted).
func (t *Thresholds) UnmarshalJSON(data []byte) error {
	type plain Thresholds
	aux := struct {
		*plain
		MinAgreement      *float64 `json:"min_agreement"`
		MaxErrorRate      *float64 `json:"max_error_rate"`
		QualityTolerance  *float64 `json:"quality_tolerance"`
		LexicalThreshold  *float64 `json:"lexical_threshold"`
		SemanticThreshold *float64 `json:"semantic_threshold"`
		MaxJudgeErrorRate *float64 `json:"max_judge_error_rate"`
	}{plain: (*plain)(t)}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	t.explicit = 0
	for _, f := range []struct {
		src  *float64
		dst  *float64
		flag thresholdFields
	}{
		{aux.MinAgreement, &t.MinAgreement, explicitMinAgreement},
		{aux.MaxErrorRate, &t.MaxErrorRate, explicitMaxErrorRate},
		{aux.QualityTolerance, &t.QualityTolerance, explicitQualityTolerance},
		{aux.LexicalThreshold, &t.LexicalThreshold, explicitLexicalThreshold},
		{aux.SemanticThreshold, &t.SemanticThreshold, explicitSemanticThreshold},
		{aux.MaxJudgeErrorRate, &t.MaxJudgeErrorRate, explicitMaxJudgeErrorRate},
	} {
		if f.src != nil {
			*f.dst = *f.src
			t.explicit |= f.flag
		}
	}
	return nil
}

// defaultRatio fills *v with def unless the config set it explicitly.
func (t *Thresholds) defaultRatio(v *float64, flag thresholdFields, def float64) {
	if *v == 0 && t.explicit&flag == 0 {
		*v = def
	}
}

// Config is the shadow plugin configuration.
type Config struct {
	// SampleRate is the default share of eligible requests mirrored (0 < rate <= 1).
	SampleRate float64 `json:"sample_rate,omitempty"`
	// Experiments lists the source -> candidate mirrors. At least one is required.
	Experiments []Experiment `json:"experiments"`
	// Judge enables LLM-as-judge scoring of each pair.
	Judge *JudgeConfig `json:"judge,omitempty"`
	// Embedding enables semantic similarity scoring of each pair.
	Embedding *EmbeddingConfig `json:"embedding,omitempty"`
	// MaxConcurrency bounds the shadow worker pool.
	MaxConcurrency int `json:"max_concurrency,omitempty"`
	// QueueSize bounds pending shadow jobs; jobs beyond it are dropped, never blocking live traffic.
	QueueSize int `json:"queue_size,omitempty"`
	// TimeoutSeconds bounds each shadow, judge and embedding call.
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
	// DailyBudgetUSD caps what shadow, judge and embedding calls may spend per UTC day (0 = unlimited).
	DailyBudgetUSD float64 `json:"daily_budget_usd,omitempty"`
	// VirtualKeys restricts mirroring to requests made with these virtual key IDs or names (empty = all).
	VirtualKeys []string `json:"virtual_keys,omitempty"`
	// AllowForceHeader lets callers force mirroring with "x-bf-shadow: force" (off by default; "off" always works).
	AllowForceHeader bool `json:"allow_force_header,omitempty"`
	// MaxRecords bounds the number of comparisons retained in memory.
	MaxRecords int `json:"max_records,omitempty"`
	// StorePayloads keeps (truncated) prompts and answers for the side-by-side diff view.
	StorePayloads *bool `json:"store_payloads,omitempty"`
	// MaxPayloadChars truncates stored prompts and answers.
	MaxPayloadChars int `json:"max_payload_chars,omitempty"`
	// PersistPath, when set, appends every comparison to this JSONL file and reloads it on start.
	PersistPath string `json:"persist_path,omitempty"`
	// Pricing overrides catalog prices, keyed by "provider/model" or "model".
	Pricing map[string]ModelPrice `json:"pricing,omitempty"`
	// Thresholds decide readiness verdicts.
	Thresholds Thresholds `json:"thresholds,omitempty"`
	// QualityFallback scores pairs no stronger signal could score: "none" (default,
	// the pair stays unscored) or "lexical" (token overlap).
	QualityFallback string `json:"quality_fallback,omitempty"`
	// Canary configures the guard that watches promoted candidates on live traffic.
	Canary *CanaryConfig `json:"canary,omitempty"`
}

// storePayloads reports whether prompts and answers are retained.
func (c *Config) storePayloads() bool {
	return c.StorePayloads == nil || *c.StorePayloads
}

// normalize fills defaults and validates the configuration.
func (c *Config) normalize() error {
	if c == nil {
		return errors.New("shadow: config is required")
	}
	if c.SampleRate == 0 {
		c.SampleRate = DefaultSampleRate
	}
	if c.SampleRate < 0 || c.SampleRate > 1 {
		return fmt.Errorf("shadow: sample_rate must be in (0, 1], got %v", c.SampleRate)
	}
	if len(c.Experiments) == 0 {
		return errors.New("shadow: at least one experiment is required")
	}
	seen := make(map[string]struct{}, len(c.Experiments))
	for i := range c.Experiments {
		exp := &c.Experiments[i]
		if strings.TrimSpace(exp.Source.Model) == "" {
			return fmt.Errorf("shadow: experiments[%d].source.model is required (use \"*\" for all models)", i)
		}
		if len(exp.Candidates) == 0 {
			return fmt.Errorf("shadow: experiments[%d] needs at least one candidate", i)
		}
		for j, cand := range exp.Candidates {
			if cand.Provider == "" || strings.TrimSpace(cand.Model) == "" {
				return fmt.Errorf("shadow: experiments[%d].candidates[%d] needs provider and model", i, j)
			}
		}
		if exp.SampleRate != nil && (*exp.SampleRate <= 0 || *exp.SampleRate > 1) {
			return fmt.Errorf("shadow: experiments[%d].sample_rate must be in (0, 1]", i)
		}
		if exp.Name == "" {
			names := make([]string, 0, len(exp.Candidates))
			for _, cand := range exp.Candidates {
				names = append(names, cand.String())
			}
			exp.Name = exp.Source.String() + " vs " + strings.Join(names, ", ")
		}
		if _, dup := seen[exp.Name]; dup {
			return fmt.Errorf("shadow: duplicate experiment name %q", exp.Name)
		}
		seen[exp.Name] = struct{}{}
	}
	if c.Judge != nil {
		if c.Judge.Provider == "" || c.Judge.Model == "" {
			return errors.New("shadow: judge needs provider and model")
		}
		if c.Judge.SampleRate != nil && (*c.Judge.SampleRate < 0 || *c.Judge.SampleRate > 1) {
			return errors.New("shadow: judge.sample_rate must be in [0, 1]")
		}
	}
	if c.Embedding != nil && (c.Embedding.Provider == "" || c.Embedding.Model == "") {
		return errors.New("shadow: embedding needs provider and model")
	}
	if c.MaxConcurrency <= 0 {
		c.MaxConcurrency = DefaultMaxConcurrency
	}
	if c.QueueSize <= 0 {
		c.QueueSize = DefaultQueueSize
	}
	if c.TimeoutSeconds <= 0 {
		c.TimeoutSeconds = DefaultTimeoutSeconds
	}
	if c.DailyBudgetUSD < 0 {
		return errors.New("shadow: daily_budget_usd cannot be negative")
	}
	if c.MaxRecords <= 0 {
		c.MaxRecords = DefaultMaxRecords
	}
	if c.MaxPayloadChars <= 0 {
		c.MaxPayloadChars = DefaultMaxPayloadChars
	}
	t := &c.Thresholds
	if t.MinSamples <= 0 {
		t.MinSamples = DefaultMinSamples
	}
	t.defaultRatio(&t.MinAgreement, explicitMinAgreement, DefaultMinAgreement)
	t.defaultRatio(&t.MaxErrorRate, explicitMaxErrorRate, DefaultMaxErrorRate)
	t.defaultRatio(&t.QualityTolerance, explicitQualityTolerance, DefaultQualityTolerance)
	t.defaultRatio(&t.LexicalThreshold, explicitLexicalThreshold, DefaultLexicalThreshold)
	t.defaultRatio(&t.SemanticThreshold, explicitSemanticThreshold, DefaultSemanticThresh)
	t.defaultRatio(&t.MaxJudgeErrorRate, explicitMaxJudgeErrorRate, DefaultMaxJudgeErrRate)
	if t.MinAgreement < 0 || t.MaxErrorRate < 0 || t.QualityTolerance < 0 || t.LexicalThreshold < 0 || t.SemanticThreshold < 0 || t.MaxJudgeErrorRate < 0 {
		return errors.New("shadow: thresholds cannot be negative")
	}
	if t.MinAgreement > 1 || t.MaxErrorRate > 1 || t.LexicalThreshold > 1 || t.SemanticThreshold > 1 || t.MaxJudgeErrorRate > 1 {
		return errors.New("shadow: threshold ratios must be <= 1")
	}
	if c.Canary != nil {
		if err := c.Canary.normalize(t); err != nil {
			return err
		}
	}
	switch strings.ToLower(strings.TrimSpace(c.QualityFallback)) {
	case "", QualityFallbackNone:
		c.QualityFallback = QualityFallbackNone
	case QualityFallbackLexical:
		c.QualityFallback = QualityFallbackLexical
	default:
		return fmt.Errorf("shadow: quality_fallback must be %q or %q, got %q", QualityFallbackNone, QualityFallbackLexical, c.QualityFallback)
	}
	for key, price := range c.Pricing {
		if price.InputPerMillion < 0 || price.OutputPerMillion < 0 {
			return fmt.Errorf("shadow: pricing[%q] cannot be negative", key)
		}
	}
	return nil
}

// experimentSampleRate returns the effective sample rate for an experiment.
func (c *Config) experimentSampleRate(exp *Experiment) float64 {
	if exp.SampleRate != nil {
		return *exp.SampleRate
	}
	return c.SampleRate
}

// judgeSampleRate returns the share of pairs that are judged.
func (c *Config) judgeSampleRate() float64 {
	if c.Judge == nil {
		return 0
	}
	if c.Judge.SampleRate == nil {
		return 1
	}
	return *c.Judge.SampleRate
}
