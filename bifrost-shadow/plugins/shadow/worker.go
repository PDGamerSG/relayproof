package shadow

import (
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

var errExecutorNotConfigured = errors.New("shadow: chat executor is not configured")

// worker drains the job queue until the plugin stops. A job still queued when
// the plugin stops is dropped, not started.
func (p *Plugin) worker() {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			return
		case j := <-p.queue:
			// select picks at random when both cases are ready.
			if p.ctx.Err() != nil {
				return
			}
			p.runJobContained(j)
		}
	}
}

// runJobContained runs one job and keeps the worker alive if the job's own
// panic recovery panics too (for example while storing the error record).
func (p *Plugin) runJobContained(j *job) {
	p.inFlight.Add(1)
	defer p.inFlight.Add(-1)
	defer func() {
		if r := recover(); r != nil {
			p.logger.Warn("shadow: worker recovered from a panic while finishing a job: %v", r)
		}
	}()
	p.runJob(j)
}

// runJob calls the candidate, scores the pair and stores the record. A panic in
// a provider or pricing path is recorded as a candidate error. Each job is
// accounted and stored at most once. A job whose calls were cancelled because
// the plugin is stopping is dropped: its error says nothing about the candidate.
func (p *Plugin) runJob(j *job) {
	rec := &Record{
		ID:               uuid.NewString(),
		RequestID:        j.requestID,
		Experiment:       j.experiment,
		CreatedAt:        p.now(),
		Stream:           j.stream,
		Primary:          j.primary,
		Candidate:        j.candidate,
		Prompt:           j.prompt,
		PrimaryLatencyMs: j.latencyMs,
	}
	finished := false
	done := func() {
		if finished {
			return
		}
		finished = true
		if p.ctx.Err() != nil {
			return
		}
		p.finish(rec)
	}
	defer func() {
		if r := recover(); r != nil {
			if finished {
				p.logger.Warn("shadow: panic after a job was accounted: %v", r)
				return
			}
			rec.CandidateError = fmt.Sprintf("shadow worker panic: %v", r)
			done()
		}
	}()

	rec.PrimaryCostUSD = p.cost(j.usage, j.primary.Provider, j.primary.Model, schemas.ChatCompletionRequest)
	if j.usage != nil {
		rec.PrimaryInputTokens = j.usage.PromptTokens
		rec.PrimaryOutputTokens = j.usage.CompletionTokens
	}
	if p.config.storePayloads() {
		primary := j.answer
		primary.Text = truncate(primary.Text, p.config.MaxPayloadChars)
		rec.PrimaryAnswer = &primary
	}

	// Reserve the expected cost of this job before any call is made, so jobs
	// running at the same time cannot all slip under the daily budget at once.
	reservation, ok := p.ledger.reserve(p.today(), p.config.DailyBudgetUSD)
	if !ok {
		p.budgetSkipped.Add(1)
		return
	}
	defer p.ledger.release(reservation)

	ex := p.execs.Load()
	if ex == nil || ex.chat == nil {
		rec.CandidateError = errExecutorNotConfigured.Error()
		done()
		return
	}

	original, err := decodeSnapshot(j.snapshot)
	if err != nil {
		rec.CandidateError = fmt.Sprintf("decode snapshot: %v", err)
		done()
		return
	}
	candReq := *original
	candReq.Provider = j.candidate.Provider
	candReq.Model = j.candidate.Model
	if candReq.Params != nil {
		params := *candReq.Params
		params.StreamOptions = nil
		candReq.Params = &params
	}

	ctx, cancel := p.internalContext()
	if j.passthroughExtra {
		ctx.SetValue(schemas.BifrostContextKeyPassthroughExtraParams, true)
	}
	start := time.Now()
	resp, bErr := ex.chat(ctx, &candReq)
	wall := time.Since(start).Milliseconds()
	cancel()
	if bErr != nil {
		rec.CandidateError = bifrostErrorMessage(bErr)
		done()
		return
	}
	// Account the call before anything else can fail: the provider has billed it,
	// and a panic further down must not drop its cost from the daily budget.
	rec.CandidateLatencyMs = wall
	if resp != nil {
		if resp.ExtraFields.Latency > 0 {
			rec.CandidateLatencyMs = resp.ExtraFields.Latency
		}
		if resp.Usage != nil {
			rec.CandidateInputTokens = resp.Usage.PromptTokens
			rec.CandidateOutputTokens = resp.Usage.CompletionTokens
		}
		rec.CandidateCostUSD = p.cost(resp.Usage, j.candidate.Provider, j.candidate.Model, schemas.ChatCompletionRequest)
	}
	candAnswer := answerFromChatResponse(resp)

	cmp := compareAnswers(j.answer, candAnswer)
	rec.Comparison = &cmp

	if ex.embed != nil && p.config.Embedding != nil && j.answer.Text != "" && candAnswer.Text != "" {
		sim, cost, err := p.embeddingSimilarity(ex.embed, j.answer.Text, candAnswer.Text)
		// A call that returned unusable vectors was still billed.
		rec.EvalCostUSD += cost
		if err == nil {
			rec.Comparison.SemanticSimilarity = &sim
		} else {
			p.logger.Debug("shadow: embedding similarity failed: %v", err)
		}
	}

	if p.config.Judge != nil && p.randFloat() < p.config.judgeSampleRate() {
		verdict, cost, err := p.judgePair(ex.chat, original.Input, j.answer, candAnswer)
		rec.EvalCostUSD += cost
		if err != nil {
			rec.JudgeError = err.Error()
		} else {
			rec.Judge = verdict
		}
	}

	if p.config.storePayloads() {
		cand := candAnswer
		cand.Text = truncate(cand.Text, p.config.MaxPayloadChars)
		rec.CandidateAnswer = &cand
	}
	rec.Pass, rec.PassBasis = p.decidePass(rec.Comparison, rec.Judge, rec.JudgeError != "")
	done()
}

