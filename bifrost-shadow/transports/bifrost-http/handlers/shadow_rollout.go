package handlers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
	"github.com/google/uuid"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/plugins/routing/rules"
	"github.com/maximhq/bifrost/plugins/shadow"
)

// ShadowRoutingRules is what promotion and rollback need from the routing-rule
// store. Every write must also refresh the routing engine's in-memory rules, so
// a change serves traffic without a restart.
type ShadowRoutingRules interface {
	ListRoutingRules(ctx context.Context) ([]configstoreTables.TableRoutingRule, error)
	CreateRoutingRule(ctx context.Context, rule *configstoreTables.TableRoutingRule) error
	UpdateRoutingRule(ctx context.Context, rule *configstoreTables.TableRoutingRule) error
	DeleteRoutingRule(ctx context.Context, id string) error
}

// ShadowRuleReloader refreshes one routing rule in the running routing engine.
// The HTTP server implements it (it is part of RoutingManager).
type ShadowRuleReloader interface {
	ReloadRoutingRule(ctx context.Context, id string) error
	RemoveRoutingRule(ctx context.Context, id string) error
}

// configStoreRoutingRules writes routing rules the way the routing-rules API
// does: config store first, then the routing engine's cache.
type configStoreRoutingRules struct {
	store    configstore.ConfigStore
	reloader ShadowRuleReloader
}

// NewShadowRoutingRules returns the routing-rule store promotion writes to.
func NewShadowRoutingRules(store configstore.ConfigStore, reloader ShadowRuleReloader) ShadowRoutingRules {
	if store == nil || reloader == nil {
		return nil
	}
	return &configStoreRoutingRules{store: store, reloader: reloader}
}

func (c *configStoreRoutingRules) ListRoutingRules(ctx context.Context) ([]configstoreTables.TableRoutingRule, error) {
	return c.store.GetRoutingRules(ctx)
}

func (c *configStoreRoutingRules) CreateRoutingRule(ctx context.Context, rule *configstoreTables.TableRoutingRule) error {
	if err := c.store.CreateRoutingRule(ctx, rule); err != nil {
		return err
	}
	return c.reloader.ReloadRoutingRule(ctx, rule.ID)
}

func (c *configStoreRoutingRules) UpdateRoutingRule(ctx context.Context, rule *configstoreTables.TableRoutingRule) error {
	if err := c.store.UpdateRoutingRule(ctx, rule); err != nil {
		return err
	}
	return c.reloader.ReloadRoutingRule(ctx, rule.ID)
}

// DeleteRoutingRule takes the rule out of the routing engine before the store:
// a rollback has to stop traffic first. If the store delete then fails, the
// rule is still listed, so a retried rollback finds it and deletes it again.
func (c *configStoreRoutingRules) DeleteRoutingRule(ctx context.Context, id string) error {
	if err := c.reloader.RemoveRoutingRule(ctx, id); err != nil {
		return err
	}
	return c.store.DeleteRoutingRule(ctx, id)
}

// shadowRolloutMu serializes promotions and rollbacks, which read, merge and
// write the same routing rule.
var shadowRolloutMu sync.Mutex

// Errors a promotion or rollback can return; handlers map them to HTTP statuses.
var (
	errShadowNotReady     = errors.New("candidate is not ready")
	errShadowRuleConflict = errors.New("an existing routing rule takes precedence")
	errShadowNoCanary     = errors.New("no canary rule found")
	errShadowBadShares    = errors.New("candidate shares exceed 100%")
	errShadowStore        = errors.New("routing rule store")
	// errShadowRampConflict: the shares would fit now, but not once another
	// candidate's ramp (or this one) reaches its last step.
	errShadowRampConflict = errors.New("another canary's ramp needs that share")
	// errShadowRuleDisabled: the canary rule was disabled by hand; a ramp step
	// does not turn it back on.
	errShadowRuleDisabled = errors.New("the canary rule is disabled")
)

// ruleOverlap is how a routing rule relates to requests for the source model.
type ruleOverlap int

const (
	overlapNone  ruleOverlap = iota
	overlapMaybe             // depends on request data other than provider and model
	overlapYes               // matches every chat request for the source model
)

