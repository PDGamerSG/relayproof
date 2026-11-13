package shadow

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
)

// JudgeVerdict is the LLM judge's assessment of a pair, expressed from the
// candidate's point of view (the A/B order shown to the judge is randomized).
type JudgeVerdict struct {
	PrimaryScore   float64 `json:"primary_score"`
	CandidateScore float64 `json:"candidate_score"`
	// Winner is "primary", "candidate" or "tie".
	Winner string `json:"winner"`
	Reason string `json:"reason,omitempty"`
	// CandidateShownFirst records the randomized position, for position-bias audits.
	CandidateShownFirst bool `json:"candidate_shown_first"`
}

const judgeSystemPrompt = `You are an impartial evaluator comparing two AI assistant responses to the same conversation.
Judge which response better serves the user: correctness, completeness, instruction following, format, and safety.
Do not prefer longer responses for being longer. Do not let the order of the responses influence you.
If responses include tool calls, judge whether the chosen tool and arguments are appropriate.
Reply with ONLY a JSON object, no prose and no code fences:
{"score_a": <integer 1-10>, "score_b": <integer 1-10>, "winner": "A" | "B" | "tie", "reason": "<one short sentence>"}`

// maxJudgeTranscriptChars bounds the conversation excerpt sent to the judge.
const maxJudgeTranscriptChars = 12000

// buildJudgeRequest builds the judge prompt. candidateFirst places the candidate
// answer in slot A.
func buildJudgeRequest(judge *JudgeConfig, conversation []schemas.ChatMessage, primary, candidate Answer, candidateFirst bool) *schemas.BifrostChatRequest {
	a, b := primary, candidate
	if candidateFirst {
		a, b = candidate, primary
	}
	var sb strings.Builder
	sb.WriteString("## Conversation\n")
	sb.WriteString(renderTranscript(conversation, maxJudgeTranscriptChars))
	sb.WriteString("\n\n## Response A\n")
	sb.WriteString(renderAnswer(a))
	sb.WriteString("\n\n## Response B\n")
	sb.WriteString(renderAnswer(b))
	user := sb.String()
	system := judgeSystemPrompt
	maxTokens := judge.MaxTokens
	if maxTokens <= 0 {
		maxTokens = DefaultJudgeMaxTokens
	}
	// Temperature 0 for repeatable verdicts; the gateway drops it for models
	// that reject sampling parameters.
	temperature := 0.0
	params := &schemas.ChatParameters{
		MaxCompletionTokens: &maxTokens,
		Temperature:         &temperature,
	}
	if judge.Effort != "" {
		effort := judge.Effort
		params.Reasoning = &schemas.ChatReasoning{Effort: &effort}
	}
	return &schemas.BifrostChatRequest{
		Provider: judge.Provider,
		Model:    judge.Model,
		Input: []schemas.ChatMessage{
			{Role: schemas.ChatMessageRoleSystem, Content: &schemas.ChatMessageContent{ContentStr: &system}},
			{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &user}},
		},
		Params: params,
	}
}

// renderTranscript renders the conversation, keeping the most recent turns
// when it exceeds limit characters.
func renderTranscript(messages []schemas.ChatMessage, limit int) string {
	parts := make([]string, 0, len(messages))
	for _, m := range messages {
		text := messageText(m.Content)
		if m.ChatAssistantMessage != nil {
			for _, tc := range m.ChatAssistantMessage.ToolCalls {
				name := ""
				if tc.Function.Name != nil {
					name = *tc.Function.Name
				}
				text += fmt.Sprintf("\n[tool call] %s(%s)", name, tc.Function.Arguments)
			}
		}
		parts = append(parts, fmt.Sprintf("[%s] %s", m.Role, strings.TrimSpace(text)))
	}
	out := strings.Join(parts, "\n")
	if r := []rune(out); len(r) > limit {
		out = "…[earlier turns omitted]\n" + string(r[len(r)-limit:])
	}
	return out
}

func renderAnswer(a Answer) string {
	var sb strings.Builder
	if strings.TrimSpace(a.Text) != "" {
		sb.WriteString(truncate(a.Text, maxJudgeTranscriptChars/2))
	}
	for _, tc := range a.ToolCalls {
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString(fmt.Sprintf("[tool call] %s(%s)", tc.Name, tc.Arguments))
	}
	if sb.Len() == 0 {
		return "(empty response)"
	}
	return sb.String()
}

// rawJudgeReply is the JSON shape requested from the judge.
type rawJudgeReply struct {
	ScoreA float64 `json:"score_a"`
	ScoreB float64 `json:"score_b"`
	Winner string  `json:"winner"`
	Reason string  `json:"reason"`
}

// parseJudgeReply parses the judge's JSON reply and maps A/B back to primary/candidate.
func parseJudgeReply(text string, candidateFirst bool) (*JudgeVerdict, error) {
	s := strings.TrimSpace(text)
	// Tolerate code fences or prose around the object.
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("judge reply contains no JSON object: %q", truncate(s, 200))
	}
	var raw rawJudgeReply
	if err := json.Unmarshal([]byte(s[start:end+1]), &raw); err != nil {
		return nil, fmt.Errorf("judge reply is not valid JSON: %w", err)
	}
	if raw.ScoreA < 1 || raw.ScoreA > 10 || raw.ScoreB < 1 || raw.ScoreB > 10 {
		return nil, fmt.Errorf("judge scores out of range: a=%v b=%v", raw.ScoreA, raw.ScoreB)
	}
	v := &JudgeVerdict{Reason: truncate(raw.Reason, 500), CandidateShownFirst: candidateFirst}
	if candidateFirst {
		v.CandidateScore, v.PrimaryScore = raw.ScoreA, raw.ScoreB
	} else {
		v.PrimaryScore, v.CandidateScore = raw.ScoreA, raw.ScoreB
	}
	switch strings.ToUpper(strings.TrimSpace(raw.Winner)) {
	case "A":
		v.Winner = "primary"
		if candidateFirst {
			v.Winner = "candidate"
		}
	case "B":
		v.Winner = "candidate"
		if candidateFirst {
			v.Winner = "primary"
		}
	case "TIE":
		v.Winner = "tie"
	default:
		// Derive from scores when the label is missing or malformed.
		switch {
		case v.CandidateScore > v.PrimaryScore:
			v.Winner = "candidate"
		case v.CandidateScore < v.PrimaryScore:
			v.Winner = "primary"
		default:
			v.Winner = "tie"
		}
	}
	return v, nil
}
