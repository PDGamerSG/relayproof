// Command mockupstream is a deterministic OpenAI-compatible upstream for the
// shadow-traffic demo. It serves four "models" with different quality, latency
// and price profiles so a real Bifrost gateway can be exercised end to end
// without API keys:
//
//	gpt-4o        premium primary: always correct, verbose, slow
//	gpt-4o-mini   strong cheap candidate: ~4% wrong, concise, fast
//	llama-3.1-8b  weak cheap candidate: ~25% wrong, breaks JSON, ~6% HTTP 503
//	judge-1       pairwise judge: scores answers against the dataset's gold facts
//
// Everything is derived from the shared dataset, so runs are reproducible.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"log"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/maximhq/bifrost/examples/shadow-demo/dataset"
)

var speed = flag.Float64("speed", 1.0, "latency multiplier (0 disables simulated latency)")

type message struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type chatRequest struct {
	Model          string          `json:"model"`
	Messages       []message       `json:"messages"`
	Stream         bool            `json:"stream"`
	Tools          json.RawMessage `json:"tools"`
	ResponseFormat json.RawMessage `json:"response_format"`
}

type toolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type reply struct {
	text      string
	toolCalls []toolCall
	finish    string
	latency   time.Duration
	status    int
}

func main() {
	addr := flag.String("addr", "127.0.0.1:18080", "listen address")
	flag.Parse()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", handleChat)
	mux.HandleFunc("/v1/embeddings", handleEmbeddings)
	mux.HandleFunc("/v1/models", handleModels)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	log.Printf("mock upstream listening on http://%s (speed=%.2f)", *addr, *speed)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func contentText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return ""
}

func lastUser(msgs []message) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return contentText(msgs[i].Content)
		}
	}
	return ""
}

func countTokens(s string) int {
	return int(math.Ceil(float64(len(strings.Fields(s)))*4/3)) + 1
}

func jitter(base time.Duration, key string) time.Duration {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	f := 0.7 + float64(h.Sum32()%60)/100 // 0.7x .. 1.3x
	return time.Duration(float64(base) * f * *speed)
}

