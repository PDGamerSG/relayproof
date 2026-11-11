import type { APIRequestContext } from "@playwright/test";
import { expect, test as base } from "../../core/fixtures/base.fixture";
import { ShadowTrafficPage, shadowPairSlug } from "./pages/shadow-traffic.page";
import {
  OUTCOME_FILTER_LABELS,
  SHADOW_SOURCE,
  STRONG_CANDIDATE,
  VERDICT_LABELS,
  WEAK_CANDIDATE,
  WINNER_LABELS,
  canaryRuleName,
  canaryShareSentence,
  createChatCompletionData,
  createShadowTrafficPrompts,
  firstFreeCanaryPriority,
  modelLabel,
  type RoutingRuleRecord,
  type ShadowPair,
  type ShadowRecordsPage,
  type ShadowSummary,
} from "./shadow-traffic.data";

// The page object is not registered in core/fixtures/base.fixture.ts, so this suite
// extends the shared fixture with it.
const test = base.extend<{ shadowTrafficPage: ShadowTrafficPage }>({
  shadowTrafficPage: async ({ page }, use) => {
    await use(new ShadowTrafficPage(page));
  },
});

const SUMMARY_API = "/api/shadow/summary";
const RECORDS_API = "/api/shadow/records";
const CANARY_RULE_API = "/api/shadow/canary-rule";
const RULES_API = "/api/routing/rules";
/** Records per page in the disagreements sheet. */
const RECORDS_PAGE_SIZE = 20;
/** Rounds of the demo prompt set mirrored when the server has too little shadow data. */
const SEED_ROUNDS = 3;

// Track created routing rules (by id) for cleanup
const createdRuleIds: string[] = [];

