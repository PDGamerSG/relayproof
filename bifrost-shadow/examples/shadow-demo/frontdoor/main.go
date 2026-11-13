// Command frontdoor is the public entry point of the hosted demo. It is the
// only listener exposed to the internet:
//
//   - It forwards an allowlist of /api/shadow/* routes to the gateway and
//     attaches the setup token itself, so the token never leaves the host.
//     Inference, configuration and the dashboard stay unreachable from outside.
//
//   - It keeps a slow stream of live traffic going through the gateway, so
//     counters, scorecards and canary health keep moving.
//
//   - It serves a few demo controls under /api/demo/*: simulate a provider
//     incident on a candidate (cleared automatically), send a burst of traffic,
//     and report the demo's state.
//
//   - A janitor rolls back canaries that have been live longer than a TTL, so
//     a shared public demo returns to its starting point on its own.
//
//     frontdoor -addr :10000 -gateway http://127.0.0.1:8080 -mock http://127.0.0.1:18080
//
// The setup token comes from BIFROST_SETUP_TOKEN.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/maximhq/bifrost/examples/shadow-demo/dataset"
)

type options struct {
	addr         string
	gateway      string
	mock         string
	setupToken   string
	model        string
	trafficEvery time.Duration
	incidentTTL  time.Duration
	canaryTTL    time.Duration
	burstMax     int
	postsPerMin  int
}

func main() {
	var o options
	port := os.Getenv("PORT")
	if port == "" {
		port = "10000"
	}
	flag.StringVar(&o.addr, "addr", ":"+port, "public listen address")
	flag.StringVar(&o.gateway, "gateway", "http://127.0.0.1:8080", "gateway base URL (private)")
	flag.StringVar(&o.mock, "mock", "http://127.0.0.1:18080", "mock upstream base URL (private)")
	flag.StringVar(&o.setupToken, "setup-token", os.Getenv("BIFROST_SETUP_TOKEN"), "X-Bifrost-Setup-Token attached to forwarded /api/shadow calls")
	flag.StringVar(&o.model, "model", "openai/gpt-4o", "model the live traffic asks for")
	flag.DurationVar(&o.trafficEvery, "traffic-every", envDuration("TRAFFIC_EVERY", time.Second), "pause between live requests (0 turns live traffic off)")
	flag.DurationVar(&o.incidentTTL, "incident-ttl", envDuration("INCIDENT_TTL", 3*time.Minute), "a simulated incident clears itself after this long")
	flag.DurationVar(&o.canaryTTL, "canary-ttl", envDuration("CANARY_TTL", 30*time.Minute), "canaries live longer than this are rolled back (0 keeps them)")
	flag.IntVar(&o.burstMax, "burst-max", 60, "largest traffic burst one call may ask for")
	flag.IntVar(&o.postsPerMin, "posts-per-minute", 30, "POST calls allowed per client address per minute")
	flag.Parse()
	if o.setupToken == "" {
		log.Fatal("frontdoor: BIFROST_SETUP_TOKEN (or -setup-token) is required")
	}

	d, err := newDoor(o)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go d.liveTraffic(ctx)
	go d.janitor(ctx)

	srv := &http.Server{
		Addr:              o.addr,
		Handler:           d.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("frontdoor: listening on %s, gateway %s, live traffic every %v", o.addr, o.gateway, o.trafficEvery)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func envDuration(name string, def time.Duration) time.Duration {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d
	}
	if s, err := strconv.ParseFloat(v, 64); err == nil {
		return time.Duration(s * float64(time.Second))
	}
	log.Printf("frontdoor: ignoring %s=%q, not a duration", name, v)
	return def
}

// door holds the demo's shared state.
type door struct {
	o       options
	gateway *url.URL
	proxy   *httputil.ReverseProxy
	client  *http.Client
	started time.Time
	limiter *limiter

	liveSent   atomic.Int64
	liveFailed atomic.Int64
	burstBusy  atomic.Bool
	burstSent  atomic.Int64

	mu        sync.Mutex
	incidents map[string]incident
}

type incident struct {
	Model    string    `json:"model"`
	ErrorPct int       `json:"error_pct"`
	Since    time.Time `json:"since"`
	Until    time.Time `json:"until"`
	timer    *time.Timer
}

// incidentModels are the models a visitor may break: the two candidates.
// The primary stays healthy so callers keep getting answers.
var incidentModels = map[string]bool{"gpt-4o-mini": true, "llama-3.1-8b": true}

func newDoor(o options) (*door, error) {
	gw, err := url.Parse(o.gateway)
	if err != nil || gw.Scheme == "" || gw.Host == "" {
		return nil, fmt.Errorf("frontdoor: bad -gateway %q", o.gateway)
	}
	d := &door{
		o:         o,
		gateway:   gw,
		client:    &http.Client{Timeout: 60 * time.Second},
		started:   time.Now(),
		limiter:   newLimiter(o.postsPerMin, time.Minute),
		incidents: map[string]incident{},
	}
	d.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(gw)
			r.Out.Host = gw.Host
			// Callers cannot bring their own credentials; the door's token is the only one.
			r.Out.Header.Del("Authorization")
			r.Out.Header.Del("Cookie")
			r.Out.Header.Set("X-Bifrost-Setup-Token", o.setupToken)
		},
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Del("Set-Cookie")
			resp.Header.Set("Cache-Control", "no-store")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("frontdoor: gateway: %v", err)
			writeError(w, http.StatusBadGateway, "the gateway is not reachable yet; it may still be starting")
		},
	}
	return d, nil
}