func handleModels(w http.ResponseWriter, _ *http.Request) {
	models := []map[string]any{}
	for _, m := range []string{"gpt-4o", "gpt-4o-mini", "llama-3.1-8b", "judge-1", "text-embedding-3-small"} {
		models = append(models, map[string]any{"id": m, "object": "model", "owned_by": "mock"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": models})
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	var rep reply
	if req.Model == "judge-1" {
		rep = judge(req)
	} else {
		rep = answer(req)
	}
	time.Sleep(rep.latency)
	if rep.status != 0 {
		writeError(w, rep.status, "upstream overloaded, retry later")
		return
	}
	promptTokens := 10
	for _, m := range req.Messages {
		promptTokens += countTokens(contentText(m.Content))
	}
	completionTokens := countTokens(rep.text)
	for _, tc := range rep.toolCalls {
		completionTokens += countTokens(tc.Function.Arguments) + 3
	}
	usage := map[string]int{"prompt_tokens": promptTokens, "completion_tokens": completionTokens, "total_tokens": promptTokens + completionTokens}
	id := fmt.Sprintf("chatcmpl-mock-%d", time.Now().UnixNano())
	if req.Stream {
		stream(w, id, req.Model, rep, usage)
		return
	}
	msg := map[string]any{"role": "assistant", "content": rep.text}
	if len(rep.toolCalls) > 0 {
		msg["content"] = nil
		msg["tool_calls"] = rep.toolCalls
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "object": "chat.completion", "created": time.Now().Unix(), "model": req.Model,
		"choices": []map[string]any{{"index": 0, "message": msg, "finish_reason": rep.finish}},
		"usage":   usage,
	})
}

// stream writes the reply as OpenAI-style SSE chunks, splitting text by words
// and tool-call arguments into two fragments.
func stream(w http.ResponseWriter, id, model string, rep reply, usage map[string]int) {
	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	send := func(v any) {
		b, _ := json.Marshal(v)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		if flusher != nil {
			flusher.Flush()
		}
	}
	chunk := func(delta map[string]any, finish any) map[string]any {
		return map[string]any{"id": id, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model,
			"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": finish}}}
	}
	send(chunk(map[string]any{"role": "assistant", "content": ""}, nil))
	words := strings.SplitAfter(rep.text, " ")
	for _, wd := range words {
		if wd != "" {
			send(chunk(map[string]any{"content": wd}, nil))
		}
	}
	for _, tc := range rep.toolCalls {
		args := tc.Function.Arguments
		half := len(args) / 2
		first := tc
		first.Function.Arguments = args[:half]
		send(chunk(map[string]any{"tool_calls": []toolCall{first}}, nil))
		rest := toolCall{Index: tc.Index}
		rest.Function.Arguments = args[half:]
		send(chunk(map[string]any{"tool_calls": []toolCall{rest}}, nil))
	}
	final := chunk(map[string]any{}, rep.finish)
	final["usage"] = usage
	send(final)
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

type profile struct {
	wrongPct, errorPct, brokenJSONPct int
	latency                           time.Duration
	verbose                           bool
}

var profiles = map[string]profile{
	"gpt-4o":       {latency: 900 * time.Millisecond, verbose: true},
	"gpt-4o-mini":  {wrongPct: 2, latency: 350 * time.Millisecond},
	"llama-3.1-8b": {wrongPct: 25, errorPct: 6, brokenJSONPct: 15, latency: 200 * time.Millisecond},
}

func answer(req chatRequest) reply {
	prompt := lastUser(req.Messages)
	prof, ok := profiles[req.Model]
	if !ok {
		prof = profile{latency: 300 * time.Millisecond}
	}
	rep := reply{finish: "stop", latency: jitter(prof.latency, req.Model+prompt)}
	item, known := dataset.Lookup(prompt)
	if !known {
		rep.text = "I can help with that. Could you share a bit more detail about what you need?"
		return rep
	}
	if dataset.Bucket(req.Model+"-err", item.ID) < prof.errorPct {
		rep.status = http.StatusServiceUnavailable
		return rep
	}
	wrong := dataset.Bucket(req.Model, item.ID) < prof.wrongPct
	fact := item.Gold
	if wrong {
		fact = item.Wrong
	}
	switch item.Kind {
	case dataset.KindQA, dataset.KindMath:
		if prof.verbose {
			rep.text = fmt.Sprintf("The answer is %s. Let me know if you would like more context or a source.", fact)
		} else {
			rep.text = fact + "."
		}
	case dataset.KindWrite:
		switch {
		case wrong:
			rep.text = item.Wrong
		case prof.verbose:
			rep.text = item.Reference + " In practice this keeps systems predictable and efficient under real-world load."
		default:
			rep.text = item.Reference
		}
	case dataset.KindJSON:
		if dataset.Bucket(req.Model+"-json", item.ID) < prof.brokenJSONPct {
			rep.text = fmt.Sprintf("Sure! The contact is %s and their email is %s.", item.JSONName, fact)
			return rep
		}
		if prof.verbose {
			rep.text = fmt.Sprintf(`{"name": %q, "email": %q}`, item.JSONName, fact)
		} else {
			rep.text = fmt.Sprintf(`{"email":%q,"name":%q}`, fact, item.JSONName)
		}
	case dataset.KindTool:
		city := item.ToolArg
		if wrong {
			city = item.Wrong
		}
		tc := toolCall{Index: 0, ID: "call_" + item.ID, Type: "function"}
		tc.Function.Name = item.ToolName
		if prof.verbose {
			tc.Function.Arguments = fmt.Sprintf(`{"city": %q, "unit": "celsius"}`, city)
		} else {
			tc.Function.Arguments = fmt.Sprintf(`{"unit":"celsius","city":%q}`, city)
		}
		rep.toolCalls = []toolCall{tc}
		rep.finish = "tool_calls"
	}
	return rep
}

var sectionRe = regexp.MustCompile(`(?s)## Conversation\n(.*?)\n\n## Response A\n(.*?)\n\n## Response B\n(.*)$`)

// judge scores two responses against the dataset's gold fact for the conversation.
func judge(req chatRequest) reply {
	rep := reply{finish: "stop", latency: jitter(500*time.Millisecond, lastUser(req.Messages))}
	m := sectionRe.FindStringSubmatch(lastUser(req.Messages))
	if m == nil {
		rep.text = `{"score_a": 5, "score_b": 5, "winner": "tie", "reason": "could not parse the comparison"}`
		return rep
	}
	item, ok := dataset.FindInText(m[1])
	if !ok {
		rep.text = `{"score_a": 7, "score_b": 7, "winner": "tie", "reason": "no reference answer; both plausible"}`
		return rep
	}
	a, b := score(item, m[2]), score(item, m[3])
	winner := "tie"
	if a > b {
		winner = "A"
	} else if b > a {
		winner = "B"
	}
	reason := "both answers are correct"
	switch {
	case a > b:
		reason = "response B is incorrect or malformed"
	case b > a:
		reason = "response A is incorrect or malformed"
	case a < 5:
		reason = "both answers are incorrect"
	}
	out, _ := json.Marshal(map[string]any{"score_a": a, "score_b": b, "winner": winner, "reason": reason})
	rep.text = string(out)
	return rep
}

func score(item dataset.Item, response string) int {
	lower := strings.ToLower(response)
	correct := strings.Contains(lower, strings.ToLower(item.Gold))
	if item.Kind == dataset.KindJSON {
		var v map[string]any
		if json.Unmarshal([]byte(strings.TrimSpace(response)), &v) != nil {
			return 4 // right facts, wrong format
		}
	}
	if item.Kind == dataset.KindTool && !strings.Contains(response, "[tool call] "+item.ToolName) {
		return 2
	}
	if correct {
		return 9
	}
	return 2
}

func handleEmbeddings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string          `json:"model"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	var inputs []string
	var single string
	if json.Unmarshal(req.Input, &single) == nil {
		inputs = []string{single}
	} else {
		_ = json.Unmarshal(req.Input, &inputs)
	}
	data := []map[string]any{}
	tokens := 0
	for i, in := range inputs {
		data = append(data, map[string]any{"object": "embedding", "index": i, "embedding": embed(in)})
		tokens += countTokens(in)
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "model": req.Model, "data": data,
		"usage": map[string]int{"prompt_tokens": tokens, "total_tokens": tokens}})
}

// embed is a hashed bag-of-words vector: deterministic and good enough for demos.
func embed(s string) []float64 {
	const dim = 64
	v := make([]float64, dim)
	for _, tok := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	}) {
		h := fnv.New32a()
		_, _ = h.Write([]byte(tok))
		v[h.Sum32()%dim]++
	}
	var n float64
	for _, x := range v {
		n += x * x
	}
	if n > 0 {
		n = math.Sqrt(n)
		for i := range v {
			v[i] /= n
		}
	}
	return v
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": msg, "type": "server_error"}})
}