/** Counts as the page renders them (en). */
const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
const isPath = (url: string, path: string) => new URL(url).pathname === path;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function getSummary(request: APIRequestContext): Promise<ShadowSummary> {
  const res = await request.get(SUMMARY_API);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

function findPair(summary: ShadowSummary, candidate: string): ShadowPair | undefined {
  return (summary.pairs ?? []).find((pair) => modelLabel(pair.candidate) === candidate);
}

/** First page of records for one pair, as the disagreements sheet requests it. */
async function getRecords(
  request: APIRequestContext,
  pair: ShadowPair,
  outcome: "fail" | "error" | "pass",
): Promise<ShadowRecordsPage> {
  const res = await request.get(RECORDS_API, {
    params: {
      experiment: pair.experiment,
      candidate: modelLabel(pair.candidate),
      outcome,
      limit: RECORDS_PAGE_SIZE,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A disagreement on the first page that the judge scored and that kept both answers. */
function findJudgedDisagreement(fails: ShadowRecordsPage) {
  return (fails.records ?? []).find(
    (r) => r.judge && r.primary_answer?.text && r.candidate_answer?.text,
  );
}

async function getRoutingRules(request: APIRequestContext): Promise<RoutingRuleRecord[]> {
  const res = await request.get(RULES_API);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).rules ?? [];
}

async function getRoutingRule(request: APIRequestContext, id: string): Promise<RoutingRuleRecord> {
  const res = await request.get(`${RULES_API}/${id}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).rule;
}

/** The global rules named as the canary of the source -> candidate pair (names are unique per scope). */
async function getCanaryRules(
  request: APIRequestContext,
  candidate: string,
): Promise<RoutingRuleRecord[]> {
  return (await getRoutingRules(request)).filter(
    (rule) => rule.name === canaryRuleName(candidate) && rule.scope === "global" && !rule.scope_id,
  );
}

/** A test that promotes a pair from scratch needs it to have no canary rule yet. */
async function expectNoCanaryRule(request: APIRequestContext, candidate: string): Promise<void> {
  const leftovers = (await getCanaryRules(request, candidate)).map(
    (rule) => `${rule.name} (${rule.id})`,
  );
  expect(
    leftovers,
    `canary rules for ${candidate} left on the server; delete them before running this suite`,
  ).toEqual([]);
}

/** A rule's targets in a comparable form. */
function targetWeights(rule: RoutingRuleRecord) {
  return rule.targets.map(({ provider, model, weight }) => ({ provider, model, weight }));
}

/** The preview lists each target with its share: "openai/gpt-4o 90%". */
async function expectPreviewShare(
  shadowTrafficPage: ShadowTrafficPage,
  model: string,
  percent: number,
): Promise<void> {
  await expect(shadowTrafficPage.preview).toContainText(
    new RegExp(`${escapeRegExp(model)}\\s+${percent}%`),
    {
      useInnerText: true,
    },
  );
}

/**
 * Confirm the promote dialog while it creates a canary, and return the new rule (tracked for cleanup).
 */
async function confirmCreate(shadowTrafficPage: ShadowTrafficPage): Promise<RoutingRuleRecord> {
  await expect(shadowTrafficPage.promoteConfirmBtn).toHaveText("Create canary rule");
  const createdResponse = shadowTrafficPage.page.waitForResponse(
    (res) => isPath(res.url(), RULES_API) && res.request().method() === "POST",
  );
  await shadowTrafficPage.promoteConfirmBtn.click();
  const created = await createdResponse;
  expect(created.ok(), await created.text()).toBe(true);
  const rule = (await created.json()).rule as RoutingRuleRecord;
  createdRuleIds.push(rule.id);
  await expect(shadowTrafficPage.promoteDialog).not.toBeVisible();
  return rule;
}

/** Mirrors every prompt to the candidates: x-bf-shadow: force bypasses the sample rate. */
async function sendShadowTraffic(
  request: APIRequestContext,
  prompts: string[],
  concurrency = 8,
): Promise<void> {
  for (let i = 0; i < prompts.length; i += concurrency) {
    await Promise.all(
      prompts.slice(i, i + concurrency).map(async (prompt) => {
        const res = await request.post("/v1/chat/completions", {
          data: createChatCompletionData(prompt),
          headers: { "x-bf-shadow": "force" },
        });
        expect(res.status(), await res.text()).toBe(200);
      }),
    );
  }
}

/** Waits until every queued shadow comparison has finished. */
async function waitForShadowIdle(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const { counters } = await getSummary(request);
        return (
          counters.in_flight === 0 &&
          counters.queue_depth === 0 &&
          counters.completed >= counters.enqueued
        );
      },
      { timeout: 120_000, intervals: [500, 1000] },
    )
    .toBe(true);
}

/** What the scorecard tests need from the collected data and is missing. */
async function scorecardGaps(request: APIRequestContext): Promise<string[]> {
  const summary = await getSummary(request);
  const gaps: string[] = [];
  for (const candidate of [STRONG_CANDIDATE, WEAK_CANDIDATE]) {
    const pair = findPair(summary, candidate);
    if (!pair) gaps.push(`no scorecard row for ${candidate}`);
    else if (pair.verdict === "collecting") gaps.push(`${candidate} is still collecting samples`);
  }
  const weak = findPair(summary, WEAK_CANDIDATE);
  if (weak) {
    if (!findJudgedDisagreement(await getRecords(request, weak, "fail"))) {
      gaps.push(`no judged disagreement for ${WEAK_CANDIDATE}`);
    }
    if ((await getRecords(request, weak, "error")).total === 0) {
      gaps.push(`no candidate error for ${WEAK_CANDIDATE}`);
    }
  }
  return gaps;
}

/**
 * The scorecard tests read whatever the server has collected. When that is not enough
 * (a fresh server, or the Reset test of a previous run cleared it), mirror the demo
 * prompt set until both candidates have a verdict and the weak one has disagreements
 * and errors to show. Mirroring uses x-bf-shadow: force, which the gateway honours only
 * with "allow_force_header": true in the shadow plugin config (as examples/shadow-demo sets).
 */
async function ensureScorecardData(request: APIRequestContext): Promise<void> {
  if ((await scorecardGaps(request)).length === 0) return;
  const prompts = createShadowTrafficPrompts();
  for (let round = 0; round < SEED_ROUNDS; round++) {
    await sendShadowTraffic(request, prompts);
  }
  await waitForShadowIdle(request);
  expect(await scorecardGaps(request), "shadow data after mirroring the demo prompts").toEqual([]);
}

test.describe("Shadow Traffic", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    const res = await request.get(SUMMARY_API);
    test.skip(
      res.status() === 404,
      "the shadow plugin is not enabled on this server; run against a gateway configured like examples/shadow-demo",
    );
    expect(res.status(), await res.text()).toBe(200);
    await ensureScorecardData(request);
  });

  test.beforeEach(async ({ shadowTrafficPage }) => {
    await shadowTrafficPage.closeSetupChecklistWhenShown();
  });

  test.afterEach(async ({ request }) => {
    // Clean up any routing rules created during tests
    for (const id of createdRuleIds.splice(0)) {
      const res = await request.delete(`${RULES_API}/${id}`);
      expect(res.ok(), `deleting routing rule ${id}: ${await res.text()}`).toBe(true);
    }
  });

  test.describe("Scorecard", () => {
    test("should show the counter tiles and a row with a verdict per candidate", async ({
      shadowTrafficPage,
      request,
    }) => {
      const summary = await getSummary(request);
      const pairs = summary.pairs ?? [];
      expect(pairs.map((pair) => modelLabel(pair.candidate))).toEqual(
        expect.arrayContaining([STRONG_CANDIDATE, WEAK_CANDIDATE]),
      );
      expect(summary.counters.sampled).toBeGreaterThan(0);

      await shadowTrafficPage.goto();
      await expect(shadowTrafficPage.view).toBeVisible();

      // Counter tiles show the server's counters.
      await expect(shadowTrafficPage.counterTiles).toBeVisible();
      for (const tile of [
        "sampled",
        "compared",
        "candidate-errors",
        "dropped",
        "eval-spend",
        "evaluators",
      ] as const) {
        await expect(shadowTrafficPage.tile(tile)).toBeVisible();
      }
      await shadowTrafficPage.expectTileValue(
        "sampled",
        "Sampled",
        count(summary.counters.sampled),
      );
      await shadowTrafficPage.expectTileValue(
        "compared",
        "Compared",
        count(summary.counters.completed),
      );
      await shadowTrafficPage.expectTileValue(
        "candidate-errors",
        "Candidate errors",
        count(summary.counters.candidate_errors),
      );
      await shadowTrafficPage.expectTileValue(
        "dropped",
        "Dropped",
        count(summary.counters.dropped),
      );
      if (summary.judge_model) {
        await expect(shadowTrafficPage.tile("evaluators")).toContainText(summary.judge_model);
      }

      // One scorecard row per experiment/candidate pair, each with its own test id.
      await expect(shadowTrafficPage.scorecardEmpty).toHaveCount(0);
      await expect(shadowTrafficPage.pairRows).toHaveCount(pairs.length);
      const rowIds = await shadowTrafficPage.pairRows.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-testid")),
      );
      expect(rowIds.sort()).toEqual(
        pairs
          .map(
            (pair) =>
              `shadow-pair-row-${shadowPairSlug(pair.experiment, modelLabel(pair.candidate))}`,
          )
          .sort(),
      );
      expect(new Set(rowIds).size).toBe(pairs.length);

      // Each row shows the pair and the verdict the server computed.
      for (const candidate of [STRONG_CANDIDATE, WEAK_CANDIDATE]) {
        const pair = findPair(summary, candidate)!;
        const row = shadowTrafficPage.pairRow(pair.experiment, candidate);
        await expect(row).toBeVisible();
        await expect(row).toContainText(pair.experiment);
        await expect(row).toContainText(SHADOW_SOURCE);
        await expect(row).toContainText(candidate);
        await expect(row).toContainText(pair.verdict_reason);
        await expect(shadowTrafficPage.verdictBadge(pair.experiment, candidate)).toHaveText(
          VERDICT_LABELS[pair.verdict],
        );
      }

      // The demo's strong candidate clears the thresholds and the weak one does not.
      const strong = findPair(summary, STRONG_CANDIDATE)!;
      const weak = findPair(summary, WEAK_CANDIDATE)!;
      await expect(shadowTrafficPage.verdictBadge(strong.experiment, STRONG_CANDIDATE)).toHaveText(
        VERDICT_LABELS.ready,
      );
      await expect(shadowTrafficPage.verdictBadge(weak.experiment, WEAK_CANDIDATE)).toHaveText(
        VERDICT_LABELS.not_ready,
      );
    });

    test("should pause and resume live updates", async ({ shadowTrafficPage }) => {
      await shadowTrafficPage.goto();
      // The toggle keeps one accessible name; aria-pressed carries its state.
      await expect(shadowTrafficPage.liveToggle).toHaveAccessibleName("Live updates");
      await expect(shadowTrafficPage.liveToggle).toHaveAttribute("aria-pressed", "true");
      await expect(shadowTrafficPage.liveToggle).toHaveText("Live");
      await expect(shadowTrafficPage.refreshBtn).toHaveCount(0);

      await shadowTrafficPage.liveToggle.click();
      await expect(shadowTrafficPage.liveToggle).toHaveAttribute("aria-pressed", "false");
      await expect(shadowTrafficPage.liveToggle).toHaveAccessibleName("Live updates");
      // Sighted users see a "Paused" tag next to the label.
      await expect(shadowTrafficPage.liveToggle).toContainText("Paused");

      // While paused, a manual refresh re-reads the summary.
      const refreshed = shadowTrafficPage.page.waitForResponse(
        (res) => isPath(res.url(), SUMMARY_API) && res.request().method() === "GET",
      );
      await shadowTrafficPage.refreshBtn.click();
      expect((await refreshed).status()).toBe(200);

      await shadowTrafficPage.liveToggle.click();
      await expect(shadowTrafficPage.liveToggle).toHaveAttribute("aria-pressed", "true");
      await expect(shadowTrafficPage.liveToggle).toHaveAccessibleName("Live updates");
      await expect(shadowTrafficPage.liveToggle).toHaveText("Live");
      await expect(shadowTrafficPage.refreshBtn).toHaveCount(0);
    });
  });

  test.describe("Disagreements", () => {
    /** The sheet lists exactly the first page the records API returns for the filter. */
    async function expectListedRecords(
      shadowTrafficPage: ShadowTrafficPage,
      page: ShadowRecordsPage,
      outcomeBadge: string,
    ): Promise<void> {
      const records = page.records ?? [];
      await expect(shadowTrafficPage.recordsTotal).toHaveText(
        `${count(page.total)} ${page.total === 1 ? "record" : "records"}`,
      );
      await expect(shadowTrafficPage.recordToggles).toHaveCount(records.length);
      for (const record of records) {
        await expect(shadowTrafficPage.recordToggle(record.id)).toHaveText(
          new RegExp(`^\\s*${outcomeBadge}`),
        );
      }
    }

    test("should switch the weak candidate's records between disagreements and errors", async ({
      shadowTrafficPage,
      request,
    }) => {
      const pair = findPair(await getSummary(request), WEAK_CANDIDATE)!;
      const fails = await getRecords(request, pair, "fail");
      const errors = await getRecords(request, pair, "error");
      expect(fails.total).toBeGreaterThan(0);
      expect(errors.total).toBeGreaterThan(0);

      await shadowTrafficPage.goto();
      await shadowTrafficPage.openDisagreements(pair.experiment, WEAK_CANDIDATE);
      await expect(shadowTrafficPage.disagreementsSheet).toContainText(
        `${pair.experiment}: ${SHADOW_SOURCE} → ${WEAK_CANDIDATE}`,
      );

      // The sheet opens on the disagreements.
      await expect(shadowTrafficPage.outcomeFilter).toHaveText(OUTCOME_FILTER_LABELS.fail);
      await expectListedRecords(shadowTrafficPage, fails, "Fail");

      // Switching the filter replaces them with the candidate's errors.
      await shadowTrafficPage.selectOutcome("error");
      await expect(shadowTrafficPage.outcomeFilter).toHaveText(OUTCOME_FILTER_LABELS.error);
      await expectListedRecords(shadowTrafficPage, errors, "Error");
      for (const record of fails.records ?? []) {
        await expect(shadowTrafficPage.record(record.id)).toHaveCount(0);
      }

      // An error record shows what the candidate's upstream answered.
      const failed = errors.records![0];
      await shadowTrafficPage.expandRecord(failed.id);
      await expect(shadowTrafficPage.recordCandidate(failed.id)).toContainText(WEAK_CANDIDATE);
      await expect(shadowTrafficPage.recordCandidate(failed.id)).toContainText(
        failed.candidate_error!,
      );

      // And back again.
      await shadowTrafficPage.selectOutcome("fail");
      await expect(shadowTrafficPage.outcomeFilter).toHaveText(OUTCOME_FILTER_LABELS.fail);
      await expectListedRecords(shadowTrafficPage, fails, "Fail");
    });

    test("should expand a disagreement to both answers and the judge verdict", async ({
      shadowTrafficPage,
      request,
    }) => {
      const pair = findPair(await getSummary(request), WEAK_CANDIDATE)!;
      const record = findJudgedDisagreement(await getRecords(request, pair, "fail"));
      expect(record, "a judged disagreement on the first page").toBeTruthy();
      const { id, judge } = record!;

      await shadowTrafficPage.goto();
      await shadowTrafficPage.openDisagreements(pair.experiment, WEAK_CANDIDATE);
      await expect(shadowTrafficPage.recordToggle(id)).toHaveAttribute("aria-expanded", "false");
      await expect(shadowTrafficPage.recordDetails(id)).toHaveCount(0);

      await shadowTrafficPage.expandRecord(id);

      // Both answers, each under its model.
      await expect(shadowTrafficPage.recordPrimary(id)).toContainText(modelLabel(record!.primary));
      await expect(shadowTrafficPage.recordPrimary(id)).toContainText(record!.primary_answer!.text);
      await expect(shadowTrafficPage.recordCandidate(id)).toContainText(WEAK_CANDIDATE);
      await expect(shadowTrafficPage.recordCandidate(id)).toContainText(
        record!.candidate_answer!.text,
      );

      // The judge's verdict, and which slot the candidate had in the judge prompt.
      await expect(shadowTrafficPage.recordJudge(id)).toBeVisible();
      await expect(shadowTrafficPage.recordJudge(id)).toContainText(WINNER_LABELS[judge!.winner]);
      await expect(shadowTrafficPage.recordJudgeOrder(id)).toHaveText(
        `Candidate was shown to the judge as response ${judge!.candidate_shown_first ? "A" : "B"}`,
      );

      // Collapsing hides the details again.
      await shadowTrafficPage.recordToggle(id).click();
      await expect(shadowTrafficPage.recordToggle(id)).toHaveAttribute("aria-expanded", "false");
      await expect(shadowTrafficPage.recordDetails(id)).toHaveCount(0);
    });
  });

  test.describe("Promote to canary", () => {
    test("should validate the canary share and rebuild the rule preview", async ({
      shadowTrafficPage,
      request,
    }) => {
      const pair = findPair(await getSummary(request), STRONG_CANDIDATE)!;
      expect(pair.verdict).toBe("ready");
      await expectNoCanaryRule(request, STRONG_CANDIDATE);
      const ruleName = canaryRuleName(STRONG_CANDIDATE);
      // A new canary takes the first global priority from the default up that no rule holds.
      const priority = firstFreeCanaryPriority(await getRoutingRules(request));
      const previewFor = (weight: string) =>
        shadowTrafficPage.page.waitForRequest((req) => {
          if (!isPath(req.url(), CANARY_RULE_API)) return false;
          const params = new URL(req.url()).searchParams;
          return (
            params.get("experiment") === pair.experiment &&
            params.get("candidate") === STRONG_CANDIDATE &&
            params.get("weight") === weight &&
            params.get("priority") === String(priority)
          );
        });

      await shadowTrafficPage.goto();
      const firstPreview = previewFor("0.1");
      await shadowTrafficPage.openPromote(pair.experiment, STRONG_CANDIDATE);
      await firstPreview;
      await expect(shadowTrafficPage.promoteDialog).toContainText(
        `${SHADOW_SOURCE} traffic to ${STRONG_CANDIDATE}`,
      );
      // A ready candidate gets no caution, and a pair without a canary gets a new rule.
      await expect(shadowTrafficPage.caution).toHaveCount(0);
      await expect(shadowTrafficPage.existingRuleAlert).toHaveCount(0);
      await expect(shadowTrafficPage.rulesError).toHaveCount(0);

      // Opens on the default 10% share. The rule is named after the pair, not the share.
      await expect(shadowTrafficPage.weightInput).toHaveValue("10");
      await expect(shadowTrafficPage.previewName).toHaveText(ruleName);
      await expect(shadowTrafficPage.preview).toContainText(
        canaryShareSentence(10, STRONG_CANDIDATE),
      );
      await expectPreviewShare(shadowTrafficPage, SHADOW_SOURCE, 90);
      await expectPreviewShare(shadowTrafficPage, STRONG_CANDIDATE, 10);
      await expect(shadowTrafficPage.previewPriority).toHaveText(`Priority ${priority}`);
      await expect(shadowTrafficPage.promoteConfirmBtn).toHaveText("Create canary rule");
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeEnabled();

      // 0% is rejected inline and blocks the submit.
      await shadowTrafficPage.setWeight("0");
      await expect(shadowTrafficPage.weightError).toBeVisible();
      await expect(shadowTrafficPage.weightError).not.toBeEmpty();
      await expect(shadowTrafficPage.weightInput).toHaveAttribute("aria-invalid", "true");
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeDisabled();

      // So is anything above 100%.
      await shadowTrafficPage.setWeight("101");
      await expect(shadowTrafficPage.weightError).toBeVisible();
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeDisabled();

      // A valid share clears the error and rebuilds the preview for that share.
      const previewRequest = previewFor("0.25");
      await shadowTrafficPage.setWeight("25");
      await expect(shadowTrafficPage.weightError).toHaveCount(0);
      await expect(shadowTrafficPage.weightInput).not.toHaveAttribute("aria-invalid", "true");
      await previewRequest;
      await expect(shadowTrafficPage.preview).toContainText(
        canaryShareSentence(25, STRONG_CANDIDATE),
      );
      await expect(shadowTrafficPage.previewName).toHaveText(ruleName);
      await expectPreviewShare(shadowTrafficPage, SHADOW_SOURCE, 75);
      await expectPreviewShare(shadowTrafficPage, STRONG_CANDIDATE, 25);
      await expect(shadowTrafficPage.previewPriority).toHaveText(`Priority ${priority}`);
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeEnabled();

      // Cancelling creates nothing.
      await shadowTrafficPage.cancelPromote();
      expect(await getCanaryRules(request, STRONG_CANDIDATE)).toEqual([]);
    });

    test("should caution before promoting a candidate that is not ready", async ({
      shadowTrafficPage,
      request,
    }) => {
      const pair = findPair(await getSummary(request), WEAK_CANDIDATE)!;
      expect(pair.verdict).not.toBe("ready");

      await shadowTrafficPage.goto();
      await shadowTrafficPage.openPromote(pair.experiment, WEAK_CANDIDATE);
      await expect(shadowTrafficPage.caution).toBeVisible();
      await expect(shadowTrafficPage.caution).toContainText(
        `This candidate's verdict is ${VERDICT_LABELS[pair.verdict]}`,
      );
      await expect(shadowTrafficPage.caution).toContainText(pair.verdict_reason);
      await expect(shadowTrafficPage.previewName).toHaveText(canaryRuleName(WEAK_CANDIDATE));
      await expect(shadowTrafficPage.preview).toContainText(
        canaryShareSentence(10, WEAK_CANDIDATE),
      );
      // The caution warns but does not block.
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeEnabled();
      await shadowTrafficPage.cancelPromote();
    });

    test("should create a canary routing rule that shows up on the Routing Rules page", async ({
      shadowTrafficPage,
      routingRulesPage,
      request,
    }) => {
      const { page } = shadowTrafficPage;
      const pair = findPair(await getSummary(request), STRONG_CANDIDATE)!;
      await expectNoCanaryRule(request, STRONG_CANDIDATE);
      const ruleName = canaryRuleName(STRONG_CANDIDATE);
      const priority = firstFreeCanaryPriority(await getRoutingRules(request));

      await shadowTrafficPage.goto();
      await shadowTrafficPage.openPromote(pair.experiment, STRONG_CANDIDATE);
      await shadowTrafficPage.setWeight("15");
      await expect(shadowTrafficPage.preview).toContainText(
        canaryShareSentence(15, STRONG_CANDIDATE),
      );
      await expect(shadowTrafficPage.previewName).toHaveText(ruleName);
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeEnabled();

      const { id: ruleId } = await confirmCreate(shadowTrafficPage);
      const toast = shadowTrafficPage.getToast("success");
      await expect(toast).toContainText(`Created routing rule "${ruleName}"`);

      // The toast links to the routing rules, where the canary is listed.
      await toast.getByRole("button", { name: "View rules" }).click();
      await expect(page).toHaveURL((url) => url.pathname === "/workspace/routing-rules");
      await routingRulesPage.waitForRuleToAppear(ruleName);

      // The stored rule is the previewed one: 85% stays on the source, 15% goes to the candidate.
      const rule = await getRoutingRule(request, ruleId);
      expect(rule).toMatchObject({
        name: ruleName,
        enabled: true,
        scope: "global",
        priority,
        cel_expression: 'provider == "openai" && model == "gpt-4o"',
      });
      expect(rule.description).toContain(canaryShareSentence(15, STRONG_CANDIDATE));
      expect(targetWeights(rule)).toEqual(
        expect.arrayContaining([
          { provider: "openai", model: "gpt-4o", weight: 0.85 },
          { provider: "openai", model: "gpt-4o-mini", weight: 0.15 },
        ]),
      );
      expect(rule.targets).toHaveLength(2);
    });

    test("should ramp the pair's existing canary instead of creating a second rule", async ({
      shadowTrafficPage,
      request,
    }) => {
      const { page } = shadowTrafficPage;
      const pair = findPair(await getSummary(request), STRONG_CANDIDATE)!;
      await expectNoCanaryRule(request, STRONG_CANDIDATE);
      const ruleName = canaryRuleName(STRONG_CANDIDATE);

      // First promotion: a new rule at the default 10%.
      await shadowTrafficPage.goto();
      await shadowTrafficPage.openPromote(pair.experiment, STRONG_CANDIDATE);
      await expect(shadowTrafficPage.existingRuleAlert).toHaveCount(0);
      await expect(shadowTrafficPage.weightInput).toHaveValue("10");
      await expect(shadowTrafficPage.preview).toContainText(
        canaryShareSentence(10, STRONG_CANDIDATE),
      );
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeEnabled();
      const created = await confirmCreate(shadowTrafficPage);
      await shadowTrafficPage.waitForSuccessToast(`Created routing rule "${ruleName}"`);
      const original = await getRoutingRule(request, created.id);
      expect(original.name).toBe(ruleName);

      // Promoting the same pair again finds that rule and offers to change its share.
      await shadowTrafficPage.openPromote(pair.experiment, STRONG_CANDIDATE);
      await expect(shadowTrafficPage.existingRuleAlert).toBeVisible();
      await expect(shadowTrafficPage.existingRuleAlert).toContainText(
        `"${ruleName}" currently sends 10% of this traffic to the candidate.`,
      );
      await expect(shadowTrafficPage.promoteDialog).toContainText("Update canary share");
      await expect(shadowTrafficPage.promoteConfirmBtn).toHaveText("Update canary rule");
      // The preview is the existing rule with the new split: same name, same priority.
      await expect(shadowTrafficPage.previewName).toHaveText(ruleName);
      await expect(shadowTrafficPage.previewPriority).toHaveText(`Priority ${original.priority}`);

      await shadowTrafficPage.setWeight("25");
      await expect(shadowTrafficPage.preview).toContainText(
        canaryShareSentence(25, STRONG_CANDIDATE),
      );
      await expectPreviewShare(shadowTrafficPage, SHADOW_SOURCE, 75);
      await expectPreviewShare(shadowTrafficPage, STRONG_CANDIDATE, 25);
      await expect(shadowTrafficPage.previewPriority).toHaveText(`Priority ${original.priority}`);
      await expect(shadowTrafficPage.promoteConfirmBtn).toHaveText("Update canary rule");
      await expect(shadowTrafficPage.promoteConfirmBtn).toBeEnabled();

      // Confirming updates the rule in place; no second rule is posted.
      const posted: string[] = [];
      const onRequest = (req: { url(): string; method(): string }) => {
        if (isPath(req.url(), RULES_API) && req.method() === "POST") posted.push(req.url());
      };
      page.on("request", onRequest);
      const updatedResponse = page.waitForResponse(
        (res) =>
          isPath(res.url(), `${RULES_API}/${created.id}`) && res.request().method() === "PUT",
      );
      await shadowTrafficPage.promoteConfirmBtn.click();
      const updated = await updatedResponse;
      expect(updated.ok(), await updated.text()).toBe(true);
      await expect(shadowTrafficPage.promoteDialog).not.toBeVisible();
      await shadowTrafficPage.waitForSuccessToast(`Updated routing rule "${ruleName}"`);
      page.off("request", onRequest);
      expect(posted).toEqual([]);

      // Still exactly one rule for the pair: the same one, now sending 25% to the candidate,
      // with its priority, scope, condition and state kept.
      const rules = await getCanaryRules(request, STRONG_CANDIDATE);
      expect(rules).toHaveLength(1);
      const [ramped] = rules;
      expect(ramped.id).toBe(created.id);
      expect(ramped).toMatchObject({
        name: ruleName,
        priority: original.priority,
        scope: original.scope,
        enabled: original.enabled,
        cel_expression: original.cel_expression,
      });
      expect(ramped.description).toContain(canaryShareSentence(25, STRONG_CANDIDATE));
      expect(targetWeights(ramped)).toEqual(
        expect.arrayContaining([
          { provider: "openai", model: "gpt-4o", weight: 0.75 },
          { provider: "openai", model: "gpt-4o-mini", weight: 0.25 },
        ]),
      );
      expect(ramped.targets).toHaveLength(2);
    });

    test("should give a second pair's canary the next free priority", async ({
      shadowTrafficPage,
      request,
    }) => {
      const summary = await getSummary(request);
      const strong = findPair(summary, STRONG_CANDIDATE)!;
      const weak = findPair(summary, WEAK_CANDIDATE)!;
      await expectNoCanaryRule(request, STRONG_CANDIDATE);
      await expectNoCanaryRule(request, WEAK_CANDIDATE);
      const firstPriority = firstFreeCanaryPriority(await getRoutingRules(request));

      await shadowTrafficPage.goto();
      await shadowTrafficPage.openPromote(strong.experiment, STRONG_CANDIDATE);
      await expect(shadowTrafficPage.previewPriority).toHaveText(`Priority ${firstPriority}`);
      const first = await confirmCreate(shadowTrafficPage);
      await shadowTrafficPage.waitForSuccessToast(
        `Created routing rule "${canaryRuleName(STRONG_CANDIDATE)}"`,
      );

      // The first canary now holds that priority, so the second pair's rule takes the next free one
      // rather than colliding with it.
      const secondPriority = firstFreeCanaryPriority(await getRoutingRules(request));
      expect(secondPriority).not.toBe(firstPriority);
      await shadowTrafficPage.openPromote(weak.experiment, WEAK_CANDIDATE);
      await expect(shadowTrafficPage.existingRuleAlert).toHaveCount(0);
      await expect(shadowTrafficPage.previewName).toHaveText(canaryRuleName(WEAK_CANDIDATE));
      await expect(shadowTrafficPage.previewPriority).toHaveText(`Priority ${secondPriority}`);
      const second = await confirmCreate(shadowTrafficPage);
      await expect(shadowTrafficPage.promoteError).toHaveCount(0);
      await shadowTrafficPage.waitForSuccessToast(
        `Created routing rule "${canaryRuleName(WEAK_CANDIDATE)}"`,
      );

      expect((await getRoutingRule(request, first.id)).priority).toBe(firstPriority);
      expect((await getRoutingRule(request, second.id)).priority).toBe(secondPriority);
    });
  });

  // Destroys every collected comparison, so it is declared last. ensureScorecardData
  // collects new traffic before the next run of the tests above.
  test.describe("Reset", () => {
    test("should clear the counters and show the empty scorecard", async ({
      shadowTrafficPage,
      request,
    }) => {
      const before = await getSummary(request);
      const pairCount = (before.pairs ?? []).length;
      expect(before.counters.sampled).toBeGreaterThan(0);
      expect(pairCount).toBeGreaterThan(0);

      await shadowTrafficPage.goto();
      await expect(shadowTrafficPage.pairRows).toHaveCount(pairCount);

      // Cancelling keeps everything.
      await shadowTrafficPage.openResetDialog();
      await expect(shadowTrafficPage.resetDialog).toContainText("Reset shadow results?");
      await shadowTrafficPage.resetCancelBtn.click();
      await expect(shadowTrafficPage.resetDialog).not.toBeVisible();
      await expect(shadowTrafficPage.pairRows).toHaveCount(pairCount);
      expect((await getSummary(request)).counters.sampled).toBe(before.counters.sampled);

      // Confirming clears the counters and the scorecard.
      await shadowTrafficPage.openResetDialog();
      const resetResponse = shadowTrafficPage.page.waitForResponse(
        (res) => isPath(res.url(), RECORDS_API) && res.request().method() === "DELETE",
      );
      await shadowTrafficPage.resetConfirmBtn.click();
      expect((await resetResponse).ok()).toBe(true);
      await shadowTrafficPage.waitForSuccessToast("Shadow results cleared");
      await expect(shadowTrafficPage.resetDialog).not.toBeVisible();

      await expect(shadowTrafficPage.scorecardEmpty).toBeVisible();
      await expect(shadowTrafficPage.pairRows).toHaveCount(0);
      await shadowTrafficPage.expectTileValue("sampled", "Sampled", "0");
      await shadowTrafficPage.expectTileValue("compared", "Compared", "0");
      await shadowTrafficPage.expectTileValue("candidate-errors", "Candidate errors", "0");
      await shadowTrafficPage.expectTileValue("dropped", "Dropped", "0");

      const after = await getSummary(request);
      expect(after.counters).toMatchObject({
        eligible: 0,
        sampled: 0,
        completed: 0,
        candidate_errors: 0,
        dropped: 0,
      });
      expect(after.pairs ?? []).toEqual([]);

      // The experiments keep running, and the empty state names them.
      for (const experiment of after.experiments ?? []) {
        await expect(shadowTrafficPage.scorecardEmpty).toContainText(
          `${experiment.name ?? modelLabel(experiment.source)}: ${modelLabel(experiment.source)} → ${experiment.candidates
            .map(modelLabel)
            .join(", ")}`,
        );
      }
    });
  });
});

