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
//   - POST /api/demo/ask sends a visitor's own question through the gateway,
//     always shadowed, and returns the primary's answer and request ID; the
//     candidates' answers and the judge's verdict then appear in the records.
//
//   - Against a paid provider, -daily-requests caps every request the door
//     makes in a UTC day, and -watched-for keeps live traffic off while nobody
//     has the console open.
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
	resetAfter   time.Duration
	reseed       int

	upstream      string        // what the gateway calls: "mock" or a provider name, shown to visitors
	incidentList  string        // comma-separated models a visitor may break
	maxTokens     int           // max_tokens on the door's requests (0 leaves it out)
	effort        string        // reasoning_effort on the door's requests ("" leaves it out)
	streamPct     int           // share of live and burst requests sent streamed
	dailyRequests int           // requests the door may send per UTC day (0: no cap)
	watchedFor    time.Duration // live traffic runs only this long after the last console call (0: always)
	seed          int           // requests sent at start when the gateway has no comparisons yet
	askPerHour    int           // visitor questions per client address per hour
	askMaxChars   int           // longest visitor question
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
	flag.DurationVar(&o.resetAfter, "reset-after-incident", envDuration("RESET_AFTER_INCIDENT", 20*time.Second), "after the last incident ends, wait this long, clear the scorecards and replay traffic (0 keeps them)")
	flag.IntVar(&o.reseed, "reseed", envInt("SEED", 300), "requests replayed after a reset")
	flag.StringVar(&o.upstream, "upstream", envString("UPSTREAM", "mock"), "what the gateway calls, shown to visitors (mock, anthropic, ...)")
	flag.StringVar(&o.incidentList, "incident-models", envString("INCIDENT_MODELS", "gpt-4o-mini,llama-3.1-8b"), "comma-separated models a visitor may break (the candidates)")
	flag.IntVar(&o.maxTokens, "max-tokens", envInt("MAX_TOKENS", 0), "max_tokens on the door's requests (0 leaves it out)")
	flag.StringVar(&o.effort, "reasoning-effort", envString("REASONING_EFFORT", ""), "reasoning_effort on the door's requests (empty leaves it out)")
	flag.IntVar(&o.streamPct, "stream-pct", envInt("STREAM_PCT", 25), "share of live and burst requests sent streamed (0-100)")
	flag.IntVar(&o.dailyRequests, "daily-requests", envInt("DAILY_REQUESTS", 0), "requests the door may send per UTC day, all kinds together (0: no cap)")
	flag.DurationVar(&o.watchedFor, "watched-for", envDuration("WATCHED_FOR", 0), "send live traffic only this long after the last console call (0: always)")
	flag.IntVar(&o.seed, "seed", 0, "requests sent at start when the gateway has no comparisons yet")
	flag.IntVar(&o.askPerHour, "ask-per-hour", envInt("ASK_PER_HOUR", 20), "visitor questions per client address per hour")
	flag.IntVar(&o.askMaxChars, "ask-max-chars", envInt("ASK_MAX_CHARS", 600), "longest visitor question, in characters")
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
	go d.seedOnStart(ctx)

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

func envString(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v >= 0 {
		return v
	}
	return def
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
	reseeding  atomic.Bool
	asked      atomic.Int64
	lastSeen   atomic.Int64 // unix nanoseconds of the last console call

	incidentModels map[string]bool
	incidentNames  []string
	askLimiter     *limiter

	mu         sync.Mutex
	incidents  map[string]incident
	resetTimer *time.Timer
	lastReset  time.Time
	reqDay     string
	reqToday   int
}

type incident struct {
	Model    string    `json:"model"`
	ErrorPct int       `json:"error_pct"`
	Since    time.Time `json:"since"`
	Until    time.Time `json:"until"`
	timer    *time.Timer
}

// bareModel drops a "provider/" prefix.
func bareModel(m string) string {
	if _, after, ok := strings.Cut(m, "/"); ok {
		return after
	}
	return m
}

