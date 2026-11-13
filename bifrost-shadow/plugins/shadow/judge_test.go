package shadow

import (
	"strings"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseJudgeReplyMapsPositionsBack(t *testing.T) {
	// Primary in slot A.
	v, err := parseJudgeReply(`{"score_a": 8, "score_b": 6, "winner": "A", "reason": "more complete"}`, false)
	require.NoError(t, err)
	assert.Equal(t, 8.0, v.PrimaryScore)
	assert.Equal(t, 6.0, v.CandidateScore)
	assert.Equal(t, "primary", v.Winner)
	assert.False(t, v.CandidateShownFirst)

	// Candidate in slot A: the same raw reply now favours the candidate.
	v, err = parseJudgeReply(`{"score_a": 8, "score_b": 6, "winner": "A", "reason": "x"}`, true)
	require.NoError(t, err)
	assert.Equal(t, 8.0, v.CandidateScore)
	assert.Equal(t, 6.0, v.PrimaryScore)
	assert.Equal(t, "candidate", v.Winner)
	assert.True(t, v.CandidateShownFirst)
}

func TestParseJudgeReplyToleratesFencesAndDerivesWinner(t *testing.T) {
	v, err := parseJudgeReply("```json\n{\"score_a\": 7, \"score_b\": 9, \"winner\": \"?\"}\n```", false)
	require.NoError(t, err)
	assert.Equal(t, "candidate", v.Winner, "winner derived from scores when the label is malformed")

	v, err = parseJudgeReply(`Verdict: {"score_a": 5, "score_b": 5, "winner": "tie"}`, false)
	require.NoError(t, err)
	assert.Equal(t, "tie", v.Winner)
}

func TestParseJudgeReplyRejectsGarbage(t *testing.T) {
	_, err := parseJudgeReply("I think A is better", false)
	assert.Error(t, err)
	_, err = parseJudgeReply(`{"score_a": 0, "score_b": 11, "winner": "A"}`, false)
	assert.Error(t, err, "scores outside 1-10 are rejected")
	_, err = parseJudgeReply(`{"score_a": "high"}`, false)
	assert.Error(t, err)
}

func TestBuildJudgeRequestRandomizesSlots(t *testing.T) {
	judge := &JudgeConfig{Provider: "openai", Model: "gpt-judge"}
	q := "What is 2+2?"
	conv := []schemas.ChatMessage{{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &q}}}
	primary := Answer{Text: "PRIMARY-ANSWER"}
	candidate := Answer{Text: "CANDIDATE-ANSWER"}

	req := buildJudgeRequest(judge, conv, primary, candidate, false)
	assert.Equal(t, schemas.ModelProvider("openai"), req.Provider)
	assert.Equal(t, "gpt-judge", req.Model)
	user := *req.Input[1].Content.ContentStr
	assert.Less(t, strings.Index(user, "PRIMARY-ANSWER"), strings.Index(user, "CANDIDATE-ANSWER"))
	assert.Contains(t, user, "What is 2+2?")

	req = buildJudgeRequest(judge, conv, primary, candidate, true)
	user = *req.Input[1].Content.ContentStr
	assert.Less(t, strings.Index(user, "CANDIDATE-ANSWER"), strings.Index(user, "PRIMARY-ANSWER"))

	// Defaults: a 300-token reply and no reasoning parameter.
	assert.Equal(t, DefaultJudgeMaxTokens, *req.Params.MaxCompletionTokens)
	assert.Nil(t, req.Params.Reasoning)
}

func TestJudgeRequestCarriesConfiguredTokensAndEffort(t *testing.T) {
	judge := &JudgeConfig{Provider: "anthropic", Model: "claude-opus-5-5", MaxTokens: 2048, Effort: "low"}
	q := "What is 2+2?"
	conv := []schemas.ChatMessage{{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &q}}}
	req := buildJudgeRequest(judge, conv, Answer{Text: "4"}, Answer{Text: "4"}, false)
	assert.Equal(t, 2048, *req.Params.MaxCompletionTokens)
	if assert.NotNil(t, req.Params.Reasoning) && assert.NotNil(t, req.Params.Reasoning.Effort) {
		assert.Equal(t, "low", *req.Params.Reasoning.Effort)
	}
}

func TestJudgeMaxTokensValidation(t *testing.T) {
	cfg := &Config{
		Experiments: []Experiment{{Name: "e", Source: ModelRef{Model: "a"}, Candidates: []ModelRef{{Provider: "openai", Model: "b"}}}},
		Judge:       &JudgeConfig{Provider: "openai", Model: "j", MaxTokens: -1},
	}
	assert.Error(t, cfg.normalize())

	cfg.Judge.MaxTokens = 0
	if assert.NoError(t, cfg.normalize()) {
		assert.Equal(t, DefaultJudgeMaxTokens, cfg.Judge.MaxTokens)
	}
}

func TestRenderTranscriptKeepsMostRecentTurns(t *testing.T) {
	long := strings.Repeat("old ", 5000)
	recent := "the latest question"
	conv := []schemas.ChatMessage{
		{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &long}},
		{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &recent}},
	}
	out := renderTranscript(conv, 200)
	assert.Contains(t, out, "the latest question")
	assert.True(t, strings.HasPrefix(out, "…[earlier turns omitted]"))
}
