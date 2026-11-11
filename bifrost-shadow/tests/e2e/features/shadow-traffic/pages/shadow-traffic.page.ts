import { Locator, Page, expect } from "@playwright/test";
import { BasePage } from "../../../core/pages/base.page";

/** Outcome filter values offered by the disagreements sheet. */
export type ShadowOutcomeFilter = "fail" | "error" | "pass" | "all";

/** Counter tiles on the page, keyed by the suffix of their data-testid. */
export type ShadowTile =
  | "sampled"
  | "compared"
  | "candidate-errors"
  | "dropped"
  | "eval-spend"
  | "evaluators";

/**
 * Lowercase, dash-separated form of a value: "openai/llama-3.1-8b" -> "openai-llama-3-1-8b".
 * Mirrors shadowTestIdSlug in ui/lib/utils/shadow.ts.
 */
function shadowSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The suffix the scorecard builds a pair's test ids from. Two experiments can shadow the same
 * candidate, so it names both: ("gpt-4o cost-down", "openai/gpt-4o-mini") ->
 * "gpt-4o-cost-down--openai-gpt-4o-mini". Mirrors shadowPairTestIdSlug in ui/lib/utils/shadow.ts.
 */
export function shadowPairSlug(experiment: string, candidate: string): string {
  return `${shadowSlug(experiment)}--${shadowSlug(candidate)}`;
}

/**
 * Page object for the Shadow Traffic page (/workspace/shadow)
 */
export class ShadowTrafficPage extends BasePage {
  // Page states
  readonly view: Locator;
  readonly notEnabled: Locator;
  readonly configSnippet: Locator;
  readonly notEnabledRetryBtn: Locator;
  readonly notEnabledPluginsLink: Locator;

  // Header
  readonly liveToggle: Locator;
  readonly refreshBtn: Locator;
  readonly resetBtn: Locator;
  readonly resetDialog: Locator;
  readonly resetConfirmBtn: Locator;
  readonly resetCancelBtn: Locator;

  // Counters and scorecard
  readonly counterTiles: Locator;
  readonly scorecard: Locator;
  readonly scorecardEmpty: Locator;
  readonly pairRows: Locator;

  // Disagreements sheet
  readonly disagreementsSheet: Locator;
  readonly outcomeFilter: Locator;
  readonly recordsTotal: Locator;
  readonly recordsEmpty: Locator;
  readonly recordToggles: Locator;

  // Promote dialog
  readonly promoteDialog: Locator;
  readonly weightInput: Locator;
  readonly weightError: Locator;
  readonly caution: Locator;
  readonly existingRuleAlert: Locator;
  readonly rulesError: Locator;
  readonly preview: Locator;
  readonly previewName: Locator;
  readonly previewPriority: Locator;
  readonly previewError: Locator;
  readonly promoteError: Locator;
  readonly promoteConfirmBtn: Locator;
  readonly promoteCancelBtn: Locator;

  constructor(page: Page) {
    super(page);

    this.view = page.getByTestId("shadow-traffic-view");
    this.notEnabled = page.getByTestId("shadow-not-enabled");
    this.configSnippet = page.getByTestId("shadow-config-snippet");
    this.notEnabledRetryBtn = page.getByTestId("shadow-not-enabled-retry-button");
    this.notEnabledPluginsLink = page.getByTestId("shadow-not-enabled-plugins-link");

    this.liveToggle = page.getByTestId("shadow-live-toggle");
    this.refreshBtn = page.getByTestId("shadow-refresh-button");
    this.resetBtn = page.getByTestId("shadow-reset-button");
    this.resetConfirmBtn = page.getByTestId("shadow-reset-confirm-button");
    this.resetCancelBtn = page.getByTestId("shadow-reset-cancel-button");
    // The confirmation is the only alert dialog the page renders.
    this.resetDialog = page.getByRole("alertdialog").filter({ has: this.resetConfirmBtn });

    this.counterTiles = page.getByTestId("shadow-counter-tiles");
    this.scorecard = page.getByTestId("shadow-scorecard");
    this.scorecardEmpty = page.getByTestId("shadow-scorecard-empty");
    this.pairRows = this.scorecard.locator('[data-testid^="shadow-pair-row-"]');

    this.disagreementsSheet = page.getByTestId("shadow-disagreements-sheet");
    this.outcomeFilter = page.getByTestId("shadow-outcome-filter");
    this.recordsTotal = page.getByTestId("shadow-records-total");
    this.recordsEmpty = page.getByTestId("shadow-records-empty");
    this.recordToggles = this.disagreementsSheet.locator('[data-testid^="shadow-record-toggle-"]');

    this.promoteDialog = page.getByTestId("shadow-promote-dialog");
    this.weightInput = page.getByTestId("shadow-promote-weight-input");
    this.weightError = page.getByTestId("shadow-promote-weight-error");
    this.caution = page.getByTestId("shadow-promote-caution");
    this.existingRuleAlert = page.getByTestId("shadow-promote-existing");
    this.rulesError = page.getByTestId("shadow-promote-rules-error");
    this.preview = page.getByTestId("shadow-promote-preview");
    this.previewName = page.getByTestId("shadow-promote-preview-name");
    this.previewPriority = page.getByTestId("shadow-promote-preview-priority");
    this.previewError = page.getByTestId("shadow-promote-preview-error");
    this.promoteError = page.getByTestId("shadow-promote-error");
    this.promoteConfirmBtn = page.getByTestId("shadow-promote-confirm-button");
    this.promoteCancelBtn = page.getByTestId("shadow-promote-cancel-button");
  }

