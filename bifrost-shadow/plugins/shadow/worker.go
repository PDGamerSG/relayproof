package shadow

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

var errExecutorNotConfigured = errors.New("shadow: chat executor is not configured")

// worker drains the job queue until the plugin stops.
func (p *Plugin) worker() {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			return
		case j := <-p.queue:
			p.inFlight.Add(1)
			p.runJob(j)
			p.inFlight.Add(-1)
		}
	}
}

// runJob calls the candidate, scores the pair and stores the record. It never panics
// out of the worker: a panic in a provider path is recorded as a candidate error.
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
		PrimaryCostUSD:   p.cost(j.usage, j.primary.Provider, j.primary.Model, schemas.ChatCompletionRequest),
	}
	if j.usage != nil {
		rec.PrimaryInputTokens = j.usage.PromptTokens
		rec.PrimaryOutputTokens = j.usage.CompletionTokens
	}
	if p.config.storePayloads() {
		primary := j.answer
		primary.Text = truncate(primary.Text, p.config.MaxPayloadChars)
		rec.PrimaryAnswer = &primary
	}

	defer func() {
		if r := recover(); r != nil {
			rec.CandidateError = fmt.Sprintf("shadow worker panic: %v", r)
			p.finish(rec)
		}
	}()

	if p.budgetExhausted() {
		p.budgetSkipped.Add(1)
		return
	}

	ex := p.execs.Load()
	if ex == nil || ex.chat == nil {
		rec.CandidateError = errExecutorNotConfigured.Error()
		p.finish(rec)
		return
	}

	var original schemas.BifrostChatRequest
	if err := json.Unmarshal(j.snapshot, &original); err != nil {
		rec.CandidateError = fmt.Sprintf("decode snapshot: %v", err)
		p.finish(rec)
		return
	}
	candReq := original
	candReq.Provider = j.candidate.Provider
	candReq.Model = j.candidate.Model
	if candReq.Params != nil {
		params := *candReq.Params
		params.StreamOptions = nil
		candReq.Params = &params
	}

	ctx, cancel := p.internalContext()
	start := time.Now()
	resp, bErr := ex.chat(ctx, &candReq)
	wall := time.Since(start).Milliseconds()
	cancel()
	if bErr != nil {
		rec.CandidateError = bifrostErrorMessage(bErr)
		p.finish(rec)
		return
	}
	candAnswer := answerFromChatResponse(resp)
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

	cmp := compareAnswers(j.answer, candAnswer)
	rec.Comparison = &cmp

	if ex.embed != nil && p.config.Embedding != nil && j.answer.Text != "" && candAnswer.Text != "" {
		if sim, cost, err := p.embeddingSimilarity(ex.embed, j.answer.Text, candAnswer.Text); err == nil {
			rec.Comparison.SemanticSimilarity = &sim
			rec.EvalCostUSD += cost
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
	rec.Pass, rec.PassBasis = p.decidePass(rec.Comparison, rec.Judge)
	p.finish(rec)
}

// finish accounts spend and stores the record.
func (p *Plugin) finish(rec *Record) {
	p.addSpend(rec.CandidateCostUSD + rec.EvalCostUSD)
	if rec.CandidateError != "" {
		p.candidateErrs.Add(1)
	}
	p.completed.Add(1)
	if err := p.store.add(rec); err != nil {
		p.logger.Warn("shadow: failed to persist record: %v", err)
	}
}

// decidePass applies the pass rule, strongest signal first:
// judge > tool calls / JSON structure > embeddings > lexical overlap.
func (p *Plugin) decidePass(cmp *Comparison, verdict *JudgeVerdict) (bool, string) {
	t := &p.config.Thresholds
	if verdict != nil {
		return verdict.CandidateScore >= verdict.PrimaryScore-t.QualityTolerance, "judge"
	}
	if cmp == nil {
		return false, ""
	}
	if cmp.ToolCallsMatch != nil {
		return *cmp.ToolCallsMatch, "structural"
	}
	if cmp.JSONMatch != nil {
		if !*cmp.JSONMatch {
			return false, "structural"
		}
		if cmp.SemanticSimilarity != nil {
			return *cmp.SemanticSimilarity >= t.SemanticThreshold, "semantic"
		}
		return true, "structural"
	}
	if cmp.SemanticSimilarity != nil {
		return *cmp.SemanticSimilarity >= t.SemanticThreshold, "semantic"
	}
	return cmp.LexicalSimilarity >= t.LexicalThreshold, "lexical"
}

// internalContext builds a context for a plugin-owned sub-request: it skips the
// plugin pipeline (no recursion, no governance billing, no shadow-of-shadow)
// and carries none of the caller's key routing or body-transport state.
func (p *Plugin) internalContext() (*schemas.BifrostContext, func()) {
	deadline := time.Now().Add(time.Duration(p.config.TimeoutSeconds) * time.Second)
	ctx := schemas.NewBifrostContext(p.ctx, deadline)
	bifrost.PrepareContextForInternalRequest(ctx)
	ctx.SetValue(schemas.BifrostContextKeyRequestID, "shadow-"+uuid.NewString())
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
