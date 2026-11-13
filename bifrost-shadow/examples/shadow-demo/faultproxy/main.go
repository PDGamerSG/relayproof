// Command faultproxy sits between the gateway and a real provider and injects
// failures on demand, so the hosted demo can show the canary guard rolling back
// a real model without waiting for a real outage. It forwards every request
// unchanged (the gateway's API key included) except while an incident is set
// for the requested model:
//
//	POST /admin/incident?model=claude-sonnet-5-5&error_pct=60
//
// makes that share of the model's requests fail with HTTP 529 and Anthropic's
// overloaded_error body; error_pct=0 clears it. The admin route is the same as
// the mock upstream's, so the front door drives either. Listen on loopback only:
// the admin route has no authentication.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"sync"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18081", "listen address (keep it on loopback)")
	upstream := flag.String("upstream", "https://api.anthropic.com", "provider base URL to forward to")
	flag.Parse()
	h, err := newProxy(*upstream)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("faultproxy: %s -> %s", *addr, *upstream)
	log.Fatal(http.ListenAndServe(*addr, h))
}

type proxy struct {
	forward   *httputil.ReverseProxy
	mu        sync.RWMutex
	incidents map[string]int
}

func newProxy(upstream string) (*proxy, error) {
	target, err := url.Parse(upstream)
	if err != nil {
		return nil, err
	}
	p := &proxy{incidents: map[string]int{}}
	p.forward = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
		},
		// Pass streamed responses through as they arrive.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("faultproxy: upstream: %v", err)
			writeError(w, http.StatusBadGateway, "api_error", "upstream not reachable")
		},
	}
	return p, nil
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/admin/incident":
		p.setIncident(w, r)
		return
	case "/healthz":
		_, _ = io.WriteString(w, "ok")
		return
	}
	if r.Body != nil && r.Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
		_ = r.Body.Close()
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request_error", "could not read the request body")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		var probe struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(body, &probe) == nil && p.fail(probe.Model) {
			writeError(w, 529, "overloaded_error", "Overloaded (simulated incident)")
			return
		}
	}
	p.forward.ServeHTTP(w, r)
}

func (p *proxy) fail(model string) bool {
	p.mu.RLock()
	pct := p.incidents[model]
	p.mu.RUnlock()
	return pct > 0 && rand.IntN(100) < pct
}

func (p *proxy) setIncident(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "invalid_request_error", "use POST")
		return
	}
	model := r.URL.Query().Get("model")
	pct, err := strconv.Atoi(r.URL.Query().Get("error_pct"))
	if model == "" || err != nil || pct < 0 || pct > 100 {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "model and error_pct (0-100) are required")
		return
	}
	p.mu.Lock()
	if pct == 0 {
		delete(p.incidents, model)
	} else {
		p.incidents[model] = pct
	}
	p.mu.Unlock()
	log.Printf("faultproxy: incident: %s fails %d%% of requests", model, pct)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"model": model, "error_pct": pct})
}

func writeError(w http.ResponseWriter, status int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": map[string]any{"type": kind, "message": msg}})
}
