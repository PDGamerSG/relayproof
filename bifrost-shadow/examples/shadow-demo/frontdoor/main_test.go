package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestShadowRouteAllowlist(t *testing.T) {
	cases := []struct {
		method, path string
		want         bool
	}{
		{"GET", "/api/shadow/summary", true},
		{"GET", "/api/shadow/records", true},
		{"GET", "/api/shadow/records/abc-123", true},
		{"GET", "/api/shadow/records/abc/def", false},
		{"GET", "/api/shadow/records/", false},
		{"GET", "/api/shadow/rollouts", true},
		{"GET", "/api/shadow/export", true},
		{"GET", "/api/shadow/canary-rule", true},
		{"POST", "/api/shadow/promote", true},
		{"POST", "/api/shadow/rollback", true},
		{"DELETE", "/api/shadow/records", false},
		{"POST", "/api/shadow/summary", false},
		{"GET", "/api/shadow/../config", false},
		{"PUT", "/api/shadow/promote", false},
	}
	for _, c := range cases {
		if got := shadowRouteAllowed(c.method, c.path); got != c.want {
			t.Errorf("%s %s: allowed=%v, want %v", c.method, c.path, got, c.want)
		}
	}
}

// fakeBackend plays both the gateway and the mock upstream.
type fakeBackend struct {
	mu        sync.Mutex
	tokens    []string
	auth      []string
	origins   []string
	incidents []string
	chats     int
	rollbacks []map[string]string
	since     time.Time
	resets    int

	lastBody         map[string]any
	lastShadowHeader string
}

func (f *fakeBackend) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	mux.HandleFunc("/api/shadow/summary", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.tokens = append(f.tokens, r.Header.Get("X-Bifrost-Setup-Token"))
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.origins = append(f.origins, r.Header.Get("Origin")+r.Header.Get("Referer"))
		f.mu.Unlock()
		w.Header().Set("Set-Cookie", "token=leak")
		_, _ = io.WriteString(w, `{"enabled":true}`)
	})
	mux.HandleFunc("/api/shadow/rollouts", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		since := f.since
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"canaries": []map[string]any{{
			"experiment": "gpt-4o cost-down",
			"candidate":  map[string]string{"provider": "openai", "model": "gpt-4o-mini"},
			"since":      since,
		}}})
	})
	mux.HandleFunc("/api/shadow/rollback", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.rollbacks = append(f.rollbacks, body)
		f.mu.Unlock()
		_, _ = io.WriteString(w, `{"action":"delete"}`)
	})
	mux.HandleFunc("DELETE /api/shadow/records", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		if r.Header.Get("X-Bifrost-Setup-Token") == "secret-token" {
			f.resets++
		}
		f.mu.Unlock()
		_, _ = io.WriteString(w, `{"message":"cleared"}`)
	})
	mux.HandleFunc("/admin/incident", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.incidents = append(f.incidents, r.URL.RawQuery)
		f.mu.Unlock()
		_, _ = io.WriteString(w, `{}`)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.chats++
		f.lastBody = body
		f.lastShadowHeader = r.Header.Get("x-bf-shadow")
		f.mu.Unlock()
		w.Header().Set("X-Bifrost-Request-Id", "req-42")
		w.Header().Set("x-bf-shadow", "sampled")
		_, _ = io.WriteString(w, `{"model":"claude-opus-5-5","choices":[{"message":{"role":"assistant","content":"Paris."},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}`)
	})
	return mux
}

func newTestDoor(t *testing.T, f *fakeBackend, o options) (*door, *httptest.Server) {
	t.Helper()
	backend := httptest.NewServer(f.handler())
	t.Cleanup(backend.Close)
	o.gateway, o.mock, o.setupToken = backend.URL, backend.URL, "secret-token"
	if o.incidentTTL == 0 {
		o.incidentTTL = time.Minute
	}
	if o.burstMax == 0 {
		o.burstMax = 10
	}
	if o.postsPerMin == 0 {
		o.postsPerMin = 100
	}
	if o.incidentList == "" {
		o.incidentList = "gpt-4o-mini,llama-3.1-8b"
	}
	if o.askPerHour == 0 {
		o.askPerHour = 5
	}
	if o.askMaxChars == 0 {
		o.askMaxChars = 100
	}
	o.model = "openai/gpt-4o"
	d, err := newDoor(o)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(d.routes())
	t.Cleanup(srv.Close)
	return d, srv
}

