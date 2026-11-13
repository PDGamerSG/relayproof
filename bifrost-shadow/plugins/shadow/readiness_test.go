package shadow

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Regression for the review finding "structure-only fallback can label incorrect
// answers ready": JSON with the right keys but wrong values used to pass on
// structure alone, so 40 wrong approvals produced a "ready" candidate.
func TestWrongJSONValuesAreNeverReadyWithoutAJudge(t *testing.T) {
	const primary = `{"approved":false,"amount":100}`
	const candidate = `{"approved":true,"amount":999999}`

	cfg := baseConfig()
	cfg.Thresholds = Thresholds{MinSamples: 20}
	p := newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: candidate}).chat, nil, nil)
	for i := 0; i < 40; i++ {
		runPrimary(t, p, fmt.Sprintf("json-%d", i), "Approve this refund?", primary)
	}
	recs := waitForRecords(t, p, 40)
	for _, r := range recs {
		require.NotNil(t, r.Comparison.JSONMatch)
		assert.True(t, *r.Comparison.JSONMatch, "same keys and kinds")
		require.NotNil(t, r.Comparison.JSONValuesMatch)
		assert.False(t, *r.Comparison.JSONValuesMatch, "different values")
		assert.False(t, r.Pass)
		assert.Equal(t, BasisUnscored, r.PassBasis, "matching structure is not evidence of quality")
	}
	pair := p.Summary().Pairs[0]
	assert.Equal(t, 0, pair.Scored)
	assert.Equal(t, 40, pair.Unscored)
	assert.Equal(t, VerdictCollecting, pair.Verdict)
	assert.Contains(t, pair.VerdictReason, "no quality evaluator")

	// Opting into the lexical fallback scores the pairs, and they fail: token
	// overlap of the two documents is 0.5, below the 0.6 default.
	cfg = baseConfig()
	cfg.Thresholds = Thresholds{MinSamples: 20}
	cfg.QualityFallback = QualityFallbackLexical
	p = newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: candidate}).chat, nil, nil)
	for i := 0; i < 40; i++ {
		runPrimary(t, p, fmt.Sprintf("json-lex-%d", i), "Approve this refund?", primary)
	}
	waitForRecords(t, p, 40)
	pair = p.Summary().Pairs[0]
	assert.Equal(t, 40, pair.Scored)
	assert.Equal(t, 0, pair.Passes)
	assert.Equal(t, VerdictNotReady, pair.Verdict)
	assert.Equal(t, 40, pair.PassBasisCounts[BasisLexical])
}

// Regression for the same finding, judge variant: a judge that returns garbage
// for every pair used to fall back to structure and label the candidate ready.
func TestFailingJudgeCannotProduceAReadyVerdict(t *testing.T) {
	cfg := baseConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	cfg.QualityFallback = QualityFallbackLexical // even with the weakest fallback allowed
	cfg.Thresholds = Thresholds{MinSamples: 20}
	p := newTestPlugin(t, cfg)
	p.SetExecutors((&fakeClient{candidateText: `{"approved":true,"amount":999999}`, judgeReply: "I think B is better"}).chat, nil, nil)
	for i := 0; i < 40; i++ {
		runPrimary(t, p, fmt.Sprintf("judge-fail-%d", i), "Approve this refund?", `{"approved":false,"amount":100}`)
	}
	recs := waitForRecords(t, p, 40)
	for _, r := range recs {
		assert.NotEmpty(t, r.JudgeError)
		assert.Nil(t, r.Judge)
		assert.Equal(t, BasisUnscored, r.PassBasis, "a failed judge leaves the pair unscored")
	}
	pair := p.Summary().Pairs[0]
	assert.Equal(t, 40, pair.JudgeErrors)
	assert.InDelta(t, 1.0, pair.JudgeErrorRate, 1e-9)
	assert.Equal(t, VerdictCollecting, pair.Verdict)
	assert.Contains(t, pair.VerdictReason, "40 judge failures")
}

