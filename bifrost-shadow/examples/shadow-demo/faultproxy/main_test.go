package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestForwardsUnchangedAndInjectsIncidents(t *testing.T) {
	var gotKey, gotBody string
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		gotKey = r.Header.Get("X-Api-Key")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_, _ = io.WriteString(w, `{"type":"message"}`)
	}))
	defer upstream.Close()
	p, err := newProxy(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(p)
	defer srv.Close()

	send := func(model string) int {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/messages", strings.NewReader(`{"model":"`+model+`","max_tokens":10}`))
		req.Header.Set("X-Api-Key", "secret")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	admin := func(q string) int {
		resp, err := http.Post(srv.URL+"/admin/incident?"+q, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if got := send("claude-sonnet-5-5"); got != http.StatusOK {
		t.Fatalf("healthy model: status %d", got)
	}
	if gotKey != "secret" || !strings.Contains(gotBody, `"max_tokens":10`) {
		t.Errorf("upstream saw key %q body %q; want both forwarded unchanged", gotKey, gotBody)
	}

	if got := admin("model=claude-sonnet-5-5&error_pct=101"); got != http.StatusBadRequest {
		t.Errorf("error_pct 101: status %d", got)
	}
	if got := admin("model=claude-sonnet-5-5&error_pct=100"); got != http.StatusOK {
		t.Fatalf("set incident: status %d", got)
	}
	before := calls
	if got := send("claude-sonnet-5-5"); got != 529 {
		t.Errorf("model in incident: status %d, want 529", got)
	}
	if got := send("claude-opus-5-5"); got != http.StatusOK {
		t.Errorf("other model during incident: status %d", got)
	}
	if calls != before+1 {
		t.Errorf("upstream calls %d, want only the healthy model's request to reach it", calls-before)
	}

	if got := admin("model=claude-sonnet-5-5&error_pct=0"); got != http.StatusOK {
		t.Fatalf("clear incident: status %d", got)
	}
	if got := send("claude-sonnet-5-5"); got != http.StatusOK {
		t.Errorf("after clearing: status %d", got)
	}
}