// finish accounts spend and stores the record. Counters are updated before the
// store call so that a failing store cannot leave the job half accounted.
func (p *Plugin) finish(rec *Record) {
	p.addSpend(rec.CandidateCostUSD + rec.EvalCostUSD)
	if rec.CandidateError != "" {
		p.candidateErrs.Add(1)
	}
	p.completed.Add(1)
	if err := p.storeRecord(rec); err != nil {
		p.logger.Warn("shadow: failed to persist record: %v", err)
	}
}

// Pass bases name the signal that decided a record's Pass.
const (
	// BasisToolSelection: the candidate selected different tools (a required gate).
	BasisToolSelection = "tool_selection"
	// BasisJSONSchema: the primary answered in JSON and the candidate's answer is not
	// JSON of the same structure (a required gate).
	BasisJSONSchema = "json_schema"
	// BasisJudge: the LLM judge's scores decided.
	BasisJudge = "judge"
	// BasisExact: the candidate gave the same answer (normalized text or JSON values,
	// and the same tool calls).
	BasisExact = "exact"
	// BasisToolArguments: same tools, different arguments, and no judge to arbitrate.
	BasisToolArguments = "tool_arguments"
	// BasisSemantic: embedding similarity decided.
	BasisSemantic = "semantic"
	// BasisLexical: token overlap decided (only with quality_fallback "lexical").
	BasisLexical = "lexical"
	// BasisUnscored: no usable quality signal; the record counts toward neither
	// agreement nor the sample minimum.
	BasisUnscored = "unscored"
)

// decidePass applies the pass rule and returns the outcome with the signal that
// decided it; BasisUnscored means no usable signal.
//
// Deterministic checks an application depends on come first and are required:
// a candidate that selects different tools, or breaks the JSON structure the
// primary returned, fails whatever any other signal says. After the gates the
// strongest available quality signal decides: judge, then an exact match (a
// tool-only turn with identical calls is one), then embeddings, then (only when
// the operator opted in) token overlap. Same tools with different arguments fail
// unless a judge accepted them.
//
// A judge that was asked and failed leaves the pair unscored rather than letting
// a weaker signal (embeddings, overlap) stand in for it, so evaluator failures can
// never add up to a "ready" verdict; scorecards report the judge error rate
// instead. An exact match still passes: it needs no evaluator.
func (p *Plugin) decidePass(cmp *Comparison, verdict *JudgeVerdict, judgeFailed bool) (bool, string) {
	if cmp == nil {
		return false, BasisUnscored
	}
	if cmp.ToolNamesMatch != nil && !*cmp.ToolNamesMatch {
		return false, BasisToolSelection
	}
	if cmp.JSONMatch != nil && !*cmp.JSONMatch {
		return false, BasisJSONSchema
	}
	t := &p.config.Thresholds
	if verdict != nil {
		return verdict.CandidateScore >= verdict.PrimaryScore-t.QualityTolerance, BasisJudge
	}
	if cmp.ExactMatch {
		return true, BasisExact
	}
	if judgeFailed {
		return false, BasisUnscored
	}
	if cmp.ToolCallsMatch != nil && !*cmp.ToolCallsMatch {
		return false, BasisToolArguments
	}
	if cmp.SemanticSimilarity != nil {
		return *cmp.SemanticSimilarity >= t.SemanticThreshold, BasisSemantic
	}
	if p.config.QualityFallback == QualityFallbackLexical {
		return cmp.LexicalSimilarity >= t.LexicalThreshold, BasisLexical
	}
	return false, BasisUnscored
}