// shadowCELEnv mirrors the routing engine's CEL variables, so a rule that
// compiles there compiles here.
var shadowCELEnv = sync.OnceValues(func() (*cel.Env, error) {
	return cel.NewEnv(
		cel.Variable("model", cel.StringType),
		cel.Variable("provider", cel.StringType),
		cel.Variable("request_type", cel.StringType),
		cel.Variable("headers", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("params", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("virtual_key_id", cel.StringType),
		cel.Variable("virtual_key_name", cel.StringType),
		cel.Variable("user_id", cel.StringType),
		cel.Variable("team_id", cel.StringType),
		cel.Variable("team_name", cel.StringType),
		cel.Variable("customer_id", cel.StringType),
		cel.Variable("customer_name", cel.StringType),
		cel.Variable("tokens_used", cel.DoubleType),
		cel.Variable("request", cel.DoubleType),
		cel.Variable("budget_used", cel.DoubleType),
		cel.Variable("complexity_tier", cel.StringType),
	)
})

// requestScopedCELVars are unknown when judging a rule against "every request
// for this model": a rule that depends on them may or may not match.
var requestScopedCELVars = []string{
	"headers", "params", "virtual_key_id", "virtual_key_name", "user_id", "team_id",
	"team_name", "customer_id", "customer_name", "tokens_used", "request", "budget_used", "complexity_tier",
}

// celOverlap partially evaluates a rule's CEL expression with only the provider,
// model and chat request type known. A rule that cannot be compiled is reported
// as a possible overlap: the routing engine skips it, but it should be fixed.
func celOverlap(expr string, source shadow.ModelRef) ruleOverlap {
	if strings.TrimSpace(expr) == "" {
		return overlapYes // an empty expression matches everything
	}
	env, err := shadowCELEnv()
	if err != nil {
		return overlapMaybe
	}
	ast, iss := env.Compile(expr)
	if iss != nil && iss.Err() != nil {
		return overlapMaybe
	}
	prg, err := env.Program(ast, cel.EvalOptions(cel.OptPartialEval))
	if err != nil {
		return overlapMaybe
	}
	patterns := make([]*cel.AttributePatternType, 0, len(requestScopedCELVars))
	for _, v := range requestScopedCELVars {
		patterns = append(patterns, cel.AttributePattern(v))
	}
	// Every chat request means both request types: a rule that matches only
	// streamed requests may catch some of the source's traffic, not all of it.
	matches := 0
	for _, rt := range []string{"chat_completion", "chat_completion_stream"} {
		act, err := cel.PartialVars(map[string]any{
			"provider":     string(source.Provider),
			"model":        source.Model,
			"request_type": rt,
		}, patterns...)
		if err != nil {
			return overlapMaybe
		}
		out, _, err := prg.Eval(act)
		switch {
		case err != nil || types.IsUnknown(out):
			return overlapMaybe
		case out.Value() == true:
			matches++
		}
	}
	switch matches {
	case 2:
		return overlapYes
	case 1:
		return overlapMaybe
	}
	return overlapNone
}

// isCanaryRuleFor reports whether rule is a shadow canary for source: global,
// named by the plugin, and matching exactly the source's expression.
func isCanaryRuleFor(rule *configstoreTables.TableRoutingRule, plan *shadow.CanaryRule) bool {
	return rule.Scope == "global" &&
		strings.HasPrefix(rule.Name, shadow.CanaryRuleNamePrefix+plan.Source.String()+" ->") &&
		strings.TrimSpace(rule.CelExpression) == plan.CelExpression
}

// targetRef reads a routing target as a model reference.
func targetRef(t configstoreTables.TableRoutingTarget) shadow.ModelRef {
	var ref shadow.ModelRef
	if t.Provider != nil {
		ref.Provider = schemas.ModelProvider(*t.Provider)
	}
	if t.Model != nil {
		ref.Model = *t.Model
	}
	return ref
}

func sameRef(a, b shadow.ModelRef) bool {
	return strings.EqualFold(string(a.Provider), string(b.Provider)) && strings.EqualFold(a.Model, b.Model)
}

// canaryShares returns the candidate shares of an existing canary rule: every
// target that is not the source.
func canaryShares(rule *configstoreTables.TableRoutingRule, source shadow.ModelRef) map[string]shadowShare {
	shares := map[string]shadowShare{}
	for _, t := range rule.Targets {
		ref := targetRef(t)
		if sameRef(ref, source) {
			continue
		}
		shares[ref.String()] = shadowShare{ref: ref, weight: t.Weight}
	}
	return shares
}

type shadowShare struct {
	ref    shadow.ModelRef
	weight float64
}

// buildCanaryTargets turns candidate shares into rule targets: the source takes
// whatever the candidates leave, and is dropped when they take everything.
// Weights are rounded to four decimals and sum to exactly 1.
func buildCanaryTargets(source shadow.ModelRef, shares map[string]shadowShare) ([]configstoreTables.TableRoutingTarget, []string, error) {
	keys := make([]string, 0, len(shares))
	total := 0.0
	for k, s := range shares {
		keys = append(keys, k)
		total += shadow.Round4(s.weight)
	}
	sort.Strings(keys)
	if total > 1+1e-9 {
		return nil, nil, fmt.Errorf("%w: candidates would get %.2f%% of %s traffic", errShadowBadShares, total*100, source)
	}
	targets := make([]configstoreTables.TableRoutingTarget, 0, len(shares)+1)
	if rest := shadow.Round4(1 - total); rest >= shadow.MinCanaryWeight {
		targets = append(targets, routingTarget(source, rest))
	}
	for _, k := range keys {
		targets = append(targets, routingTarget(shares[k].ref, shadow.Round4(shares[k].weight)))
	}
	// Rounding can leave the sum a hair off 1; the source (or the first target) absorbs it.
	sum := 0.0
	for _, t := range targets {
		sum += t.Weight
	}
	if diff := 1 - sum; math.Abs(diff) > 1e-12 && len(targets) > 0 {
		targets[0].Weight = shadow.Round4(targets[0].Weight + diff)
	}
	return targets, keys, nil
}

func routingTarget(ref shadow.ModelRef, weight float64) configstoreTables.TableRoutingTarget {
	provider, model := string(ref.Provider), ref.Model
	return configstoreTables.TableRoutingTarget{Provider: &provider, Model: &model, Weight: weight}
}

// canaryRuleName names a canary rule after its source and candidates.
func canaryRuleName(source shadow.ModelRef, candidates []string) string {
	return shadow.CanaryRuleNamePrefix + source.String() + " -> " + strings.Join(candidates, ", ")
}

// shadowPromotion is the plan (and, unless a dry run, the outcome) of a promotion.
type shadowPromotion struct {
	Action   string                              `json:"action"` // "create" or "update"
	DryRun   bool                                `json:"dry_run"`
	Rule     *configstoreTables.TableRoutingRule `json:"rule"`
	Warnings []string                            `json:"warnings"`
	// Conflicts are enabled rules that would stop the canary from ever seeing
	// source traffic. A promotion with conflicts is refused.
	Conflicts []string           `json:"conflicts,omitempty"`
	Evidence  shadow.PairSummary `json:"evidence"`
	// Ramp is the promotion's ramp, as it starts: present only when one was asked for.
	Ramp  *shadow.CanaryRamp   `json:"ramp,omitempty"`
	Event *shadow.RolloutEvent `json:"event,omitempty"`
}

// shadowPromoteInput is a promotion request after validation.
type shadowPromoteInput struct {
	experiment     string
	candidate      string
	weight         float64
	priority       *int
	overrideReason string
	dryRun         bool
	// ramp is the validated ramp (weight is its first step), or nil.
	ramp *shadow.CanaryRamp
}

// shareEdit sets one candidate's share of its source model's traffic in the
// source's canary rule. Promotion and the canary guard's ramp both make it.
type shareEdit struct {
	experiment string
	candidate  string
	weight     float64
	// priority applies to a new rule only.
	priority *int
	// peak is the highest share the candidate will reach (a ramp's last step).
	// It is checked against the other candidates' shares now, so a ramp cannot
	// be accepted that could never finish.
	peak float64
	// existingOnly edits the source's canary rule, which must already route
	// the candidate, and never creates one (the guard's ramp).
	existingOnly bool
}

// planShareEdit plans a share change: it merges the candidate's share into the
// source's canary rule (or a new rule), and checks every other enabled rule.
// It fills out.Action, out.Rule, out.Warnings and out.Conflicts, and returns
// the canary plan. Nothing is written.
//
// If a shadow canary rule for the same source exists, the candidate is merged
// into it rather than added as a second rule: the routing engine stops at the
// first matching terminal rule, so a second rule for the same source would
// never serve traffic. Enabled rules that match every request for the source
// and run first are conflicts (errShadowRuleConflict); rules that may match
// some requests are reported as warnings.
func planShareEdit(ctx context.Context, p ShadowReader, store ShadowRoutingRules, e shareEdit, out *shadowPromotion) (*shadow.CanaryRule, error) {
	plan, err := p.BuildCanaryRule(e.experiment, e.candidate, e.weight)
	if err != nil {
		return nil, err
	}
	existingRules, err := store.ListRoutingRules(ctx)
	if err != nil {
		return plan, fmt.Errorf("%w: list routing rules: %w", errShadowStore, err)
	}

	var current *configstoreTables.TableRoutingRule
	for i := range existingRules {
		if isCanaryRuleFor(&existingRules[i], plan) {
			current = &existingRules[i]
			break
		}
	}

	var rule configstoreTables.TableRoutingRule
	shares := map[string]shadowShare{}
	if current != nil {
		rule = *current
		out.Action = "update"
		if e.priority != nil && *e.priority != rule.Priority {
			out.Warnings = append(out.Warnings, fmt.Sprintf("kept the existing canary rule's priority %d; the requested priority %d applies only to a new rule", rule.Priority, *e.priority))
		}
		shares = canaryShares(current, plan.Source)
	} else {
		out.Action = "create"
		rule = configstoreTables.TableRoutingRule{
			ID:            uuid.NewString(),
			CelExpression: plan.CelExpression,
			Scope:         "global",
			Priority:      freeGlobalPriority(existingRules, e.priority),
		}
	}
	if e.existingOnly {
		if _, ok := shares[plan.Candidate.String()]; !ok {
			return plan, fmt.Errorf("%w: no canary rule routes %s traffic to %s", errShadowNoCanary, plan.Source, plan.Candidate)
		}
		if !current.EnabledValue() {
			return plan, fmt.Errorf("%w: %q was disabled outside the shadow API; the ramp holds until it is enabled again", errShadowRuleDisabled, current.Name)
		}
	} else if err := checkRampPeaks(p, plan, shares, e); err != nil {
		return plan, err
	}
	shares[plan.Candidate.String()] = shadowShare{ref: plan.Candidate, weight: e.weight}
	targets, names, err := buildCanaryTargets(plan.Source, shares)
	if err != nil {
		return plan, err
	}
	if !e.existingOnly {
		// A promotion turns the canary on; a ramp step never changes it (a
		// disabled rule was refused above).
		enabled := true
		rule.Enabled = &enabled
	}
	rule.ChainRule = false
	rule.Targets = targets
	rule.Name = canaryRuleName(plan.Source, names)
	rule.Description = fmt.Sprintf("Created by shadow traffic evaluation from experiment %q. Candidates get %s of %s traffic; the source serves the rest.", e.experiment, strings.Join(shareList(targets, plan.Source), ", "), plan.Source)

	for i := range existingRules {
		other := &existingRules[i]
		if current != nil && other.ID == current.ID {
			continue
		}
		if !other.EnabledValue() {
			continue
		}
		overlap := celOverlap(other.CelExpression, plan.Source)
		if overlap == overlapNone {
			continue
		}
		label := fmt.Sprintf("%q (scope %s, priority %d)", other.Name, other.Scope, other.Priority)
		switch {
		case other.Scope != "global":
			out.Warnings = append(out.Warnings, fmt.Sprintf("rule %s is scoped, so it takes precedence over the global canary for the requests it covers", label))
		case other.Priority < rule.Priority && overlap == overlapYes && !other.ChainRule:
			out.Conflicts = append(out.Conflicts, fmt.Sprintf("rule %s matches every %s request and runs first, so the canary would never serve traffic; disable it, or create the canary with a priority below %d", label, plan.Source, other.Priority))
		case other.Priority < rule.Priority:
			out.Warnings = append(out.Warnings, fmt.Sprintf("rule %s runs first and may match some %s requests; those will not reach the canary", label, plan.Source))
		default:
			out.Warnings = append(out.Warnings, fmt.Sprintf("rule %s runs after the canary and will no longer see %s requests the canary matches", label, plan.Source))
		}
	}
	out.Rule = &rule
	if len(out.Conflicts) > 0 {
		return plan, fmt.Errorf("%w: %s", errShadowRuleConflict, strings.Join(out.Conflicts, "; "))
	}
	if err := validateShadowRule(&rule); err != nil {
		return plan, err
	}
	return plan, nil
}

// checkRampPeaks refuses a promotion whose shares fit now but would not once
// the ramps on the source's canary rule finish: the candidate's own ramp peak
// (e.peak) plus, for every other candidate in the rule, the larger of its
// current share and its unfinished ramp's last step. Without the check a
// ramp could be accepted, or a second candidate added, that leaves a ramp
// unable to reach its last step.
func checkRampPeaks(p ShadowReader, plan *shadow.CanaryRule, shares map[string]shadowShare, e shareEdit) error {
	peaks := map[string]float64{}
	for _, c := range p.Rollouts().Canaries {
		if c.Ramp == nil || c.Ramp.Completed || !sameRef(c.Source, plan.Source) || len(c.Ramp.Steps) == 0 {
			continue
		}
		peaks[c.Candidate.String()] = c.Ramp.Steps[len(c.Ramp.Steps)-1]
	}
	own := shadow.Round4(e.peak)
	total := own
	others := 0.0
	var ramping []string
	for k, s := range shares {
		if k == plan.Candidate.String() {
			continue
		}
		w := shadow.Round4(s.weight)
		if peak, ok := peaks[k]; ok && peak > w {
			ramping = append(ramping, fmt.Sprintf("%s is ramping to %g%%", k, shadow.Round4(peak*100)))
			w = peak
		}
		total += w
		others += w
	}
	if total <= 1+1e-9 {
		return nil
	}
	sort.Strings(ramping)
	what := fmt.Sprintf("%g%%", shadow.Round4(e.weight*100))
	if own > shadow.Round4(e.weight) {
		what = fmt.Sprintf("a ramp to %g%%", shadow.Round4(own*100))
	}
	switch {
	case len(ramping) > 0:
		return fmt.Errorf("%w: %s for %s plus %g%% that the other candidates of %s will hold comes to more than 100%% (%s); roll back or re-promote that candidate first, or choose a smaller share", errShadowRampConflict, what, plan.Candidate, shadow.Round4(others*100), plan.Source, strings.Join(ramping, "; "))
	case own > shadow.Round4(e.weight):
		return fmt.Errorf("%w: the ramp's last step (%g%%) and the other candidates' %g%% of %s traffic add up to more than 100%%", errShadowBadShares, shadow.Round4(own*100), shadow.Round4(others*100), plan.Source)
	}
	return nil // current shares only: buildCanaryTargets refuses it with its own message
}

// saveShareEdit writes a planned share change to the routing-rule store.
func saveShareEdit(ctx context.Context, store ShadowRoutingRules, out *shadowPromotion) error {
	var err error
	if out.Action == "update" {
		err = store.UpdateRoutingRule(ctx, out.Rule)
	} else {
		err = store.CreateRoutingRule(ctx, out.Rule)
	}
	if err != nil {
		return fmt.Errorf("%w: save routing rule: %w", errShadowStore, err)
	}
	return nil
}

// promoteShadowCandidate gives a candidate a share of its source model's live
// traffic through a weighted routing rule (see planShareEdit for the merge and
// the conflict check).
//
// A candidate whose verdict is not "ready" is refused unless the operator gives
// an override reason, which is recorded with the evidence. With a ramp the
// canary starts at the ramp's first step and the canary guard raises it; a
// promotion of a canary that is ramping replaces its ramp, or cancels it when
// the promotion has none.
func promoteShadowCandidate(ctx context.Context, p ShadowReader, store ShadowRoutingRules, in shadowPromoteInput) (*shadowPromotion, error) {
	evidence, err := p.PairScorecard(in.experiment, in.candidate)
	if err != nil {
		return nil, err
	}
	out := &shadowPromotion{DryRun: in.dryRun, Evidence: evidence, Warnings: []string{}, Ramp: in.ramp}
	override := evidence.Verdict != shadow.VerdictReady
	if override && strings.TrimSpace(in.overrideReason) == "" {
		return out, fmt.Errorf("%w: verdict is %s (%s); pass override_reason to promote anyway", errShadowNotReady, evidence.Verdict, evidence.VerdictReason)
	}
	edit := shareEdit{experiment: in.experiment, candidate: in.candidate, weight: in.weight, priority: in.priority, peak: in.weight}
	if in.ramp != nil {
		edit.peak = in.ramp.Steps[len(in.ramp.Steps)-1]
	}
	plan, err := planShareEdit(ctx, p, store, edit, out)
	if err != nil {
		return out, err
	}
	out.Warnings = append(out.Warnings, rampWarnings(p, in.experiment, plan.Candidate, in.ramp)...)
	if in.dryRun {
		return out, nil
	}
	if err := saveShareEdit(ctx, store, out); err != nil {
		return out, err
	}
	ev, err := p.RecordRollout(shadow.RolloutEvent{
		Action:     shadow.RolloutPromote,
		Experiment: in.experiment,
		Source:     plan.Source,
		Candidate:  plan.Candidate,
		Weight:     shadow.Round4(in.weight),
		RuleID:     out.Rule.ID,
		RuleName:   out.Rule.Name,
		Override:   override,
		Reason:     strings.TrimSpace(in.overrideReason),
		Evidence:   &evidence,
		Ramp:       in.ramp,
	})
	switch {
	case errors.Is(err, shadow.ErrRolloutNotSaved):
		out.Warnings = append(out.Warnings, "the promotion is in effect, but the rollout log could not be written to disk: "+err.Error())
	case err != nil:
		out.Warnings = append(out.Warnings, "the routing rule was saved but the rollout log was not: "+err.Error())
	}
	out.Event = &ev
	if ev.Ramp != nil {
		out.Ramp = ev.Ramp // as recorded: the first step starts with the event
	}
	return out, nil
}

// rampWarnings says what a promotion does to a ramp: that it cancels or
// replaces the canary's running ramp, and that without auto_rollback an
// unhealthy step holds a new ramp instead of rolling it back.
func rampWarnings(p ShadowReader, experiment string, candidate shadow.ModelRef, ramp *shadow.CanaryRamp) []string {
	var out []string
	rollouts := p.Rollouts()
	for _, c := range rollouts.Canaries {
		if c.Experiment != experiment || c.Candidate.String() != candidate.String() || c.Ramp == nil || c.Ramp.Completed {
			continue
		}
		at := fmt.Sprintf("step %d of %d (%g%%)", c.Ramp.CurrentStep+1, len(c.Ramp.Steps), shadow.Round4(c.Ramp.Steps[c.Ramp.CurrentStep]*100))
		if ramp == nil {
			out = append(out, fmt.Sprintf("this cancels the canary's ramp at %s: the guard will not raise its weight again", at))
		} else {
			out = append(out, fmt.Sprintf("this replaces the canary's ramp at %s; the new ramp starts at %g%%", at, shadow.Round4(ramp.Steps[0]*100)))
		}
	}
	if ramp != nil && !rollouts.AutoRollback {
		out = append(out, "canary.auto_rollback is off: an unhealthy step holds the ramp where it is instead of rolling the canary back")
	}
	return out
}

// validateShadowRule runs the same checks the routing-rules API runs.
func validateShadowRule(rule *configstoreTables.TableRoutingRule) error {
	if err := rules.ValidateCELExpression(rule.CelExpression); err != nil {
		return fmt.Errorf("invalid CEL expression: %w", err)
	}
	targets := make([]RoutingTarget, 0, len(rule.Targets))
	for _, t := range rule.Targets {
		targets = append(targets, RoutingTarget{Provider: t.Provider, Model: t.Model, Weight: t.Weight})
	}
	return validateRoutingTargets(targets)
}

// shareList renders candidate shares for a rule description.
func shareList(targets []configstoreTables.TableRoutingTarget, source shadow.ModelRef) []string {
	var out []string
	for _, t := range targets {
		ref := targetRef(t)
		if sameRef(ref, source) {
			continue
		}
		out = append(out, fmt.Sprintf("%s %g%%", ref, shadow.Round4(t.Weight*100)))
	}
	return out
}

// freeGlobalPriority returns the requested priority, or the first priority at or
// above the default that no global rule uses (one rule per priority per scope).
func freeGlobalPriority(existing []configstoreTables.TableRoutingRule, requested *int) int {
	if requested != nil {
		return *requested
	}
	used := map[int]bool{}
	for _, r := range existing {
		if r.Scope == "global" {
			used[r.Priority] = true
		}
	}
	p := shadow.DefaultCanaryPriority
	for used[p] {
		p++
	}
	return p
}

// shadowRollback is the outcome of removing a candidate from its canary.
type shadowRollback struct {
	Action string                              `json:"action"` // "update", "delete" or "none"
	Rule   *configstoreTables.TableRoutingRule `json:"rule,omitempty"`
	Event  *shadow.RolloutEvent                `json:"event,omitempty"`
}

// rollbackShadowCanary removes a candidate from its source's canary rule. The
// source takes the candidate's share back; a rule left with only the source is
// deleted. It does not touch the rollout log: callers record the event.
func rollbackShadowCanary(ctx context.Context, p ShadowReader, store ShadowRoutingRules, experiment, candidate string) (*shadowRollback, *shadow.CanaryRule, error) {
	plan, err := p.BuildCanaryRule(experiment, candidate, 1)
	if err != nil {
		return nil, nil, err
	}
	existingRules, err := store.ListRoutingRules(ctx)
	if err != nil {
		return nil, plan, fmt.Errorf("list routing rules: %w", err)
	}
	for i := range existingRules {
		rule := existingRules[i]
		if !isCanaryRuleFor(&rule, plan) {
			continue
		}
		shares := canaryShares(&rule, plan.Source)
		if _, ok := shares[plan.Candidate.String()]; !ok {
			continue
		}
		delete(shares, plan.Candidate.String())
		if len(shares) == 0 {
			if err := store.DeleteRoutingRule(ctx, rule.ID); err != nil {
				return nil, plan, fmt.Errorf("delete routing rule: %w", err)
			}
			return &shadowRollback{Action: "delete", Rule: &rule}, plan, nil
		}
		targets, names, err := buildCanaryTargets(plan.Source, shares)
		if err != nil {
			return nil, plan, err
		}
		rule.Targets = targets
		rule.Name = canaryRuleName(plan.Source, names)
		if err := store.UpdateRoutingRule(ctx, &rule); err != nil {
			return nil, plan, fmt.Errorf("update routing rule: %w", err)
		}
		return &shadowRollback{Action: "update", Rule: &rule}, plan, nil
	}
	return &shadowRollback{Action: "none"}, plan, errShadowNoCanary
}

// NewShadowRollbackHook returns the function the plugin's canary guard calls to
// roll back an unhealthy canary. It holds the promotion lock throughout: the
// guard's current check, the rule edit and the guard's done callback (which
// records the auto_rollback event) cannot interleave with a promotion.
func NewShadowRollbackHook(p ShadowReader, store ShadowRoutingRules) shadow.RollbackFunc {
	if p == nil || store == nil {
		return nil
	}
	return func(ctx context.Context, experiment, candidate, _ string, current func() bool, done func() error) error {
		shadowRolloutMu.Lock()
		defer shadowRolloutMu.Unlock()
		if current != nil && !current() {
			return shadow.ErrCanaryChanged
		}
		_, _, err := rollbackShadowCanary(ctx, p, store, experiment, candidate)
		if err != nil && !errors.Is(err, errShadowNoCanary) {
			return err
		}
		// errShadowNoCanary: the rule is already gone (removed by hand), so only
		// the watch is left to close.
		if done != nil {
			return done()
		}
		return nil
	}
}

// NewShadowRampHook returns the function the plugin's canary guard calls to
// move a ramping canary to its next step. Like the rollback hook it holds the
// promotion lock throughout, so the guard's current check, the rule edit and
// the guard's done callback (which records the ramp event) cannot interleave
// with a promotion or a rollback. The new share is written through the same
// merge promotion uses, into the source's existing canary rule only: other
// candidates keep their shares and the source serves the rest.
func NewShadowRampHook(p ShadowReader, store ShadowRoutingRules) shadow.RampFunc {
	if p == nil || store == nil {
		return nil
	}
	return func(ctx context.Context, experiment, candidate string, weight float64, current func() bool, done func(ruleID, ruleName string) error) error {
		shadowRolloutMu.Lock()
		defer shadowRolloutMu.Unlock()
		if current != nil && !current() {
			return shadow.ErrCanaryChanged
		}
		out := &shadowPromotion{Warnings: []string{}}
		if _, err := planShareEdit(ctx, p, store, shareEdit{experiment: experiment, candidate: candidate, weight: weight, peak: weight, existingOnly: true}, out); err != nil {
			return err
		}
		if err := saveShareEdit(ctx, store, out); err != nil {
			return err
		}
		if done != nil {
			return done(out.Rule.ID, out.Rule.Name)
		}
		return nil
	}
}
