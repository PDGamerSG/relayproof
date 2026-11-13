package shadow

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// resetLedgers forgets every process-wide spend ledger and rollout book, so a
// test starts with no spend and no canaries.
func resetLedgers() {
	ledgersMu.Lock()
	ledgers = map[string]*spendLedger{}
	ledgersMu.Unlock()
	booksMu.Lock()
	books = map[string]*rolloutBook{}
	booksMu.Unlock()
}

// Regression for the review finding "restarting or reloading the plugin lifts
// the daily budget": a reload builds a new Plugin from the same settings, and
// the budget used to restart from zero on the same UTC day.
func TestDailyBudgetSurvivesPluginReload(t *testing.T) {
	for _, persist := range []bool{false, true} {
		name := "memory"
		if persist {
			name = "persisted"
		}
		t.Run(name, func(t *testing.T) {
			resetLedgers()
			cfg := func() *Config {
				c := baseConfig()
				c.DailyBudgetUSD = 0.0003 // one candidate call costs 0.00025
				if persist {
					c.PersistPath = filepath.Join(t.TempDir(), "shadow.jsonl")
				}
				return c
			}
			first := cfg()
			p, err := Init(context.Background(), first, testLogger)
			require.NoError(t, err)
			p.SetExecutors((&fakeClient{candidateText: "x"}).chat, nil, nil)
			runPrimary(t, p, "r-1", "hi", "x")
			waitForRecords(t, p, 1)
			require.True(t, p.budgetExhausted())
			require.NoError(t, p.Cleanup())

			// Same settings, new instance: what /api/plugins does on an update.
			again := cfg()
			again.PersistPath = first.PersistPath
			p2, err := Init(context.Background(), again, testLogger)
			require.NoError(t, err)
			t.Cleanup(func() { _ = p2.Cleanup() })
			assert.True(t, p2.budgetExhausted(), "a reload must not lift the budget")
			assert.InDelta(t, 0.00025, p2.Summary().SpendTodayUSD, 1e-12)
			assert.True(t, p2.Summary().BudgetExhausted)
		})
	}
}

// A gateway restart loses the process-wide ledger; with a persist path the
// sidecar file brings today's spend back.
func TestDailyBudgetSurvivesRestartWithPersistPath(t *testing.T) {
	resetLedgers()
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	cfg := baseConfig()
	cfg.DailyBudgetUSD = 1
	cfg.PersistPath = path
	p, err := Init(context.Background(), cfg, testLogger)
	require.NoError(t, err)
	p.addSpend(0.75)
	require.NoError(t, p.Cleanup())
	_, err = os.Stat(path + ".spend.json")
	require.NoError(t, err, "the ledger is written beside the records")

	resetLedgers() // a new process
	cfg2 := baseConfig()
	cfg2.DailyBudgetUSD = 1
	cfg2.PersistPath = path
	p2, err := Init(context.Background(), cfg2, testLogger)
	require.NoError(t, err)
	t.Cleanup(func() { _ = p2.Cleanup() })
	assert.InDelta(t, 0.75, p2.spendToday(), 1e-12)

	// Yesterday's file does not count today.
	p2.now = func() time.Time { return time.Now().Add(24 * time.Hour) }
	assert.Zero(t, p2.spendToday())
}

// A records file written before ledgers existed still counts toward today.
func TestLedgerSeededFromTodaysRecords(t *testing.T) {
	resetLedgers()
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	st, err := newStore(10, path)
	require.NoError(t, err)
	require.NoError(t, st.add(&Record{ID: "a", CreatedAt: time.Now(), CandidateCostUSD: 0.2, EvalCostUSD: 0.05}))
	require.NoError(t, st.add(&Record{ID: "b", CreatedAt: time.Now().Add(-48 * time.Hour), CandidateCostUSD: 5}))
	require.NoError(t, st.close())

	cfg := baseConfig()
	cfg.PersistPath = path
	p, err := Init(context.Background(), cfg, testLogger)
	require.NoError(t, err)
	t.Cleanup(func() { _ = p.Cleanup() })
	assert.InDelta(t, 0.25, p.spendToday(), 1e-12, "only today's records count")
}

func TestCorruptLedgerFileIsAnError(t *testing.T) {
	resetLedgers()
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	require.NoError(t, os.WriteFile(path+".spend.json", []byte("{not json"), 0o600))
	cfg := baseConfig()
	cfg.PersistPath = path
	_, err := Init(context.Background(), cfg, testLogger)
	assert.ErrorContains(t, err, "spend ledger", "a corrupt ledger must not silently lift the budget")
}

// Reservations make the budget a cap for concurrent work: once one job's cost is
// known, jobs that would push committed spend past the budget are refused.
func TestLedgerReservations(t *testing.T) {
	l := &spendLedger{}
	day := "2026-11-13"

	amount, ok := l.reserve(day, 1)
	require.True(t, ok)
	assert.Zero(t, amount, "no estimate before the first job")
	l.release(amount)
	require.NoError(t, l.add(day, 0.3))

	var got []float64
	for i := 0; i < 5; i++ {
		amount, ok := l.reserve(day, 1)
		if !ok {
			break
		}
		got = append(got, amount)
	}
	// 0.3 spent; each reservation is 0.3; two more fit under 1.0, a third would not.
	assert.Len(t, got, 2)
	spent, reserved := l.totals(day)
	assert.InDelta(t, 0.3, spent, 1e-12)
	assert.InDelta(t, 0.6, reserved, 1e-12)
	assert.True(t, l.exhausted(day, 1), "0.9 committed of 1.0 leaves no room for a 0.3 job")

	for _, a := range got {
		l.release(a)
	}
	_, reserved = l.totals(day)
	assert.Zero(t, reserved)

	// No budget: nothing is reserved or refused.
	amount, ok = l.reserve(day, 0)
	assert.True(t, ok)
	assert.Zero(t, amount)
}

func TestLedgerConcurrentUse(t *testing.T) {
	l := &spendLedger{}
	day := "2026-11-13"
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a, ok := l.reserve(day, 1000); ok {
				_ = l.add(day, 0.01)
				l.release(a)
			}
		}()
	}
	wg.Wait()
	spent, reserved := l.totals(day)
	assert.InDelta(t, 0.5, spent, 1e-9)
	assert.Zero(t, reserved)
}