// shadowRoutes is the allowlist of gateway routes reachable from outside.
// DELETE /api/shadow/records (reset) is deliberately absent.
func shadowRouteAllowed(method, path string) bool {
	switch method {
	case http.MethodGet, http.MethodHead:
		switch path {
		case "/api/shadow/summary", "/api/shadow/records", "/api/shadow/rollouts",
			"/api/shadow/export", "/api/shadow/canary-rule":
			return true
		}
		if id, ok := strings.CutPrefix(path, "/api/shadow/records/"); ok {
			return id != "" && !strings.Contains(id, "/")
		}
	case http.MethodPost:
		return path == "/api/shadow/promote" || path == "/api/shadow/rollback"
	}
	return false
}

func (d *door) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", d.health)
	mux.HandleFunc("/api/shadow/", d.shadow)
	mux.HandleFunc("GET /api/demo/status", d.status)
	mux.HandleFunc("POST /api/demo/incident", d.setIncident)
	mux.HandleFunc("POST /api/demo/traffic", d.burst)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = io.WriteString(w, "RelayProof demo backend. Shadow API under /api/shadow/, demo controls under /api/demo/.\n")
			return
		}
		writeError(w, http.StatusNotFound, "not found")
	})
	return d.limitPosts(mux)
}

func (d *door) health(w http.ResponseWriter, r *http.Request) {
	if !d.gatewayHealthy(r.Context()) {
		writeError(w, http.StatusServiceUnavailable, "gateway starting")
		return
	}
	_, _ = io.WriteString(w, "ok")
}

