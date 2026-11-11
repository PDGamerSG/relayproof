package shadow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fileLines returns the lines of a persist file; a final line without '\n' counts.
func fileLines(t *testing.T, path string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	if len(data) == 0 {
		return nil
	}
	return bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
}

// fileIDs returns the IDs of the records a persist file holds, skipping lines that do not parse.
func fileIDs(t *testing.T, path string) []string {
	t.Helper()
	ids := []string{}
	for _, line := range fileLines(t, path) {
		var rec Record
		if json.Unmarshal(line, &rec) == nil {
			ids = append(ids, rec.ID)
		}
	}
	return ids
}

func storeIDs(st *store) []string {
	ids := []string{}
	for _, r := range st.snapshot() {
		ids = append(ids, r.ID)
	}
	return ids
}

func TestStoreCompactsPersistFileWhileAppending(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	const maxRecords = 10
	st, err := newStore(maxRecords, path)
	require.NoError(t, err)
	longest := 0
	for i := 0; i < 250; i++ {
		require.NoError(t, st.add(&Record{ID: fmt.Sprintf("r%d", i)}))
		longest = max(longest, len(fileLines(t, path)))
	}
	require.NoError(t, st.close())
	assert.LessOrEqual(t, longest, 2*maxRecords, "the persist file is compacted instead of growing with every record")

	reopened, err := newStore(maxRecords, path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = reopened.close() })
	want := []string{}
	for i := 240; i < 250; i++ {
		want = append(want, fmt.Sprintf("r%d", i))
	}
	assert.Equal(t, want, storeIDs(reopened), "a restart reloads the newest max_records records, oldest first")
}

func TestStoreCompactsOversizedFileOnOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	var buf bytes.Buffer
	for i := 0; i < 1000; i++ {
		line, err := json.Marshal(&Record{ID: fmt.Sprintf("r%d", i)})
		require.NoError(t, err)
		buf.Write(line)
		buf.WriteByte('\n')
	}
	buf.WriteString(`{"id":"torn`) // a crash mid-write
	require.NoError(t, os.WriteFile(path, buf.Bytes(), 0o600))

	st, err := newStore(10, path)
	require.NoError(t, err)
	assert.LessOrEqual(t, len(fileLines(t, path)), 10, "opening a file far above max_records rewrites it with only the retained records")
	assert.Equal(t, "r999", st.snapshot()[9].ID)

	require.NoError(t, st.add(&Record{ID: "after-crash"}))
	require.NoError(t, st.close())
	reopened, err := newStore(10, path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = reopened.close() })
	ids := storeIDs(reopened)
	require.Len(t, ids, 10)
	assert.Equal(t, "after-crash", ids[9], "the first record after a restart survives the next restart")
	assert.Equal(t, "r991", ids[0])
}

func TestStoreTornLastLineDoesNotSwallowNextRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	require.NoError(t, os.WriteFile(path, []byte(`{"id":"r0"}`+"\n"+`{"id":"r1"}`+"\n"+`{"id":"torn`), 0o600))

	st, err := newStore(10, path)
	require.NoError(t, err)
	assert.Equal(t, []string{"r0", "r1"}, storeIDs(st), "the torn line is skipped")
	require.NoError(t, st.add(&Record{ID: "after-crash"}))
	require.NoError(t, st.close())

	reopened, err := newStore(10, path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = reopened.close() })
	assert.Equal(t, []string{"r0", "r1", "after-crash"}, storeIDs(reopened), "the record appended after a torn line is not merged into it")
}

// TestStoreResetAndAddStayConsistent checks that a reset racing with adds never
// leaves a record only in memory or only in the file.
func TestStoreResetAndAddStayConsistent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shadow.jsonl")
	st, err := newStore(1_000_000, path) // no eviction or compaction: memory and file must match exactly
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.close() })

	// A large payload widens the gap between a record entering the ring and reaching the file.
	payload := string(bytes.Repeat([]byte("p"), 32*1024))
	for round := 0; round < 30; round++ {
		var wg sync.WaitGroup
		stop := make(chan struct{})
		for g := 0; g < 4; g++ {
			wg.Add(1)
			go func(g int) {
				defer wg.Done()
				for i := 0; ; i++ {
					select {
					case <-stop:
						return
					default:
					}
					assert.NoError(t, st.add(&Record{ID: fmt.Sprintf("%d-%d-%d", round, g, i), Prompt: payload}))
				}
			}(g)
		}
		for st.len() < 8 { // reset while adds are in flight
			runtime.Gosched()
		}
		require.NoError(t, st.reset())
		close(stop)
		wg.Wait()

		mem, disk := storeIDs(st), fileIDs(t, path)
		sort.Strings(mem)
		sort.Strings(disk)
		require.Equal(t, mem, disk, "round %d: records in memory and in the persist file differ after a reset raced with adds", round)
	}
}

// TestStoreAddDuringFailedResetDoesNotPanic covers a reset whose reopen fails
// while a worker is adding: add must not use the handle reset dropped.
func TestStoreAddDuringFailedResetDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shadow.jsonl")
	unreachable := filepath.Join(dir, "missing-dir", "shadow.jsonl")
	payload := string(bytes.Repeat([]byte("p"), 4000))

	for attempt := 0; attempt < 100; attempt++ {
		require.NoError(t, os.RemoveAll(path))
		st, err := newStore(100, path)
		require.NoError(t, err)
		require.NoError(t, st.add(&Record{ID: "before-reset"}))
		st.persistPath = unreachable // the reopen in reset now fails

		var (
			wg       sync.WaitGroup
			mu       sync.Mutex
			panicked any
		)
		stop := make(chan struct{})
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					mu.Lock()
					panicked = r
					mu.Unlock()
				}
			}()
			for {
				select {
				case <-stop:
					return
				default:
				}
				_ = st.add(&Record{ID: "during-reset", Prompt: payload})
			}
		}()
		resetErr := st.reset()
		close(stop)
		wg.Wait()
		require.Nil(t, panicked, "attempt %d: add panicked after reset failed to reopen the persist file", attempt)
		require.Error(t, resetErr, "reset reports that the persist file could not be reopened")

		// Once the file can be opened again, the next add completes the reset:
		// records from before it must not come back after a restart.
		st.persistPath = path
		require.NoError(t, st.add(&Record{ID: "after-recovery"}))
		require.NotContains(t, fileIDs(t, path), "before-reset", "attempt %d", attempt)
		require.Contains(t, fileIDs(t, path), "after-recovery", "attempt %d", attempt)
		require.NoError(t, st.close())
	}
}
