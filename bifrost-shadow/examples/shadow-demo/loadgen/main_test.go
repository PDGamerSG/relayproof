package main

import (
	"strings"
	"testing"
)

func testPair(provider, model, verdict, reason string) pair {
	var p pair
	p.Candidate.Provider = provider
	p.Candidate.Model = model
	p.Verdict = verdict
	p.VerdictReason = reason
	return p
}

func TestCheckReady(t *testing.T) {
	pairs := []pair{
		testPair("openai", "gpt-4o-mini", "ready", "agreement 96.1% (95% lower bound 91.8%) clears 90%"),
		testPair("openai", "llama-3.1-8b", "not_ready", "agreement 69.0% is below 90%"),
	}
	cases := []struct {
		candidate string
		wantErr   string
	}{
		{"openai/gpt-4o-mini", ""},
		{"openai/llama-3.1-8b", `openai/llama-3.1-8b has verdict "not ready": agreement 69.0% is below 90%`},
		{"openai/gpt-4.1", "no shadow results for openai/gpt-4.1 yet"},
	}
	for _, c := range cases {
		err := checkReady(pairs, c.candidate)
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%s: unexpected error %v", c.candidate, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%s: got %v, want %q", c.candidate, err, c.wantErr)
		}
	}
}
