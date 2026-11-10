package shadow

import (
	"encoding/json"
	"math"
	"reflect"
	"sort"
	"strings"
	"unicode"

	"github.com/maximhq/bifrost/core/schemas"
)

// ToolCall is the comparable shape of an assistant tool call.
type ToolCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Answer is the comparable projection of a chat completion.
type Answer struct {
	Text         string     `json:"text"`
	ToolCalls    []ToolCall `json:"tool_calls,omitempty"`
	FinishReason string     `json:"finish_reason,omitempty"`
}

// answerFromChatResponse extracts the first choice of a non-streaming chat
// completion. Only the first choice is compared: n>1 requests are rare and the
// candidate is asked for the same n, so choice 0 is the like-for-like pair.
func answerFromChatResponse(resp *schemas.BifrostChatResponse) Answer {
	var out Answer
	if resp == nil || len(resp.Choices) == 0 {
		return out
	}
	choice := resp.Choices[0]
	if choice.FinishReason != nil {
		out.FinishReason = *choice.FinishReason
	}
	if choice.ChatNonStreamResponseChoice == nil || choice.ChatNonStreamResponseChoice.Message == nil {
		return out
	}
	msg := choice.ChatNonStreamResponseChoice.Message
	out.Text = messageText(msg.Content)
	if msg.ChatAssistantMessage != nil {
		if out.Text == "" && msg.ChatAssistantMessage.Refusal != nil {
			out.Text = *msg.ChatAssistantMessage.Refusal
		}
		for _, tc := range msg.ChatAssistantMessage.ToolCalls {
			call := ToolCall{Arguments: tc.Function.Arguments}
			if tc.Function.Name != nil {
				call.Name = *tc.Function.Name
			}
			out.ToolCalls = append(out.ToolCalls, call)
		}
	}
	return out
}

// messageText flattens string or block content into plain text.
func messageText(content *schemas.ChatMessageContent) string {
	if content == nil {
		return ""
	}
	if content.ContentStr != nil {
		return *content.ContentStr
	}
	var b strings.Builder
	for _, block := range content.ContentBlocks {
		if block.Text != nil {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(*block.Text)
		}
	}
	return b.String()
}

// Comparison holds the deterministic metrics computed for one pair.
type Comparison struct {
	// LexicalSimilarity is a token-level F1 overlap in [0,1].
	LexicalSimilarity float64 `json:"lexical_similarity"`
	// SemanticSimilarity is the embedding cosine similarity in [-1,1]; nil when not computed.
	SemanticSimilarity *float64 `json:"semantic_similarity,omitempty"`
	// LengthRatio is len(candidate)/len(primary) in characters (0 when primary is empty).
	LengthRatio float64 `json:"length_ratio"`
	// ToolCallsMatch is nil when neither side called tools.
	ToolCallsMatch *bool `json:"tool_calls_match,omitempty"`
	// JSONMatch is nil unless the primary answer is a JSON document.
	JSONMatch *bool `json:"json_match,omitempty"`
	// FinishReasonMatch reports whether both stopped for the same reason.
	FinishReasonMatch bool `json:"finish_reason_match"`
}

// compareAnswers computes deterministic metrics between a primary and a candidate answer.
func compareAnswers(primary, candidate Answer) Comparison {
	cmp := Comparison{
		LexicalSimilarity: tokenF1(primary.Text, candidate.Text),
		FinishReasonMatch: normalizeFinish(primary.FinishReason) == normalizeFinish(candidate.FinishReason),
	}
	if p := len([]rune(primary.Text)); p > 0 {
		cmp.LengthRatio = float64(len([]rune(candidate.Text))) / float64(p)
	}
	if len(primary.ToolCalls) > 0 || len(candidate.ToolCalls) > 0 {
		match := toolCallsEqual(primary.ToolCalls, candidate.ToolCalls)
		cmp.ToolCallsMatch = &match
		// Tool-call turns usually carry no text; overlap of empty strings says nothing.
		if strings.TrimSpace(primary.Text) == "" && strings.TrimSpace(candidate.Text) == "" {
			if match {
				cmp.LexicalSimilarity = 1
			} else {
				cmp.LexicalSimilarity = 0
			}
		}
	}
	if pj, ok := parseJSONDocument(primary.Text); ok {
		cj, cok := parseJSONDocument(candidate.Text)
		match := cok && jsonShapeEqual(pj, cj)
		cmp.JSONMatch = &match
	}
	return cmp
}

func normalizeFinish(reason string) string {
	r := strings.ToLower(strings.TrimSpace(reason))
	switch r {
	case "end_turn", "stop_sequence", "":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use", "function_call":
		return "tool_calls"
	}
	return r
}