  /**
   * Navigate to the shadow traffic page and wait for the summary to settle
   * (scorecard view, or the not-enabled view when the plugin is not loaded).
   */
  async goto(): Promise<void> {
    await this.page.goto("/workspace/shadow");
    await this.view.or(this.notEnabled).first().waitFor({ state: "visible", timeout: 15000 });
  }

  /**
   * The onboarding "Setup checklist" card can float over the page. auth.setup.ts dismisses
   * it for the server, so this only fires when that did not happen.
   */
  async closeSetupChecklistWhenShown(): Promise<void> {
    const close = this.page.getByTestId("onboarding-widget-close");
    await this.page.addLocatorHandler(close, async () => {
      await close.click();
    });
  }

  tile(name: ShadowTile): Locator {
    return this.page.getByTestId(`shadow-tile-${name}`);
  }

  /**
   * Assert the figure a counter tile shows. Each tile renders its title, its value and a
   * footer as separate blocks, so the rendered text reads "<title> <value> <footer>".
   */
  async expectTileValue(name: ShadowTile, title: string, value: string): Promise<void> {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(this.tile(name)).toHaveText(
      new RegExp(`^\\s*${escape(title)}\\s+${escape(value)}\\s`, "i"),
      {
        useInnerText: true,
      },
    );
  }

  pairRow(experiment: string, candidate: string): Locator {
    return this.page.getByTestId(`shadow-pair-row-${shadowPairSlug(experiment, candidate)}`);
  }

  verdictBadge(experiment: string, candidate: string): Locator {
    return this.page.getByTestId(`shadow-verdict-${shadowPairSlug(experiment, candidate)}`);
  }

  disagreementsButton(experiment: string, candidate: string): Locator {
    return this.page.getByTestId(
      `shadow-disagreements-button-${shadowPairSlug(experiment, candidate)}`,
    );
  }

  promoteButton(experiment: string, candidate: string): Locator {
    return this.page.getByTestId(`shadow-promote-button-${shadowPairSlug(experiment, candidate)}`);
  }

  /**
   * Open the disagreements sheet for one experiment/candidate pair and wait for its first page of records.
   */
  async openDisagreements(experiment: string, candidate: string): Promise<void> {
    await this.disagreementsButton(experiment, candidate).click();
    await expect(this.disagreementsSheet).toBeVisible();
    await this.waitForSheetAnimation();
  }

  /**
   * Pick an outcome in the disagreements sheet's filter.
   */
  async selectOutcome(outcome: ShadowOutcomeFilter): Promise<void> {
    await this.outcomeFilter.click();
    await this.page.getByTestId(`shadow-outcome-option-${outcome}`).click();
  }

  async closeDisagreements(): Promise<void> {
    if (await this.disagreementsSheet.isVisible()) {
      await this.page.keyboard.press("Escape");
      await expect(this.disagreementsSheet).not.toBeVisible();
    }
  }

  record(id: string): Locator {
    return this.page.getByTestId(`shadow-record-${id}`);
  }

  recordToggle(id: string): Locator {
    return this.page.getByTestId(`shadow-record-toggle-${id}`);
  }

  recordDetails(id: string): Locator {
    return this.page.getByTestId(`shadow-record-details-${id}`);
  }

  recordPrimary(id: string): Locator {
    return this.page.getByTestId(`shadow-record-primary-${id}`);
  }

  recordCandidate(id: string): Locator {
    return this.page.getByTestId(`shadow-record-candidate-${id}`);
  }

  recordJudge(id: string): Locator {
    return this.page.getByTestId(`shadow-record-judge-${id}`);
  }

  recordJudgeOrder(id: string): Locator {
    return this.page.getByTestId(`shadow-record-judge-order-${id}`);
  }

  /**
   * Expand one record of the disagreements sheet.
   */
  async expandRecord(id: string): Promise<void> {
    const toggle = this.recordToggle(id);
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(this.recordDetails(id)).toBeVisible();
  }

  /**
   * Open the promote dialog for one experiment/candidate pair and wait for the first rule preview.
   * The preview waits for the routing rules list, so the dialog already knows by then whether it
   * creates a canary or updates the pair's existing one.
   */
  async openPromote(experiment: string, candidate: string): Promise<void> {
    await this.dismissToasts();
    await this.promoteButton(experiment, candidate).click();
    await expect(this.promoteDialog).toBeVisible();
    await expect(this.previewName).toBeVisible();
  }

  async setWeight(percent: string): Promise<void> {
    await this.weightInput.fill(percent);
  }

  async cancelPromote(): Promise<void> {
    if (await this.promoteDialog.isVisible()) {
      await this.promoteCancelBtn.click();
      await expect(this.promoteDialog).not.toBeVisible();
    }
  }

  async openResetDialog(): Promise<void> {
    await this.resetBtn.click();
    await expect(this.resetDialog).toBeVisible();
  }
}