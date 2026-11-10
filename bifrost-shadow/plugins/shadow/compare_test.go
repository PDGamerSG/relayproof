package shadow

import (
	"math"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokenF1(t *testing.T) {
	assert.Equal(t, 1.0, tokenF1("", ""))
	assert.Equal(t, 0.0, tokenF1("hello", ""))
	assert.Equal(t, 1.0, tokenF1("The capital is Paris.", "the CAPITAL is paris"))
	assert.Equal(t, 0.0, tokenF1("alpha beta", "gamma delta"))
	// 2 common of 3 and 4 tokens: p=2/4, r=2/3, f1=0.5714
	assert.InDelta(t, 0.5714, tokenF1("a b c", "a b x y"), 1e-3)
}

func TestToolCallsEqualIgnoresOrderAndArgumentFormatting(t *testing.T) {
	a := []ToolCall{
		{Name: "get_weather", Arguments: `{"city":"Paris","unit":"c"}`},
		{Name: "get_time", Arguments: `{"tz":"CET"}`},
	}
	b := []ToolCall{
		{Name: "get_time", Arguments: `{ "tz" : "CET" }`},
		{Name: "get_weather", Arguments: `{"unit":"c","city":"Paris"}`},
	}
	assert.True(t, toolCallsEqual(a, b))

	c := []ToolCall{{Name: "get_weather", Arguments: `{"city":"London","unit":"c"}`}, {Name: "get_time", Arguments: `{"tz":"CET"}`}}
	assert.False(t, toolCallsEqual(a, c), "different argument values must not match")
	assert.False(t, toolCallsEqual(a, a[:1]), "different counts must not match")
	assert.True(t, argumentsEqual(`{"n":1}`, `{"n":1.0}`), "numbers compare by value")
	assert.True(t, argumentsEqual("not json", " not json "), "non-JSON falls back to trimmed string compare")
}

func TestJSONShapeEqual(t *testing.T) {
	pa, ok := parseJSONDocument("```json\n{\"name\":\"a\",\"tags\":[\"x\"],\"score\":1}\n```")
	require.True(t, ok)
	pb, ok := parseJSONDocument(`{"score": 9, "name": "b", "tags": ["y", "z"]}`)
	require.True(t, ok)
	assert.True(t, jsonShapeEqual(pa, pb), "same keys and kinds match even when values differ")

	pc, _ := parseJSONDocument(`{"name":"a","tags":"x","score":1}`)
	assert.False(t, jsonShapeEqual(pa, pc), "array vs string must not match")
	pd, _ := parseJSONDocument(`{"name":"a","score":1}`)
	assert.False(t, jsonShapeEqual(pa, pd), "missing key must not match")

	_, ok = parseJSONDocument("Sure! Here you go")
	assert.False(t, ok)
}

func TestCompareAnswers(t *testing.T) {
	cmp := compareAnswers(
		Answer{Text: `{"answer": 42}`, FinishReason: "stop"},
		Answer{Text: `{"answer": 41}`, FinishReason: "end_turn"},
	)
	require.NotNil(t, cmp.JSONMatch)
	assert.True(t, *cmp.JSONMatch)
	assert.True(t, cmp.FinishReasonMatch, "end_turn normalizes to stop")
	assert.Nil(t, cmp.ToolCallsMatch)

	tool := compareAnswers(
		Answer{ToolCalls: []ToolCall{{Name: "f", Arguments: `{}`}}},
		Answer{ToolCalls: []ToolCall{{Name: "f", Arguments: `{}`}}},
	)
	require.NotNil(t, tool.ToolCallsMatch)
	assert.True(t, *tool.ToolCallsMatch)
	assert.Equal(t, 1.0, tool.LexicalSimilarity, "matching tool-only turns are fully similar")

	assert.InDelta(t, 2.0, compareAnswers(Answer{Text: "ab"}, Answer{Text: "abcd"}).LengthRatio, 1e-9)
}

func TestCosine(t *testing.T) {
	s, ok := cosine([]float64{1, 0}, []float64{1, 0})
	require.True(t, ok)
	assert.InDelta(t, 1, s, 1e-9)
	s, _ = cosine([]float64{1, 0}, []float64{0, 1})
	assert.InDelta(t, 0, s, 1e-9)
	_, ok = cosine([]float64{1}, []float64{1, 2})
	assert.False(t, ok)
	_, ok = cosine([]float64{0, 0}, []float64{1, 2})
	assert.False(t, ok)
}

func TestWilsonLowerBound(t *testing.T) {
	assert.Equal(t, 0.0, wilsonLowerBound(0, 0))
	// Reference values for the 95% Wilson score interval.
	assert.InDelta(t, 0.7639, wilsonLowerBound(19, 20), 1e-3)
	assert.InDelta(t, 0.9347, wilsonLowerBound(950, 1000), 1e-3)
	assert.True(t, wilsonLowerBound(950, 1000) > wilsonLowerBound(19, 20), "more evidence, tighter bound")
	assert.False(t, math.IsNaN(wilsonLowerBound(0, 10)))
}

func TestPercentile(t *testing.T) {
	v := []float64{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}
	assert.Equal(t, 50.0, percentile(v, 50))
	assert.Equal(t, 100.0, percentile(v, 95))
	assert.Equal(t, 0.0, percentile(nil, 50))
}

func TestAnswerFromChatResponse(t *testing.T) {
	text := "hello"
	finish := "tool_calls"
	name := "lookup"
	resp := &schemas.BifrostChatResponse{Choices: []schemas.BifrostResponseChoice{{
		FinishReason: &finish,
		ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{Message: &schemas.ChatMessage{
			Role:    schemas.ChatMessageRoleAssistant,
			Content: &schemas.ChatMessageContent{ContentStr: &text},
			ChatAssistantMessage: &schemas.ChatAssistantMessage{ToolCalls: []schemas.ChatAssistantMessageToolCall{
				{Function: schemas.ChatAssistantMessageToolCallFunction{Name: &name, Arguments: `{"q":1}`}},
			}},
		}},
	}}}
	a := answerFromChatResponse(resp)
	assert.Equal(t, "hello", a.Text)
	assert.Equal(t, "tool_calls", a.FinishReason)
	require.Len(t, a.ToolCalls, 1)
	assert.Equal(t, "lookup", a.ToolCalls[0].Name)
	assert.Equal(t, Answer{}, answerFromChatResponse(nil))
}

func TestTruncate(t *testing.T) {
	assert.Equal(t, "abc", truncate("abc", 5))
	assert.Equal(t, "ab…[truncated]", truncate("abcdef", 2))
	assert.Equal(t, "hé…[truncated]", truncate("héllo", 2), "cuts on runes, not bytes")
}