func newDoor(o options) (*door, error) {
	gw, err := url.Parse(o.gateway)
	if err != nil || gw.Scheme == "" || gw.Host == "" {
		return nil, fmt.Errorf("frontdoor: bad -gateway %q", o.gateway)
	}
	d := &door{
		o:              o,
		gateway:        gw,
		client:         &http.Client{Timeout: 120 * time.Second},
		started:        time.Now(),
		limiter:        newLimiter(o.postsPerMin, time.Minute),
		askLimiter:     newLimiter(o.askPerHour, time.Hour),
		incidents:      map[string]incident{},
		incidentModels: map[string]bool{},
	}
	// The models a visitor may break: the candidates. The primary stays healthy
	// so callers keep getting answers.
	for _, m := range strings.Split(o.incidentList, ",") {
		if m = bareModel(strings.TrimSpace(m)); m != "" && !d.incidentModels[m] {
			d.incidentModels[m] = true
			d.incidentNames = append(d.incidentNames, m)
		}
	}
	if len(d.incidentNames) == 0 {
		return nil, errors.New("frontdoor: -incident-models names no model")
	}
	d.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(gw)
			r.Out.Host = gw.Host
			// Callers cannot bring their own credentials; the door's token is the only one.
			r.Out.Header.Del("Authorization")
			r.Out.Header.Del("Cookie")
			// The gateway refuses management calls from origins it does not list
			// while dashboard auth is off, and browsers send Origin on every POST.
			// The door is the gateway's only client: the route allowlist above is
			// the boundary, and callers carry no credentials to protect.
			r.Out.Header.Del("Origin")
			r.Out.Header.Del("Referer")
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
	mux.HandleFunc("POST /api/demo/ask", d.ask)
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
	d.lastSeen.Store(time.Now().UnixNano())
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d.proxy.ServeHTTP(w, r)
}

// demoStatus is the payload of GET /api/demo/status.
type demoStatus struct {
	StartedAt                  time.Time  `json:"started_at"`
	UptimeSeconds              int64      `json:"uptime_seconds"`
	LiveTrafficEveryMS         int64      `json:"live_traffic_every_ms"`
	LiveSent                   int64      `json:"live_sent"`
	LiveFailed                 int64      `json:"live_failed"`
	BurstRunning               bool       `json:"burst_running"`
	BurstSent                  int64      `json:"burst_sent"`
	BurstMax                   int        `json:"burst_max"`
	Reseeding                  bool       `json:"reseeding"`
	LastReset                  *time.Time `json:"last_reset,omitempty"`
	Incidents                  []incident `json:"incidents"`
	IncidentModels             []string   `json:"incident_models"`
	IncidentTTLSeconds         int64      `json:"incident_ttl_seconds"`
	CanaryTTLSeconds           int64      `json:"canary_ttl_seconds"`
	Upstream                   string     `json:"upstream"`
	PrimaryModel               string     `json:"primary_model"`
	RequestsToday              int        `json:"requests_today"`
	DailyRequestCap            int        `json:"daily_request_cap"`
	LiveTrafficOnlyWhenWatched bool       `json:"live_traffic_only_when_watched"`
	Asked                      int64      `json:"asked"`
	AskMaxChars                int        `json:"ask_max_chars"`
	AskPerHour                 int        `json:"ask_per_hour"`
}