// Enough scored evidence does not help when the judge fails too often: the
// evaluator is unhealthy, so the verdict is withheld.
func TestJudgeErrorRateWithholdsVerdict(t *testing.T) {
	cfg := baseConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	require.NoError(t, cfg.normalize())
	name := cfg.Experiments[0].Name
	cand := cfg.Experiments[0].Candidates[0]
	var recs []*Record
	for i := 0; i < 400; i++ {
		r := &Record{Experiment: name, Candidate: cand, Comparison: &Comparison{}}
		if i < 60 {
			r.JudgeError, r.PassBasis = "judge reply is not valid JSON", BasisUnscored
		} else {
			r.Judge, r.Pass, r.PassBasis = &JudgeVerdict{PrimaryScore: 8, CandidateScore: 8, Winner: "tie"}, true, BasisJudge
		}
		recs = append(recs, r)
	}
	pair := summarize(recs, cfg, nil)[0]
	assert.Equal(t, 340, pair.Scored)
	assert.Equal(t, 1.0, pair.AgreementRate, "agreement is measured over scored pairs only")
	assert.InDelta(t, 0.15, pair.JudgeErrorRate, 1e-9)
	assert.Equal(t, VerdictNotReady, pair.Verdict, "15% judge failures exceed the 10% default")
	assert.Contains(t, pair.VerdictReason, "judge failed on 15.0%")

	cfg.Thresholds.MaxJudgeErrorRate = 0.2
	assert.Equal(t, VerdictReady, summarize(recs, cfg, nil)[0].Verdict)
}

func toolCallResponse(model string, calls ...ToolCall) *schemas.BifrostChatResponse {
	finish := "tool_calls"
	var tcs []schemas.ChatAssistantMessageToolCall
	for _, c := range calls {
		name := c.Name
		tcs = append(tcs, schemas.ChatAssistantMessageToolCall{Function: schemas.ChatAssistantMessageToolCallFunction{Name: &name, Arguments: c.Arguments}})
	}
	return &schemas.BifrostChatResponse{
		Model: model,
		Choices: []schemas.BifrostResponseChoice{{
			FinishReason: &finish,
			ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{Message: &schemas.ChatMessage{
				Role:                 schemas.ChatMessageRoleAssistant,
				ChatAssistantMessage: &schemas.ChatAssistantMessage{ToolCalls: tcs},
			}},
		}},
		Usage: &schemas.BifrostLLMUsage{PromptTokens: 10, CompletionTokens: 5},
		ExtraFields: schemas.BifrostResponseExtraFields{
			RequestType: schemas.ChatCompletionRequest,
			Provider:    "openai",
			RoutingInfo: schemas.RoutingInfo{Provider: "openai", Model: model},
		},
	}
}

// An agent executes whatever tool the model picks, so a candidate that selects a
// different tool fails even when the judge is happy with it.
func TestToolSelectionIsARequiredGate(t *testing.T) {
	cfg := baseConfig()
	cfg.Judge = &JudgeConfig{Provider: "openai", Model: judgeModel}
	p := newTestPlugin(t, cfg)
	chat := func(_ *schemas.BifrostContext, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, *schemas.BifrostError) {
		if req.Model == judgeModel {
			return chatResponse(req.Provider, req.Model, `{"score_a": 8, "score_b": 8, "winner": "tie", "reason": "both fine"}`, 10, 5, 1).ChatResponse, nil
		}
		return toolCallResponse(req.Model, ToolCall{Name: "search_web", Arguments: `{"q":"weather paris"}`}), nil
	}
	p.SetExecutors(chat, nil, nil)

	ctx := requestCtx("agent-turn")
	_, _, err := p.PreLLMHook(ctx, chatRequest(false, "openai", primaryModel, "weather in paris?"))
	require.NoError(t, err)
	_, _, err = p.PostLLMHook(ctx, &schemas.BifrostResponse{ChatResponse: toolCallResponse(primaryModel, ToolCall{Name: "get_weather", Arguments: `{"city":"Paris"}`})}, nil)
	require.NoError(t, err)

	r := waitForRecords(t, p, 1)[0]
	require.NotNil(t, r.Judge, "the judge still runs and is recorded")
	assert.False(t, r.Pass)
	assert.Equal(t, BasisToolSelection, r.PassBasis)
	assert.Equal(t, ToolDiffDifferentTool, r.Comparison.ToolCallDiff)

	pair := p.Summary().Pairs[0]
	assert.Equal(t, 1, pair.ToolTurns)
	require.NotNil(t, pair.ToolNameMatchRate)
	assert.Equal(t, 0.0, *pair.ToolNameMatchRate)
	assert.Equal(t, map[string]int{ToolDiffDifferentTool: 1}, pair.ToolDiffs)
}