func (d *door) gatewayHealthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.o.gateway+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (d *door) shadow(w http.ResponseWriter, r *http.Request) {
	if !shadowRouteAllowed(r.Method, r.URL.Path) {
		writeError(w, http.StatusForbidden, "this route is not exposed by the public demo")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d.proxy.ServeHTTP(w, r)
}

// demoStatus is the payload of GET /api/demo/status.
type demoStatus struct {
	StartedAt          time.Time  `json:"started_at"`
	UptimeSeconds      int64      `json:"uptime_seconds"`
	LiveTrafficEveryMS int64      `json:"live_traffic_every_ms"`
	LiveSent           int64      `json:"live_sent"`
	LiveFailed         int64      `json:"live_failed"`
	BurstRunning       bool       `json:"burst_running"`
	BurstSent          int64      `json:"burst_sent"`
	BurstMax           int        `json:"burst_max"`
	Incidents          []incident `json:"incidents"`
	IncidentModels     []string   `json:"incident_models"`
	IncidentTTLSeconds int64      `json:"incident_ttl_seconds"`
	CanaryTTLSeconds   int64      `json:"canary_ttl_seconds"`
}

func (d *door) status(w http.ResponseWriter, _ *http.Request) {
	d.mu.Lock()
	incs := make([]incident, 0, len(d.incidents))
	for _, inc := range d.incidents {
		incs = append(incs, inc)
	}
	d.mu.Unlock()
	writeJSON(w, http.StatusOK, demoStatus{
		StartedAt:          d.started.UTC(),
		UptimeSeconds:      int64(time.Since(d.started).Seconds()),
		LiveTrafficEveryMS: d.o.trafficEvery.Milliseconds(),
		LiveSent:           d.liveSent.Load(),
		LiveFailed:         d.liveFailed.Load(),
		BurstRunning:       d.burstBusy.Load(),
		BurstSent:          d.burstSent.Load(),
		BurstMax:           d.o.burstMax,
		Incidents:          incs,
		IncidentModels:     []string{"gpt-4o-mini", "llama-3.1-8b"},
		IncidentTTLSeconds: int64(d.o.incidentTTL.Seconds()),
		CanaryTTLSeconds:   int64(d.o.canaryTTL.Seconds()),
	})
}

type incidentRequest struct {
	Model    string `json:"model"`
	ErrorPct int    `json:"error_pct"`
}

// setIncident serves POST /api/demo/incident {"model","error_pct"}: that share
// of the model's upstream calls fails with HTTP 503 until error_pct is set back
// to 0 or the incident TTL passes.
func (d *door) setIncident(w http.ResponseWriter, r *http.Request) {
	var req incidentRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "body must be JSON: {\"model\": \"gpt-4o-mini\", \"error_pct\": 60}")
		return
	}
	req.Model = strings.TrimPrefix(req.Model, "openai/")
	if !incidentModels[req.Model] {
		writeError(w, http.StatusBadRequest, "model must be gpt-4o-mini or llama-3.1-8b")
		return
	}
	if req.ErrorPct < 0 || req.ErrorPct > 100 {
		writeError(w, http.StatusBadRequest, "error_pct must be between 0 and 100")
		return
	}
	if err := d.applyIncident(r.Context(), req.Model, req.ErrorPct); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	d.status(w, r)
}

func (d *door) applyIncident(ctx context.Context, model string, pct int) error {
	if err := d.mockIncident(ctx, model, pct); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if old, ok := d.incidents[model]; ok && old.timer != nil {
		old.timer.Stop()
	}
	if pct == 0 {
		delete(d.incidents, model)
		log.Printf("frontdoor: incident on %s cleared", model)
		return nil
	}
	now := time.Now()
	inc := incident{Model: model, ErrorPct: pct, Since: now.UTC(), Until: now.Add(d.o.incidentTTL).UTC()}
	inc.timer = time.AfterFunc(d.o.incidentTTL, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		d.mu.Lock()
		cur, ok := d.incidents[model]
		d.mu.Unlock()
		if ok && cur.Since.Equal(inc.Since) {
			if err := d.applyIncident(ctx, model, 0); err != nil {
				log.Printf("frontdoor: clearing incident on %s: %v", model, err)
			}
		}
	})
	d.incidents[model] = inc
	log.Printf("frontdoor: incident on %s, %d%% of calls fail for %v", model, pct, d.o.incidentTTL)
	return nil
}

func (d *door) mockIncident(ctx context.Context, model string, pct int) error {
	u := fmt.Sprintf("%s/admin/incident?model=%s&error_pct=%d", d.o.mock, url.QueryEscape(model), pct)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return fmt.Errorf("mock upstream not reachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("mock upstream answered %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

type burstRequest struct {
	N int `json:"n"`
}

// burst serves POST /api/demo/traffic {"n": 40}: n requests through the
// gateway, four at a time, in the background. One burst runs at a time.
func (d *door) burst(w http.ResponseWriter, r *http.Request) {
	req := burstRequest{N: 30}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "body must be JSON: {\"n\": 30}")
			return
		}
	}
	if req.N < 1 || req.N > d.o.burstMax {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("n must be between 1 and %d", d.o.burstMax))
		return
	}
	if !d.burstBusy.CompareAndSwap(false, true) {
		writeError(w, http.StatusTooManyRequests, "a burst is already running; try again when it finishes")
		return
	}
	go func(n int) {
		defer d.burstBusy.Store(false)
		jobs := make(chan dataset.Item)
		var wg sync.WaitGroup
		for range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for item := range jobs {
					_ = d.send(context.Background(), item, rand.IntN(4) == 0)
					d.burstSent.Add(1)
				}
			}()
		}
		items := dataset.Items()
		for range n {
			jobs <- items[rand.IntN(len(items))]
		}
		close(jobs)
		wg.Wait()
	}(req.N)
	writeJSON(w, http.StatusAccepted, map[string]any{"queued": req.N})
}