// tokenize lowercases and splits text into word tokens.
func tokenize(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// tokenF1 is the bag-of-words F1 overlap between two texts (SQuAD-style).
// Two empty texts are identical (1); one empty text shares nothing (0).
func tokenF1(a, b string) float64 {
	ta, tb := tokenize(a), tokenize(b)
	if len(ta) == 0 && len(tb) == 0 {
		return 1
	}
	if len(ta) == 0 || len(tb) == 0 {
		return 0
	}
	counts := make(map[string]int, len(ta))
	for _, t := range ta {
		counts[t]++
	}
	common := 0
	for _, t := range tb {
		if counts[t] > 0 {
			counts[t]--
			common++
		}
	}
	if common == 0 {
		return 0
	}
	precision := float64(common) / float64(len(tb))
	recall := float64(common) / float64(len(ta))
	return 2 * precision * recall / (precision + recall)
}

// toolCallsEqual compares tool calls as a multiset of (name, semantically equal arguments).
// Order is ignored because parallel tool calls carry no ordering guarantee.
func toolCallsEqual(a, b []ToolCall) bool {
	if len(a) != len(b) {
		return false
	}
	used := make([]bool, len(b))
	for _, ca := range a {
		found := false
		for j, cb := range b {
			if used[j] || ca.Name != cb.Name {
				continue
			}
			if argumentsEqual(ca.Arguments, cb.Arguments) {
				used[j] = true
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// argumentsEqual compares tool arguments as JSON values, falling back to trimmed strings.
func argumentsEqual(a, b string) bool {
	var va, vb any
	errA := json.Unmarshal([]byte(a), &va)
	errB := json.Unmarshal([]byte(b), &vb)
	if errA == nil && errB == nil {
		return reflect.DeepEqual(normalizeJSON(va), normalizeJSON(vb))
	}
	return strings.TrimSpace(a) == strings.TrimSpace(b)
}

// normalizeJSON makes numbers comparable regardless of int/float spelling and trims strings.
func normalizeJSON(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = normalizeJSON(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeJSON(val)
		}
		return out
	case string:
		return strings.TrimSpace(t)
	default:
		return t
	}
}

// parseJSONDocument parses text that is a JSON object or array, tolerating a
// surrounding markdown code fence.
func parseJSONDocument(text string) (any, bool) {
	s := strings.TrimSpace(text)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
		s = strings.TrimSpace(s)
	}
	if s == "" || (s[0] != '{' && s[0] != '[') {
		return nil, false
	}
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return nil, false
	}
	return v, true
}

// jsonShapeEqual reports whether two JSON documents have the same structure:
// the same object keys (recursively) and the same value kinds. Values themselves
// may differ — structured outputs are compared for schema conformance, while the
// judge or similarity metrics cover content.
func jsonShapeEqual(a, b any) bool {
	switch ta := a.(type) {
	case map[string]any:
		tb, ok := b.(map[string]any)
		if !ok || len(ta) != len(tb) {
			return false
		}
		keys := make([]string, 0, len(ta))
		for k := range ta {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			vb, ok := tb[k]
			if !ok || !jsonShapeEqual(ta[k], vb) {
				return false
			}
		}
		return true
	case []any:
		tb, ok := b.([]any)
		if !ok {
			return false
		}
		if len(ta) == 0 || len(tb) == 0 {
			return true
		}
		// Arrays may differ in length; compare element shape of the first entries.
		return jsonShapeEqual(ta[0], tb[0])
	case string:
		_, ok := b.(string)
		return ok
	case float64:
		_, ok := b.(float64)
		return ok
	case bool:
		_, ok := b.(bool)
		return ok
	case nil:
		return b == nil
	}
	return false
}

// cosine returns the cosine similarity of two vectors, or false if undefined.
func cosine(a, b []float64) (float64, bool) {
	if len(a) == 0 || len(a) != len(b) {
		return 0, false
	}
	var dot, na, nb float64
	for i := range a {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if na == 0 || nb == 0 {
		return 0, false
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb)), true
}

// wilsonLowerBound is the lower end of the 95% Wilson score interval for a
// binomial proportion. It is the conservative estimate used for "ready" verdicts:
// 19/20 passes and 950/1000 passes share a point estimate but not a lower bound.
func wilsonLowerBound(successes, n int) float64 {
	if n <= 0 {
		return 0
	}
	const z = 1.959963984540054
	p := float64(successes) / float64(n)
	nf := float64(n)
	denom := 1 + z*z/nf
	centre := p + z*z/(2*nf)
	margin := z * math.Sqrt((p*(1-p)+z*z/(4*nf))/nf)
	lb := (centre - margin) / denom
	if lb < 0 {
		return 0
	}
	return lb
}

// percentile returns the p-th percentile (0-100) of values using nearest-rank.
func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	rank := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	if rank < 0 {
		rank = 0
	}
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}

// truncate shortens s to at most n runes, marking the cut.
func truncate(s string, n int) string {
	if n <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…[truncated]"
}