func TestProxyAttachesTokenAndDropsCallerCredentials(t *testing.T) {
	f := &fakeBackend{}
	_, srv := newTestDoor(t, f, options{})

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/shadow/summary", nil)
	req.Header.Set("X-Bifrost-Setup-Token", "caller-guess")
	req.Header.Set("Authorization", "Basic Zm9vOmJhcg==")
	req.Header.Set("Origin", "https://relayproof.pallabdas.me")
	req.Header.Set("Referer", "https://relayproof.pallabdas.me/live")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if resp.Header.Get("Set-Cookie") != "" {
		t.Error("gateway cookie leaked to the caller")
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("want Cache-Control: no-store")
	}
	if f.tokens[0] != "secret-token" || f.auth[0] != "" {
		t.Errorf("gateway saw token %q auth %q", f.tokens[0], f.auth[0])
	}
	if f.origins[0] != "" {
		t.Errorf("gateway saw the caller's Origin/Referer %q; it refuses unlisted origins", f.origins[0])
	}

	for _, c := range []struct{ method, path string }{
		{http.MethodDelete, "/api/shadow/records"},
		{http.MethodGet, "/api/shadow/../../api/config"},
	} {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Errorf("%s %s reached the gateway", c.method, c.path)
		}
	}
}

func TestIncidentValidatesAndClearsItself(t *testing.T) {
	f := &fakeBackend{}
	_, srv := newTestDoor(t, f, options{incidentTTL: 50 * time.Millisecond})

	post := func(body string) int {
		resp, err := http.Post(srv.URL+"/api/demo/incident", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := post(`{"model":"gpt-4o","error_pct":50}`); got != http.StatusBadRequest {
		t.Errorf("breaking the primary: status %d, want 400", got)
	}
	if got := post(`{"model":"gpt-4o-mini","error_pct":101}`); got != http.StatusBadRequest {
		t.Errorf("error_pct 101: status %d, want 400", got)
	}
	if got := post(`{"model":"openai/gpt-4o-mini","error_pct":60}`); got != http.StatusOK {
		t.Fatalf("valid incident: status %d", got)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		n := len(f.incidents)
		f.mu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	want := []string{"model=gpt-4o-mini&error_pct=60", "model=gpt-4o-mini&error_pct=0"}
	if len(f.incidents) != 2 || f.incidents[0] != want[0] || f.incidents[1] != want[1] {
		t.Errorf("mock saw %v, want %v", f.incidents, want)
	}
}

func TestBurstSendsTrafficOneAtATime(t *testing.T) {
	f := &fakeBackend{}
	d, srv := newTestDoor(t, f, options{})

	resp, err := http.Post(srv.URL+"/api/demo/traffic", "application/json", strings.NewReader(`{"n":11}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("n above burst-max: status %d, want 400", resp.StatusCode)
	}
	resp, err = http.Post(srv.URL+"/api/demo/traffic", "application/json", strings.NewReader(`{"n":8}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("burst: status %d", resp.StatusCode)
	}
	deadline := time.Now().Add(3 * time.Second)
	for d.burstBusy.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.chats != 8 || d.burstSent.Load() != 8 {
		t.Errorf("gateway saw %d chats, door counted %d, want 8", f.chats, d.burstSent.Load())
	}
}

func TestJanitorRollsBackOldCanariesOnly(t *testing.T) {
	f := &fakeBackend{since: time.Now().Add(-time.Minute)}
	d, _ := newTestDoor(t, f, options{canaryTTL: time.Hour})
	if err := d.expireCanaries(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.rollbacks) != 0 {
		t.Fatalf("young canary rolled back: %v", f.rollbacks)
	}
	f.mu.Lock()
	f.since = time.Now().Add(-2 * time.Hour)
	f.mu.Unlock()
	if err := d.expireCanaries(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.rollbacks) != 1 || f.rollbacks[0]["candidate"] != "openai/gpt-4o-mini" {
		t.Fatalf("rollbacks %v", f.rollbacks)
	}
}

func TestPostLimitPerAddress(t *testing.T) {
	l := newLimiter(2, time.Minute)
	now := time.Now()
	if !l.allow("a", now) || !l.allow("a", now) {
		t.Fatal("first two calls refused")
	}
	if l.allow("a", now) {
		t.Error("third call in the window allowed")
	}
	if !l.allow("b", now) {
		t.Error("another address refused")
	}
	if !l.allow("a", now.Add(time.Minute)) {
		t.Error("call in a new window refused")
	}
}

func TestScoresResetAfterTheLastIncidentEnds(t *testing.T) {
	f := &fakeBackend{}
	d, srv := newTestDoor(t, f, options{resetAfter: 20 * time.Millisecond, reseed: 6})

	post := func(body string) {
		resp, err := http.Post(srv.URL+"/api/demo/incident", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d", body, resp.StatusCode)
		}
	}
	post(`{"model":"gpt-4o-mini","error_pct":60}`)
	post(`{"model":"llama-3.1-8b","error_pct":60}`)
	post(`{"model":"gpt-4o-mini","error_pct":0}`)
	time.Sleep(80 * time.Millisecond)
	f.mu.Lock()
	early := f.resets
	f.mu.Unlock()
	if early != 0 {
		t.Fatal("scores reset while another incident was still running")
	}
	post(`{"model":"llama-3.1-8b","error_pct":0}`)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		done := f.resets == 1 && f.chats == 6
		f.mu.Unlock()
		if done && !d.reseeding.Load() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resets != 1 || f.chats != 6 {
		t.Fatalf("resets %d, replayed chats %d; want 1 and 6", f.resets, f.chats)
	}
}

func TestDailyCapLimitsEveryKindOfRequest(t *testing.T) {
	f := &fakeBackend{}
	d, srv := newTestDoor(t, f, options{dailyRequests: 5, burstMax: 10})
	resp, err := http.Post(srv.URL+"/api/demo/traffic", "application/json", strings.NewReader(`{"n":8}`))
	if err != nil {
		t.Fatal(err)
	}
	var queued struct {
		Queued int `json:"queued"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&queued)
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted || queued.Queued != 5 {
		t.Fatalf("burst of 8 under a cap of 5: status %d queued %d, want 202 and 5", resp.StatusCode, queued.Queued)
	}
	deadline := time.Now().Add(3 * time.Second)
	for d.burstBusy.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	resp, err = http.Post(srv.URL+"/api/demo/traffic", "application/json", strings.NewReader(`{"n":1}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Errorf("burst after the cap: status %d, want 429", resp.StatusCode)
	}
	resp, err = http.Post(srv.URL+"/api/demo/ask", "application/json", strings.NewReader(`{"prompt":"Capital of France?"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Errorf("ask after the cap: status %d, want 429", resp.StatusCode)
	}
	if got := d.take(1); got != 0 {
		t.Errorf("take after the cap returned %d", got)
	}
}

func TestAskForcesShadowingAndReturnsTheRequestID(t *testing.T) {
	f := &fakeBackend{}
	_, srv := newTestDoor(t, f, options{maxTokens: 512, effort: "low"})

	post := func(body string) (*http.Response, askResponse) {
		resp, err := http.Post(srv.URL+"/api/demo/ask", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out askResponse
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp, out
	}
	if resp, _ := post(`{"prompt":"   "}`); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("empty prompt: status %d", resp.StatusCode)
	}
	if resp, _ := post(`{"prompt":"` + strings.Repeat("x", 101) + `"}`); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("long prompt: status %d", resp.StatusCode)
	}
	resp, out := post(`{"prompt":"What is the capital of France?"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ask: status %d", resp.StatusCode)
	}
	if out.RequestID != "req-42" || out.Answer != "Paris." || !out.Shadowed || out.Model != "gpt-4o" {
		t.Errorf("ask response %+v", out)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lastShadowHeader != "force" {
		t.Errorf("gateway saw x-bf-shadow %q, want force", f.lastShadowHeader)
	}
	if f.lastBody["max_tokens"] != float64(512) || f.lastBody["reasoning_effort"] != "low" {
		t.Errorf("request body %v lacks max_tokens 512 and reasoning_effort low", f.lastBody)
	}
}

func TestAskIsLimitedPerAddress(t *testing.T) {
	f := &fakeBackend{}
	_, srv := newTestDoor(t, f, options{askPerHour: 2})
	codes := []int{}
	for range 3 {
		resp, err := http.Post(srv.URL+"/api/demo/ask", "application/json", strings.NewReader(`{"prompt":"hi"}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		codes = append(codes, resp.StatusCode)
	}
	if codes[0] != 200 || codes[1] != 200 || codes[2] != http.StatusTooManyRequests {
		t.Errorf("statuses %v, want 200 200 429", codes)
	}
}

func TestIncidentModelsAreConfigurable(t *testing.T) {
	f := &fakeBackend{}
	_, srv := newTestDoor(t, f, options{incidentList: "anthropic/claude-sonnet-5-5, claude-haiku-5-5"})
	post := func(model string) int {
		resp, err := http.Post(srv.URL+"/api/demo/incident", "application/json", strings.NewReader(`{"model":"`+model+`","error_pct":50}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := post("gpt-4o-mini"); got != http.StatusBadRequest {
		t.Errorf("model outside the list: status %d", got)
	}
	if got := post("anthropic/claude-sonnet-5-5"); got != http.StatusOK {
		t.Errorf("listed model: status %d", got)
	}
}