func TestCompareAnswersToolDiffs(t *testing.T) {
	weather := ToolCall{Name: "get_weather", Arguments: `{"city":"Paris"}`}
	cases := []struct {
		name       string
		primary    Answer
		candidate  Answer
		diff       string
		namesMatch bool
		exact      bool
	}{
		{"identical", Answer{ToolCalls: []ToolCall{weather}}, Answer{ToolCalls: []ToolCall{{Name: "get_weather", Arguments: `{ "city": "Paris" }`}}}, "", true, true},
		{"missing", Answer{ToolCalls: []ToolCall{weather}}, Answer{Text: "It is sunny."}, ToolDiffMissing, false, false},
		{"extra", Answer{Text: "Hello!"}, Answer{ToolCalls: []ToolCall{weather}}, ToolDiffExtra, false, false},
		{"different tool", Answer{ToolCalls: []ToolCall{weather}}, Answer{ToolCalls: []ToolCall{{Name: "search", Arguments: `{}`}}}, ToolDiffDifferentTool, false, false},
		{"different args", Answer{ToolCalls: []ToolCall{weather}}, Answer{ToolCalls: []ToolCall{{Name: "get_weather", Arguments: `{"city":"Lyon"}`}}}, ToolDiffDifferentArgs, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmp := compareAnswers(tc.primary, tc.candidate)
			assert.Equal(t, tc.diff, cmp.ToolCallDiff)
			require.NotNil(t, cmp.ToolNamesMatch)
			assert.Equal(t, tc.namesMatch, *cmp.ToolNamesMatch)
			assert.Equal(t, tc.exact, cmp.ExactMatch)
		})
	}
}

func TestDecidePassOrder(t *testing.T) {
	cfg := baseConfig()
	cfg.Embedding = &EmbeddingConfig{Provider: "openai", Model: "embed"}
	require.NoError(t, cfg.normalize())
	p := &Plugin{config: cfg}
	f, tr := false, true
	sim := 0.95
	tie := &JudgeVerdict{PrimaryScore: 8, CandidateScore: 8}

	cases := []struct {
		name        string
		cmp         *Comparison
		verdict     *JudgeVerdict
		judgeFailed bool
		pass        bool
		basis       string
	}{
		{"json gate beats judge", &Comparison{JSONMatch: &f}, tie, false, false, BasisJSONSchema},
		{"tool gate beats judge", &Comparison{ToolNamesMatch: &f, ToolCallsMatch: &f}, tie, false, false, BasisToolSelection},
		{"judge decides", &Comparison{SemanticSimilarity: &sim}, &JudgeVerdict{PrimaryScore: 9, CandidateScore: 5}, false, false, BasisJudge},
		{"exact match without judge", &Comparison{ExactMatch: true}, nil, true, true, BasisExact},
		{"failed judge leaves pair unscored", &Comparison{SemanticSimilarity: &sim}, nil, true, false, BasisUnscored},
		{"tool arguments differ", &Comparison{ToolNamesMatch: &tr, ToolCallsMatch: &f, SemanticSimilarity: &sim}, nil, false, false, BasisToolArguments},
		{"semantic", &Comparison{SemanticSimilarity: &sim}, nil, false, true, BasisSemantic},
		{"no signal", &Comparison{LexicalSimilarity: 0.9}, nil, false, false, BasisUnscored},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pass, basis := p.decidePass(tc.cmp, tc.verdict, tc.judgeFailed)
			assert.Equal(t, tc.pass, pass)
			assert.Equal(t, tc.basis, basis)
		})
	}
}

func TestExactMatchIgnoresCaseAndWhitespace(t *testing.T) {
	cmp := compareAnswers(Answer{Text: "The answer is  42."}, Answer{Text: "the answer is 42.\n"})
	assert.True(t, cmp.ExactMatch)
	cmp = compareAnswers(Answer{Text: `{"a": 1, "b": [true]}`}, Answer{Text: "```json\n{\"b\":[true],\"a\":1.0}\n```"})
	assert.True(t, cmp.ExactMatch, "equal JSON values in a different key order and spelling")
}

func TestQualityFallbackConfig(t *testing.T) {
	parse := func(raw string) error {
		var c Config
		require.NoError(t, json.Unmarshal([]byte(raw), &c))
		return c.normalize()
	}
	exp := `"experiments":[{"source":{"model":"a"},"candidates":[{"provider":"openai","model":"b"}]}]`
	assert.NoError(t, parse(`{`+exp+`}`))
	assert.NoError(t, parse(`{`+exp+`,"quality_fallback":"lexical"}`))
	assert.NoError(t, parse(`{`+exp+`,"quality_fallback":"NONE"}`))
	assert.Error(t, parse(`{`+exp+`,"quality_fallback":"structural"}`))
	assert.Error(t, parse(`{`+exp+`,"thresholds":{"max_judge_error_rate":1.5}}`))
}
