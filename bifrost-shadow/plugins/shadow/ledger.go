package shadow

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// spendLedger tracks what shadow work spent on the current UTC day.
//
// It outlives plugin instances. Updating the plugin's settings or reloading it
// builds a new Plugin, and a budget kept on the instance would start again from
// zero on the same day. Ledgers are therefore shared per process, one per
// persist path (one memory-only ledger when there is none), and with a persist
// path the day's total is also written to <persist_path>.spend.json so a gateway
// restart keeps it too.
//
// The budget is enforced with reservations: a job reserves the expected cost of
// one job (a moving average of recent jobs) before its calls start, and releases
// it when it finishes and its actual cost is added. In-flight work therefore
// counts against the budget, and concurrent workers cannot all slip under it at
// once. Until the first job has finished there is no estimate, so the very first
// jobs of a process can overshoot by at most max_concurrency jobs.
type spendLedger struct {
	mu       sync.Mutex
	day      string
	spent    float64
	reserved float64
	estimate float64 // moving average cost of one job, USD
	path     string  // sidecar file; "" keeps the ledger in memory only
	loaded   bool    // the sidecar existed when the ledger was created
}

// ledgerFile is the on-disk form of a ledger.
type ledgerFile struct {
	Day      string  `json:"day"`
	SpentUSD float64 `json:"spent_usd"`
	// EstimateUSD is the moving average cost of one job, kept so a restarted
	// gateway reserves sensible amounts from its first job.
	EstimateUSD float64 `json:"estimate_usd,omitempty"`
}

// ledgers holds the process's ledgers by key (see ledgerKey).
var (
	ledgersMu sync.Mutex
	ledgers   = map[string]*spendLedger{}
)

const memoryLedgerKey = "memory"

// ledgerKey returns the registry key for a persist path.
func ledgerKey(persistPath string) string {
	if persistPath == "" {
		return memoryLedgerKey
	}
	if abs, err := filepath.Abs(persistPath); err == nil {
		return "file:" + abs
	}
	return "file:" + persistPath
}

// ledgerFor returns the process's ledger for a persist path, creating (and,
// with a path, loading) it on first use. created reports a new ledger.
func ledgerFor(persistPath string) (l *spendLedger, created bool, err error) {
	key := ledgerKey(persistPath)
	ledgersMu.Lock()
	defer ledgersMu.Unlock()
	if l, ok := ledgers[key]; ok {
		return l, false, nil
	}
	l = &spendLedger{}
	if persistPath != "" {
		l.path = persistPath + ".spend.json"
		if err := l.load(); err != nil {
			return nil, false, err
		}
	}
	ledgers[key] = l
	return l, true, nil
}

// load reads the sidecar file. A missing file is an empty ledger; an unreadable
// one is reported, so the budget is never silently lifted by a corrupt file.
func (l *spendLedger) load() error {
	data, err := os.ReadFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("shadow: read spend ledger: %w", err)
	}
	var f ledgerFile
	if err := json.Unmarshal(data, &f); err != nil {
		return fmt.Errorf("shadow: parse spend ledger %s: %w", l.path, err)
	}
	if f.SpentUSD < 0 || f.EstimateUSD < 0 {
		return fmt.Errorf("shadow: spend ledger %s holds a negative amount", l.path)
	}
	l.day, l.spent, l.estimate, l.loaded = f.Day, f.SpentUSD, f.EstimateUSD, true
	return nil
}

// saveLocked writes the ledger atomically: temp file, then rename. Caller holds mu.
func (l *spendLedger) saveLocked() error {
	if l.path == "" {
		return nil
	}
	data, err := json.Marshal(ledgerFile{Day: l.day, SpentUSD: l.spent, EstimateUSD: l.estimate})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(l.path), filepath.Base(l.path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("shadow: write spend ledger: %w", err)
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), l.path)
	}
	if werr != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("shadow: write spend ledger: %w", werr)
	}
	return nil
}

// rollLocked starts a new day's total when day has moved on. Reservations are
// in-flight work and carry over. Caller holds mu.
func (l *spendLedger) rollLocked(day string) {
	if l.day != day {
		l.day = day
		l.spent = 0
	}
}

// seed sets today's spend when a ledger is created without a sidecar file but
// records from today exist (files written before ledgers did). It never lowers
// a total.
func (l *spendLedger) seed(day string, usd float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollLocked(day)
	if usd > l.spent {
		l.spent = usd
		_ = l.saveLocked()
	}
}

// fullLocked reports whether another job no longer fits in the budget: spent
// plus reserved spend reached it, or one more job of the estimated cost would
// pass it. Caller holds mu.
func (l *spendLedger) fullLocked(budget float64) bool {
	committed := l.spent + l.reserved
	return committed >= budget || (l.estimate > 0 && committed+l.estimate > budget)
}

// exhausted reports whether the budget has no room for another job today.
func (l *spendLedger) exhausted(day string, budget float64) bool {
	if budget <= 0 {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollLocked(day)
	return l.fullLocked(budget)
}

// reserve claims the expected cost of one job against the budget. It returns
// the amount reserved (release it when the job is done) and false when the job
// does not fit. Without a budget nothing is reserved.
func (l *spendLedger) reserve(day string, budget float64) (float64, bool) {
	if budget <= 0 {
		return 0, true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollLocked(day)
	if l.fullLocked(budget) {
		return 0, false
	}
	l.reserved += l.estimate
	return l.estimate, true
}

// release returns a reservation.
func (l *spendLedger) release(amount float64) {
	if amount <= 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.reserved -= amount
	if l.reserved < 1e-12 {
		l.reserved = 0
	}
}

// add records the actual cost of one finished job and updates the estimate.
func (l *spendLedger) add(day string, usd float64) error {
	if usd < 0 {
		usd = 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollLocked(day)
	l.spent += usd
	if l.estimate == 0 {
		l.estimate = usd
	} else {
		l.estimate = 0.8*l.estimate + 0.2*usd
	}
	if usd == 0 {
		return nil
	}
	return l.saveLocked()
}

// totals returns today's spent and reserved amounts.
func (l *spendLedger) totals(day string) (spent, reserved float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollLocked(day)
	return l.spent, l.reserved
}

// todaysRecordSpend sums the shadow and evaluation cost of records created on
// the given UTC day.
func todaysRecordSpend(records []*Record, day string) float64 {
	total := 0.0
	for _, r := range records {
		if r.CreatedAt.UTC().Format(time.DateOnly) == day {
			total += r.CandidateCostUSD + r.EvalCostUSD
		}
	}
	return total
}