// internalContext builds a context for a plugin-owned sub-request: it skips the
// plugin pipeline (no recursion, no governance billing, no shadow-of-shadow)
// and carries none of the caller's key routing or body-transport state.
func (p *Plugin) internalContext() (*schemas.BifrostContext, func()) {
	deadline := time.Now().Add(time.Duration(p.config.TimeoutSeconds) * time.Second)
	ctx := schemas.NewBifrostContext(p.ctx, deadline)
	bifrost.PrepareContextForInternalRequest(ctx)
	ctx.SetValue(schemas.BifrostContextKeyRequestID, "shadow-"+uuid.NewString())
	// MCP runs outside the plugin pipeline, so skipping plugins does not stop it
	// from adding its tools or running its agent loop on a shadow call. A non-nil
	// empty allow-list admits no client and no tool.
	ctx.SetValue(schemas.MCPContextKeyIncludeClients, []string{})
	ctx.SetValue(schemas.MCPContextKeyIncludeTools, []string{})
	return ctx, ctx.Cancel
}

// embeddingSimilarity embeds both answers in one request and returns their cosine similarity.
func (p *Plugin) embeddingSimilarity(embed EmbeddingExecutor, a, b string) (float64, float64, error) {
	a = truncate(a, 8000)
	b = truncate(b, 8000)
	req := &schemas.BifrostEmbeddingRequest{
		Provider: p.config.Embedding.Provider,
		Model:    p.config.Embedding.Model,
		Input: []schemas.EmbeddingInputItem{
			{Content: schemas.EmbeddingContent{{Type: schemas.EmbeddingContentPartTypeText, Text: &a}}},
			{Content: schemas.EmbeddingContent{{Type: schemas.EmbeddingContentPartTypeText, Text: &b}}},
		},
	}
	ctx, cancel := p.internalContext()
	defer cancel()
	resp, bErr := embed(ctx, req)
	if bErr != nil {
		return 0, 0, errors.New(bifrostErrorMessage(bErr))
	}
	if resp == nil || len(resp.Data) < 2 {
		return 0, 0, errors.New("embedding response has fewer than two vectors")
	}
	va, vb := vectorOf(resp.Data, 0), vectorOf(resp.Data, 1)
	sim, ok := cosine(va, vb)
	cost := p.cost(resp.Usage, p.config.Embedding.Provider, p.config.Embedding.Model, schemas.EmbeddingRequest)
	if !ok {
		return 0, cost, errors.New("embedding vectors are empty or mismatched")
	}
	return sim, cost, nil
}

// vectorOf returns the float vector for the item with the given input index.
func vectorOf(data []schemas.EmbeddingData, index int) []float64 {
	for _, d := range data {
		if d.Index == index {
			return d.Embedding.EmbeddingArray
		}
	}
	if index < len(data) {
		return data[index].Embedding.EmbeddingArray
	}
	return nil
}

// judgePair asks the judge model to score both answers.
func (p *Plugin) judgePair(chat ChatExecutor, conversation []schemas.ChatMessage, primary, candidate Answer) (*JudgeVerdict, float64, error) {
	candidateFirst := p.randFloat() < 0.5
	req := buildJudgeRequest(p.config.Judge, conversation, primary, candidate, candidateFirst)
	ctx, cancel := p.internalContext()
	defer cancel()
	resp, bErr := chat(ctx, req)
	if bErr != nil {
		return nil, 0, fmt.Errorf("judge call failed: %s", bifrostErrorMessage(bErr))
	}
	var cost float64
	if resp != nil {
		cost = p.cost(resp.Usage, p.config.Judge.Provider, p.config.Judge.Model, schemas.ChatCompletionRequest)
	}
	verdict, err := parseJudgeReply(answerFromChatResponse(resp).Text, candidateFirst)
	return verdict, cost, err
}

// bifrostErrorMessage renders a BifrostError for records.
func bifrostErrorMessage(e *schemas.BifrostError) string {
	if e == nil {
		return ""
	}
	msg := ""
	if e.Error != nil {
		msg = e.Error.Message
		if msg == "" && e.Error.Error != nil {
			msg = e.Error.Error.Error()
		}
	}
	if msg == "" {
		msg = "unknown error"
	}
	if e.StatusCode != nil {
		return fmt.Sprintf("HTTP %d: %s", *e.StatusCode, truncate(msg, 500))
	}
	return truncate(msg, 500)
}