// liveTraffic sends one dataset request every trafficEvery, a quarter of them
// streamed, so the demo never goes quiet. It starts once the gateway is up.
func (d *door) liveTraffic(ctx context.Context) {
	if d.o.trafficEvery <= 0 {
		return
	}
	for !d.gatewayHealthy(ctx) {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
	items := dataset.Items()
	t := time.NewTicker(d.o.trafficEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := d.send(ctx, items[rand.IntN(len(items))], rand.IntN(4) == 0); err != nil {
			d.liveFailed.Add(1)
		}
		d.liveSent.Add(1)
	}
}

var weatherTool = json.RawMessage(`[{"type":"function","function":{"name":"get_weather","description":"Current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"},"unit":{"type":"string","enum":["celsius","fahrenheit"]}},"required":["city"]}}}]`)

// send makes one chat completion through the gateway, shaped like the demo's
// load generator: JSON mode and tool items carry their request options.
func (d *door) send(ctx context.Context, item dataset.Item, stream bool) error {
	body := map[string]any{
		"model": d.o.model,
		"messages": []map[string]string{
			{"role": "system", "content": "You are a concise, accurate assistant."},
			{"role": "user", "content": item.Prompt},
		},
	}
	switch item.Kind {
	case dataset.KindJSON:
		body["response_format"] = map[string]string{"type": "json_object"}
	case dataset.KindTool:
		body["tools"] = weatherTool
	}
	if stream {
		body["stream"] = true
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.o.gateway+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway answered %d", resp.StatusCode)
	}
	return nil
}

// janitor rolls back canaries that have been live longer than canaryTTL.
func (d *door) janitor(ctx context.Context) {
	if d.o.canaryTTL <= 0 {
		return
	}
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := d.expireCanaries(ctx); err != nil {
			log.Printf("frontdoor: janitor: %v", err)
		}
	}
}

type rolloutsView struct {
	Canaries []struct {
		Experiment string `json:"experiment"`
		Candidate  struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
		} `json:"candidate"`
		Since time.Time `json:"since"`
	} `json:"canaries"`
}

func (d *door) expireCanaries(ctx context.Context) error {
	var view rolloutsView
	if err := d.gatewayJSON(ctx, http.MethodGet, "/api/shadow/rollouts", nil, &view); err != nil {
		return err
	}
	for _, c := range view.Canaries {
		if c.Since.IsZero() || time.Since(c.Since) < d.o.canaryTTL {
			continue
		}
		body := map[string]string{
			"experiment": c.Experiment,
			"candidate":  c.Candidate.Provider + "/" + c.Candidate.Model,
			"reason":     fmt.Sprintf("public demo reset: canary live for more than %v", d.o.canaryTTL),
		}
		if err := d.gatewayJSON(ctx, http.MethodPost, "/api/shadow/rollback", body, nil); err != nil {
			return fmt.Errorf("rolling back %s: %w", body["candidate"], err)
		}
		log.Printf("frontdoor: rolled back %s after %v", body["candidate"], d.o.canaryTTL)
	}
	return nil
}

func (d *door) gatewayJSON(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.o.gateway+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Bifrost-Setup-Token", d.o.setupToken)
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("%s %s: HTTP %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

// limitPosts caps POST calls per client address. Behind a proxy the first
// X-Forwarded-For entry is the client; it can be forged, which only lets a
// caller spend someone else's allowance on a demo.
func (d *door) limitPosts(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && !d.limiter.allow(clientAddr(r), time.Now()) {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "too many changes from this address; wait a minute")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func clientAddr(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if ip := strings.TrimSpace(first); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// limiter is a fixed-window counter per key.
type limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	start  time.Time
	counts map[string]int
}

func newLimiter(limit int, window time.Duration) *limiter {
	return &limiter{limit: limit, window: window, counts: map[string]int{}}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.start) >= l.window {
		l.start = now
		clear(l.counts)
	}
	if l.counts[key] >= l.limit {
		return false
	}
	l.counts[key]++
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError uses the gateway's error body, so a client handles both alike.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{
		"is_bifrost_error": false,
		"status_code":      status,
		"error":            map[string]string{"message": msg},
	})
}
