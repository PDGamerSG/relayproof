package main

// An Anthropic Messages API (POST /v1/messages) face for the same mock models,
// so the Claude configuration of the hosted demo can be tested end to end
// without an API key. Claude model names map onto the OpenAI-style profiles:
//
//	claude-opus-5-5    -> gpt-4o        (premium primary)
//	claude-sonnet-5-5  -> gpt-4o-mini   (strong cheaper candidate)
//	claude-haiku-5-5   -> llama-3.1-8b  (weak cheaper candidate)
//
// A request whose last user message holds a judge prompt ("## Response A") is
// answered by the mock judge, whatever model it names. Only non-streaming
// requests are supported.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var claudeAliases = map[string]string{
	"claude-opus-5-5":   "gpt-4o",
	"claude-sonnet-5-5": "gpt-4o-mini",
	"claude-haiku-5-5":  "llama-3.1-8b",
}

type anthropicRequest struct {
	Model    string          `json:"model"`
	Messages []message       `json:"messages"`
	Tools    json.RawMessage `json:"tools"`
	Stream   bool            `json:"stream"`
}

func writeAnthropicError(w http.ResponseWriter, status int, kind, msg string) {
	writeJSON(w, status, map[string]any{"type": "error", "error": map[string]any{"type": kind, "message": msg}})
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAnthropicError(w, http.StatusMethodNotAllowed, "invalid_request_error", "use POST")
		return
	}
	var req anthropicRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON body")
		return
	}
	if req.Stream {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "the mock serves /v1/messages without streaming only")
		return
	}
	model := req.Model
	if alias, ok := claudeAliases[model]; ok {
		model = alias
	}
	chat := chatRequest{Model: model, Messages: req.Messages, Tools: req.Tools}
	var rep reply
	if strings.Contains(lastUser(req.Messages), "## Response A") {
		rep = judge(chat)
	} else {
		rep = answer(chat)
	}
	if inIncident(req.Model) || inIncident(model) {
		rep.status = 529
	}
	time.Sleep(rep.latency)
	if rep.status != 0 {
		writeAnthropicError(w, rep.status, "overloaded_error", "Overloaded")
		return
	}

	inputTokens := 10
	for _, m := range req.Messages {
		inputTokens += countTokens(contentText(m.Content))
	}
	outputTokens := countTokens(rep.text)
	content := []map[string]any{}
	if rep.text != "" {
		content = append(content, map[string]any{"type": "text", "text": rep.text})
	}
	stop := "end_turn"
	for _, tc := range rep.toolCalls {
		var input map[string]any
		_ = json.Unmarshal([]byte(tc.Function.Arguments), &input)
		content = append(content, map[string]any{"type": "tool_use", "id": "toolu_" + tc.ID, "name": tc.Function.Name, "input": input})
		outputTokens += countTokens(tc.Function.Arguments) + 3
		stop = "tool_use"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":            fmt.Sprintf("msg_mock_%d", time.Now().UnixNano()),
		"type":          "message",
		"role":          "assistant",
		"model":         req.Model,
		"content":       content,
		"stop_reason":   stop,
		"stop_sequence": nil,
		"usage":         map[string]int{"input_tokens": inputTokens, "output_tokens": outputTokens},
	})
}
