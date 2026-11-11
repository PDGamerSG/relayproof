package shadow

import (
	"fmt"
	"math"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRecordsLimitDefaultsAndClamps(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	for i := 0; i < 600; i++ {
		require.NoError(t, p.store.add(&Record{ID: fmt.Sprint(i)}))
	}
	for limit, want := range map[int]int{0: 50, -5: 50, 1: 1, 100: 100, 500: 500, 501: 500, 10_000: 500} {
		recs, total := p.Records(RecordFilter{Limit: limit})
		assert.Equal(t, 600, total)
		assert.Equal(t, want, len(recs), "limit=%d", limit)
	}
}

func TestBuildCanaryRuleRejectsUnusableWeights(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	for _, w := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 0, -0.25, 0.00004, 0.000099, 1.0001, 2} {
		rule, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, w)
		require.Error(t, err, "weight %v", w)
		assert.NotErrorIs(t, err, ErrUnknownPair)
		assert.Contains(t, err.Error(), "weight must be a number from 0.0001 to 1", "weight %v", w)
		assert.Nil(t, rule)
	}
}

// TestBuildCanaryRuleTargetsAreRoutable checks every accepted weight yields targets
// the routing rules API accepts: each weight above 0 and all summing to 1.
func TestBuildCanaryRuleTargetsAreRoutable(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	for _, w := range []float64{0.0001, 0.00015, 0.0005, 0.1, 0.12345, 0.5, 0.9999, 0.99994, 0.99996, 1} {
		rule, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, w)
		require.NoError(t, err, "weight %v", w)
		total := 0.0
		for _, target := range rule.Targets {
			assert.Greater(t, target.Weight, 0.0, "weight %v: %+v", w, rule.Targets)
			total += target.Weight
		}
		assert.InDelta(t, 1, total, 0.001, "weight %v: %+v", w, rule.Targets)
	}

	smallest, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, 0.0001)
	require.NoError(t, err)
	assert.Equal(t, []RoutingTarget{
		{Provider: "openai", Model: primaryModel, Weight: 0.9999},
		{Provider: "openai", Model: candidateModel, Weight: 0.0001},
	}, smallest.Targets)

	// 0.99996 rounds to a full cutover: the primary's 0.00004 share is below what a target can carry.
	nearlyAll, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, 0.99996)
	require.NoError(t, err)
	assert.Equal(t, []RoutingTarget{{Provider: "openai", Model: candidateModel, Weight: 1}}, nearlyAll.Targets)
	assert.Contains(t, nearlyAll.Description, "Sends 100% of")
}

func TestBuildCanaryRuleNameIsStablePerPair(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	for _, w := range []float64{0.1, 0.5, 1} {
		rule, err := p.BuildCanaryRule("big-to-small", "openai/"+candidateModel, w)
		require.NoError(t, err)
		assert.Equal(t, "Shadow canary: openai/gpt-big -> openai/gpt-small", rule.Name, "the name must not change when the weight is ramped")
		assert.Equal(t, 10, rule.Priority)
	}
}

func TestBuildCanaryRulePriority(t *testing.T) {
	p := newTestPlugin(t, baseConfig())
	cand := "openai/" + candidateModel

	rule, err := p.BuildCanaryRule("big-to-small", cand, 0.1)
	require.NoError(t, err)
	assert.Equal(t, DefaultCanaryPriority, rule.Priority)

	for _, priority := range []int{0, 25} {
		rule, err := p.BuildCanaryRule("big-to-small", cand, 0.1, priority)
		require.NoError(t, err)
		assert.Equal(t, priority, rule.Priority)
	}

	_, err = p.BuildCanaryRule("big-to-small", cand, 0.1, -1)
	assert.ErrorContains(t, err, "priority must be a non-negative integer")
	_, err = p.BuildCanaryRule("big-to-small", cand, 0.1, 1, 2)
	assert.Error(t, err)
}