func (d *door) status(w http.ResponseWriter, _ *http.Request) {
	d.lastSeen.Store(time.Now().UnixNano())
	d.mu.Lock()
	d.rollDay(time.Now())
	today := d.reqToday
	incs := make([]incident, 0, len(d.incidents))
	for _, inc := range d.incidents {
		incs = append(incs, inc)
	}
	var lastReset *time.Time
	if !d.lastReset.IsZero() {
		t := d.lastReset.UTC()
		lastReset = &t
	}
	d.mu.Unlock()
	writeJSON(w, http.StatusOK, demoStatus{
		StartedAt:                  d.started.UTC(),
		UptimeSeconds:              int64(time.Since(d.started).Seconds()),
		LiveTrafficEveryMS:         d.o.trafficEvery.Milliseconds(),
		LiveSent:                   d.liveSent.Load(),
		LiveFailed:                 d.liveFailed.Load(),
		BurstRunning:               d.burstBusy.Load(),
		BurstSent:                  d.burstSent.Load(),
		BurstMax:                   d.o.burstMax,
		Reseeding:                  d.reseeding.Load(),
		LastReset:                  lastReset,
		Incidents:                  incs,
		IncidentModels:             d.incidentNames,
		IncidentTTLSeconds:         int64(d.o.incidentTTL.Seconds()),
		CanaryTTLSeconds:           int64(d.o.canaryTTL.Seconds()),
		Upstream:                   d.o.upstream,
		PrimaryModel:               bareModel(d.o.model),
		RequestsToday:              today,
		DailyRequestCap:            d.o.dailyRequests,
		LiveTrafficOnlyWhenWatched: d.o.watchedFor > 0,
		Asked:                      d.asked.Load(),
		AskMaxChars:                d.o.askMaxChars,
		AskPerHour:                 d.o.askPerHour,
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
	req.Model = bareModel(req.Model)
	if !d.incidentModels[req.Model] {
		writeError(w, http.StatusBadRequest, "model must be one of: "+strings.Join(d.incidentNames, ", "))
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
	old, had := d.incidents[model]
	if had && old.timer != nil {
		old.timer.Stop()
	}
	if d.resetTimer != nil {
		d.resetTimer.Stop()
		d.resetTimer = nil
	}
	if pct == 0 {
		delete(d.incidents, model)
		log.Printf("frontdoor: incident on %s cleared", model)
		// The incident's failures stay in the candidate's scorecard and would keep
		// it from being ready for the next visitor: once the last incident is over,
		// start the scorecards again from a fresh replay.
		if had && len(d.incidents) == 0 && d.o.resetAfter > 0 {
			d.resetTimer = time.AfterFunc(d.o.resetAfter, d.resetScores)
		}
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

// resetScores clears records and counters (spend, canaries and the rollout
// log are kept) and replays o.reseed requests, so every candidate has a verdict
// again within a minute or two.
func (d *door) resetScores() {
	if !d.reseeding.CompareAndSwap(false, true) {
		return
	}
	defer d.reseeding.Store(false)
	// Public bursts wait while the replay runs.
	for !d.burstBusy.CompareAndSwap(false, true) {
		time.Sleep(time.Second)
	}
	defer d.burstBusy.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := d.gatewayJSON(ctx, http.MethodDelete, "/api/shadow/records", nil, nil); err != nil {
		log.Printf("frontdoor: reset: %v", err)
		return
	}
	d.mu.Lock()
	d.lastReset = time.Now()
	d.mu.Unlock()
	n := d.take(d.o.reseed)
	log.Printf("frontdoor: scorecards cleared after the incident; replaying %d requests", n)
	d.sendMany(ctx, n, 8, nil)
}

// rollDay starts a new request count at UTC midnight. Callers hold d.mu.
func (d *door) rollDay(now time.Time) {
	if day := now.UTC().Format("2006-01-02"); day != d.reqDay {
		d.reqDay, d.reqToday = day, 0
	}
}

// take reserves up to n requests from today's cap and returns how many it got.
func (d *door) take(n int) int {
	if n <= 0 {
		return 0
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.rollDay(time.Now())
	if d.o.dailyRequests > 0 {
		left := d.o.dailyRequests - d.reqToday
		if left <= 0 {
			return 0
		}
		n = min(n, left)
	}
	d.reqToday += n
	return n
}

// seedOnStart sends o.seed requests once the gateway is up, unless it already
// has comparisons (a restart with persisted records).
func (d *door) seedOnStart(ctx context.Context) {
	if d.o.seed <= 0 {
		return
	}
	for !d.gatewayHealthy(ctx) {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
	var sum struct {
		Counters struct {
			Completed int `json:"completed"`
		} `json:"counters"`
	}
	if err := d.gatewayJSON(ctx, http.MethodGet, "/api/shadow/summary", nil, &sum); err == nil && sum.Counters.Completed > 0 {
		return
	}
	n := d.take(d.o.seed)
	log.Printf("frontdoor: seeding %d requests", n)
	d.sendMany(ctx, n, 4, nil)
}

// streamed decides whether one live or burst request is sent streamed.
func (d *door) streamed() bool {
	return d.o.streamPct > 0 && rand.IntN(100) < d.o.streamPct
}

// sendMany sends n dataset requests through the gateway, conc at a time.
func (d *door) sendMany(ctx context.Context, n, conc int, sent *atomic.Int64) {
	jobs := make(chan dataset.Item)
	var wg sync.WaitGroup
	for range conc {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				_ = d.send(ctx, item, d.streamed())
				if sent != nil {
					sent.Add(1)
				}
			}
		}()
	}
	items := dataset.Items()
	for range n {
		select {
		case jobs <- items[rand.IntN(len(items))]:
		case <-ctx.Done():
		}
	}
	close(jobs)
	wg.Wait()
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
	n := d.take(req.N)
	if n == 0 {
		d.burstBusy.Store(false)
		writeError(w, http.StatusTooManyRequests, "the demo's daily request cap is reached; it resets at midnight UTC")
		return
	}
	go func(n int) {
		defer d.burstBusy.Store(false)
		d.sendMany(context.Background(), n, 4, &d.burstSent)
	}(n)
	writeJSON(w, http.StatusAccepted, map[string]any{"queued": n})
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
		if d.o.watchedFor > 0 && time.Since(time.Unix(0, d.lastSeen.Load())) > d.o.watchedFor {
			continue // nobody is watching: spend nothing
		}
		if d.take(1) == 0 {
			continue
		}
		if err := d.send(ctx, items[rand.IntN(len(items))], d.streamed()); err != nil {
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
	d.shape(body)
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

// shape adds the door's per-request limits to a chat completion body.
func (d *door) shape(body map[string]any) {
	if d.o.maxTokens > 0 {
		body["max_tokens"] = d.o.maxTokens
	}
	if d.o.effort != "" {
		body["reasoning_effort"] = d.o.effort
	}
}

type askRequest struct {
	Prompt string `json:"prompt"`
}

// askResponse is the payload of POST /api/demo/ask.
type askResponse struct {
	RequestID    string `json:"request_id"`
	Model        string `json:"model"`
	Answer       string `json:"answer"`
	FinishReason string `json:"finish_reason,omitempty"`
	LatencyMS    int64  `json:"latency_ms"`
	Shadowed     bool   `json:"shadowed"`
	InputTokens  int    `json:"input_tokens"`
	OutputTokens int    `json:"output_tokens"`
}

// ask serves POST /api/demo/ask {"prompt": "..."}: the question goes through the
// gateway to the primary model with x-bf-shadow: force, so every candidate is
// replayed and judged on it. The response carries the gateway's request ID; the
// shadow records for it appear under /api/shadow/records within seconds.
func (d *door) ask(w http.ResponseWriter, r *http.Request) {
	d.lastSeen.Store(time.Now().UnixNano())
	var req askRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "body must be JSON: {\"prompt\": \"...\"}")
		return
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		writeError(w, http.StatusBadRequest, "ask a question")
		return
	}
	if n := len([]rune(prompt)); n > d.o.askMaxChars {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("keep the question under %d characters (this one has %d)", d.o.askMaxChars, n))
		return
	}
	if !d.askLimiter.allow(clientAddr(r), time.Now()) {
		w.Header().Set("Retry-After", "3600")
		writeError(w, http.StatusTooManyRequests, fmt.Sprintf("this address has asked %d questions in the last hour; try again later", d.o.askPerHour))
		return
	}
	if d.take(1) == 0 {
		writeError(w, http.StatusTooManyRequests, "the demo's daily request cap is reached; it resets at midnight UTC")
		return
	}
	d.asked.Add(1)

	body := map[string]any{
		"model": d.o.model,
		"messages": []map[string]string{
			{"role": "system", "content": "You are a concise, accurate assistant. Answer in a few sentences at most."},
			{"role": "user", "content": prompt},
		},
	}
	d.shape(body)
	payload, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(r.Context(), 110*time.Second)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, http.MethodPost, d.o.gateway+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out.Header.Set("Content-Type", "application/json")
	out.Header.Set("x-bf-shadow", "force")
	start := time.Now()
	resp, err := d.client.Do(out)
	if err != nil {
		writeError(w, http.StatusBadGateway, "the gateway did not answer: "+err.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		msg := e.Error.Message
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		writeError(w, http.StatusBadGateway, fmt.Sprintf("the primary model answered %d: %s", resp.StatusCode, msg))
		return
	}
	var cc struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &cc); err != nil || len(cc.Choices) == 0 {
		writeError(w, http.StatusBadGateway, "the gateway's answer could not be read")
		return
	}
	res := askResponse{
		RequestID:    firstHeader(resp.Header, "X-Bifrost-Request-Id", "X-Request-Id"),
		Model:        bareModel(d.o.model),
		Answer:       contentString(cc.Choices[0].Message.Content),
		FinishReason: cc.Choices[0].FinishReason,
		LatencyMS:    time.Since(start).Milliseconds(),
		Shadowed:     strings.EqualFold(resp.Header.Get("x-bf-shadow"), "sampled"),
		InputTokens:  cc.Usage.PromptTokens,
		OutputTokens: cc.Usage.CompletionTokens,
	}
	writeJSON(w, http.StatusOK, res)
}

func firstHeader(h http.Header, names ...string) string {
	for _, n := range names {
		if v := h.Get(n); v != "" {
			return v
		}
	}
	return ""
}

// contentString flattens a chat message's content, a string or a list of parts.
func contentString(c any) string {
	switch v := c.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, part := range v {
			if m, ok := part.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					b.WriteString(t)
				}
			}
		}
		return b.String()
	}
	return ""
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
