// Command loadgen replays the demo workload through a Bifrost gateway: short
// answers, arithmetic, JSON extraction, tool calling and open-ended writing, a
// share of it streamed. When it finishes it waits for the shadow queue to drain
// and prints the per-candidate scorecard from /api/shadow/summary.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"text/tabwriter"
	"time"

	"github.com/maximhq/bifrost/examples/shadow-demo/dataset"
)

type options struct {
	gateway     string
	model       string
	requests    int
	concurrency int
	streamPct   int
	shadowMode  string
	virtualKey  string
	seed        int64
	wait        time.Duration
	reportOnly  bool
}

type result struct {
	status  int
	latency time.Duration
	sampled bool
	stream  bool
	err     error
}

func main() {
	var o options
	flag.StringVar(&o.gateway, "gateway", "http://localhost:8080", "Bifrost gateway base URL")
	flag.StringVar(&o.model, "model", "openai/gpt-4o", "model to request (provider/model)")
	flag.IntVar(&o.requests, "n", 300, "number of requests to send")
	flag.IntVar(&o.concurrency, "c", 8, "concurrent clients")
	flag.IntVar(&o.streamPct, "stream", 25, "percentage of requests sent with stream=true")
	flag.StringVar(&o.shadowMode, "shadow", "", "x-bf-shadow header to send: force, off, or empty for sampling")
	flag.StringVar(&o.virtualKey, "vk", "", "virtual key to send as x-bf-vk")
	flag.Int64Var(&o.seed, "seed", 7, "workload shuffle seed")
	flag.DurationVar(&o.wait, "wait", 90*time.Second, "max time to wait for shadow comparisons to finish")
	flag.BoolVar(&o.reportOnly, "report", false, "only print the current shadow summary")
	flag.StringVar(&setupToken, "setup-token", os.Getenv("BIFROST_SETUP_TOKEN"), "X-Bifrost-Setup-Token for /api calls before dashboard auth is configured")
	flag.Parse()

	if o.reportOnly {
		if err := printSummary(o.gateway); err != nil {
			fail(err)
		}
		return
	}
	if err := run(o); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "loadgen:", err)
	os.Exit(1)
}

func run(o options) error {
	items := dataset.Items()
	rng := rand.New(rand.NewSource(o.seed))
	order := make([]int, o.requests)
	for i := range order {
		order[i] = rng.Intn(len(items))
	}
	streamFlags := make([]bool, o.requests)
	for i := range streamFlags {
		streamFlags[i] = rng.Intn(100) < o.streamPct
	}

	before, _ := fetchCounters(o.gateway)
	client := &http.Client{Timeout: 60 * time.Second}
	jobs := make(chan int)
	results := make([]result, o.requests)
	var done atomic.Int64
	var wg sync.WaitGroup
	start := time.Now()
	for w := 0; w < o.concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i] = send(client, o, items[order[i]], streamFlags[i])
				if n := done.Add(1); n%50 == 0 || int(n) == o.requests {
					fmt.Printf("  sent %d/%d\n", n, o.requests)
				}
			}
		}()
	}
	fmt.Printf("Replaying %d requests to %s as %s (%d concurrent, %d%% streamed)\n", o.requests, o.gateway, o.model, o.concurrency, o.streamPct)
	for i := 0; i < o.requests; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(start)

	var ok, failed, sampled, streamed int
	var latencies []time.Duration
	errSamples := map[string]int{}
	for _, r := range results {
		if r.stream {
			streamed++
		}
		if r.err != nil || r.status != http.StatusOK {
			failed++
			key := fmt.Sprintf("HTTP %d", r.status)
			if r.err != nil {
				key = r.err.Error()
			}
			errSamples[key]++
			continue
		}
		ok++
		latencies = append(latencies, r.latency)
		if r.sampled {
			sampled++
		}
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	fmt.Printf("\nPrimary traffic: %d ok, %d failed, %d streamed, %d marked x-bf-shadow: sampled, %.1f req/s\n",
		ok, failed, streamed, sampled, float64(o.requests)/elapsed.Seconds())
	if len(latencies) > 0 {
		fmt.Printf("Client latency: p50 %v  p95 %v\n", latencies[len(latencies)/2].Round(time.Millisecond),
			latencies[len(latencies)*95/100].Round(time.Millisecond))
	}
	for k, n := range errSamples {
		fmt.Printf("  %dx %s\n", n, k)
	}

	if err := waitForShadow(o.gateway, before, o.wait); err != nil {
		fmt.Println("warning:", err)
	}
	return printSummary(o.gateway)
}

var weatherTool = json.RawMessage(`[{"type":"function","function":{"name":"get_weather","description":"Current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"},"unit":{"type":"string","enum":["celsius","fahrenheit"]}},"required":["city"]}}}]`)

func send(client *http.Client, o options, item dataset.Item, stream bool) result {
	body := map[string]any{
		"model": o.model,
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
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(o.gateway, "/")+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return result{err: err, stream: stream}
	}
	req.Header.Set("Content-Type", "application/json")
	if o.shadowMode != "" {
		req.Header.Set("x-bf-shadow", o.shadowMode)
	}
	if o.virtualKey != "" {
		req.Header.Set("x-bf-vk", o.virtualKey)
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return result{err: err, stream: stream}
	}
	defer resp.Body.Close()
	if stream && resp.StatusCode == http.StatusOK {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == "data: [DONE]" {
				break
			}
		}
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return result{
		status:  resp.StatusCode,
		latency: time.Since(start),
		sampled: resp.Header.Get("x-bf-shadow") == "sampled",
		stream:  stream,
	}
}