test.describe("Shadow Traffic without the plugin", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get(SUMMARY_API);
    test.skip(res.status() !== 404, "the shadow plugin is enabled on this server");
  });

  test("should explain how to enable the plugin", async ({ shadowTrafficPage }) => {
    const { page } = shadowTrafficPage;
    await shadowTrafficPage.closeSetupChecklistWhenShown();
    await shadowTrafficPage.goto();

    await expect(shadowTrafficPage.notEnabled).toBeVisible();
    await expect(shadowTrafficPage.notEnabled).toContainText("Shadow traffic is not enabled");
    await expect(shadowTrafficPage.view).toHaveCount(0);

    // The snippet is a plugins entry that can be pasted into config.json as is.
    const snippet = JSON.parse((await shadowTrafficPage.configSnippet.textContent()) ?? "");
    expect(snippet.plugins[0]).toMatchObject({ enabled: true, name: "shadow" });

    // Check again re-reads the summary, and the page stays put while it is still 404.
    const retried = page.waitForResponse((res) => isPath(res.url(), SUMMARY_API));
    await shadowTrafficPage.notEnabledRetryBtn.click();
    expect((await retried).status()).toBe(404);
    await expect(shadowTrafficPage.notEnabled).toBeVisible();

    // The plugins page adds its own query state, so only the path is the link's.
    await shadowTrafficPage.notEnabledPluginsLink.click();
    await expect(page).toHaveURL((url) => url.pathname === "/workspace/plugins");
  });
});