type counters struct {
	Sampled       int64 `json:"sampled"`
	Enqueued      int64 `json:"enqueued"`
	Dropped       int64 `json:"dropped"`
	Completed     int64 `json:"completed"`
	CandidateErrs int64 `json:"candidate_errors"`
	InFlight      int64 `json:"in_flight"`
	QueueDepth    int64 `json:"queue_depth"`
}

func fetchCounters(gateway string) (counters, error) {
	var s struct {
		Counters counters `json:"counters"`
	}
	err := getJSON(strings.TrimRight(gateway, "/")+"/api/shadow/summary", &s)
	return s.Counters, err
}

// waitForShadow polls until the shadow queue is empty and no comparison is in
// flight on two consecutive polls, or the timeout passes.
func waitForShadow(gateway string, before counters, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	fmt.Print("\nWaiting for shadow comparisons")
	idle := 0
	for {
		c, err := fetchCounters(gateway)
		if err != nil {
			fmt.Println()
			return fmt.Errorf("shadow summary unavailable: %w", err)
		}
		if c.QueueDepth == 0 && c.InFlight == 0 {
			idle++
		} else {
			idle = 0
		}
		if idle >= 2 {
			fmt.Printf(" done: %d sampled, %d compared (%d candidate errors), %d dropped\n",
				c.Sampled-before.Sampled, c.Completed-before.Completed, c.CandidateErrs-before.CandidateErrs, c.Dropped-before.Dropped)
			return nil
		}
		if time.Now().After(deadline) {
			fmt.Println()
			return fmt.Errorf("%d queued and %d in-flight shadow comparisons after %v", c.QueueDepth, c.InFlight, timeout)
		}
		fmt.Print(".")
		time.Sleep(time.Second)
	}
}

type pair struct {
	Experiment string `json:"experiment"`
	Candidate  struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	} `json:"candidate"`
	Samples             int     `json:"samples"`
	Errors              int     `json:"errors"`
	AgreementRate       float64 `json:"agreement_rate"`
	AgreementLowerBound float64 `json:"agreement_lower_bound"`
	ErrorRate           float64 `json:"error_rate"`
	AvgPrimaryScore     float64 `json:"avg_primary_score"`
	AvgCandidateScore   float64 `json:"avg_candidate_score"`
	PrimaryLatency      struct {
		P50 float64 `json:"p50_ms"`
	} `json:"primary_latency"`
	CandidateLatency struct {
		P50 float64 `json:"p50_ms"`
	} `json:"candidate_latency"`
	SavingsPct           float64 `json:"savings_pct"`
	SavingsPerMillionUSD float64 `json:"savings_per_million_usd"`
	Verdict              string  `json:"verdict"`
	VerdictReason        string  `json:"verdict_reason"`
}

func printSummary(gateway string) error {
	var s struct {
		SampleRate     float64  `json:"sample_rate"`
		JudgeModel     string   `json:"judge_model"`
		SpendTodayUSD  float64  `json:"spend_today_usd"`
		DailyBudgetUSD float64  `json:"daily_budget_usd"`
		Counters       counters `json:"counters"`
		Pairs          []pair   `json:"pairs"`
	}
	if err := getJSON(strings.TrimRight(gateway, "/")+"/api/shadow/summary", &s); err != nil {
		return err
	}
	fmt.Printf("\nShadow scorecard (sample rate %.0f%%, judge %s, eval spend today $%.4f)\n\n", s.SampleRate*100, orDash(s.JudgeModel), s.SpendTodayUSD)
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "CANDIDATE\tSAMPLES\tAGREE\tLOWER95\tERRORS\tJUDGE (P/C)\tP50 (P/C)\tSAVINGS\t$/1M REQ\tVERDICT")
	for _, p := range s.Pairs {
		fmt.Fprintf(tw, "%s/%s\t%d\t%.1f%%\t%.1f%%\t%.1f%%\t%.1f / %.1f\t%.0f / %.0f ms\t%.1f%%\t$%.0f\t%s\n",
			p.Candidate.Provider, p.Candidate.Model, p.Samples, p.AgreementRate*100, p.AgreementLowerBound*100,
			p.ErrorRate*100, p.AvgPrimaryScore, p.AvgCandidateScore, p.PrimaryLatency.P50, p.CandidateLatency.P50,
			p.SavingsPct, p.SavingsPerMillionUSD, strings.ToUpper(strings.ReplaceAll(p.Verdict, "_", " ")))
	}
	_ = tw.Flush()
	fmt.Println()
	for _, p := range s.Pairs {
		fmt.Printf("  %s/%s: %s\n", p.Candidate.Provider, p.Candidate.Model, p.VerdictReason)
	}
	return nil
}

// setupToken authenticates /api calls on a gateway whose dashboard auth is not set up yet.
var setupToken string

func getJSON(url string, v any) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if setupToken != "" {
		req.Header.Set("X-Bifrost-Setup-Token", setupToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GET %s: HTTP %d: %s", url, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
