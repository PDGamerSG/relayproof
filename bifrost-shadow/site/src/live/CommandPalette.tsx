import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { LINKS } from "../data/site";
import { ago, errorText, modelId, pct, saveBlob, useConnection } from "./backend";
import { candidateKey, type RecordsState } from "./records";
import type { ShadowRecord, Summary, Verdict } from "./shadowClient";
import "./palette.css";

export interface PaletteTab {
  id: string;
  label: string;
}

type Group = "Go to" | "Candidates" | "Comparisons" | "Actions";
type Range = [number, number];

interface Item {
  id: string;
  group: Group;
  label: string;
  detail?: string;
  /** Matched, never shown. */
  keywords?: string;
  /** Record and request ids: matched only by six or more characters, as when one is pasted. */
  ids?: string;
  /** Long text (a prompt): matched by whole words only, and shown around the first match. */
  long?: boolean;
  meta?: ReactNode;
  /** Added to the score: the more likely of two similar items. */
  boost?: number;
  run: () => void | Promise<void>;
}

interface Hit {
  item: Item;
  score: number;
  label: Range[];
  detail: Range[];
}

/** What each tab is for, so "latency" finds Performance. Unknown tabs still match by name. */
const TAB_HINTS: Record<string, { detail: string; keywords: string }> = {
  overview: { detail: "Scorecards, counters and drift", keywords: "home scorecards verdicts sign in connect gateway" },
  ask: { detail: "Ask the gateway your own question", keywords: "question prompt try" },
  comparisons: { detail: "Every pair of answers, side by side", keywords: "records explorer diff disagreements pairs" },
  performance: { detail: "Latency and cost by model", keywords: "latency speed cost p50 p95" },
  judge: { detail: "How far to trust the judge", keywords: "bias kappa label judge check" },
  policy: { detail: "Try stricter or looser thresholds", keywords: "thresholds policy lab what if" },
  report: { detail: "Readiness report for one candidate", keywords: "report markdown print evidence" },
  rollout: { detail: "Canary, incidents and history", keywords: "canary promote rollback incident history guard" },
  setup: { detail: "A config for your own gateway", keywords: "config json install setup gateway" },
};

const VERDICT_LABEL: Record<Verdict, string> = {
  collecting: "Collecting",
  promising: "Promising",
  ready: "Ready",
  not_ready: "Not ready",
};

type Outcome = "pass" | "fail" | "error" | "unscored";
const OUTCOME_LABEL: Record<Outcome, string> = { pass: "Pass", fail: "Fail", error: "Error", unscored: "Unscored" };
const outcomeOf = (r: ShadowRecord): Outcome => (r.candidate_error ? "error" : r.pass ? "pass" : r.pass_basis === "unscored" ? "unscored" : "fail");

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** True when a key press belongs to a text field rather than to the page. */
function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/* Matching */

const BOUNDARY = /[\s/_\-.:(),"'?]/;

/**
 * One query word against one text: a substring first; then, for short text, its
 * letters in order, each one either right after the previous or at the start of
 * a word ("dcc" finds "Download comparisons as CSV").
 */
function findWord(word: string, lower: string, fuzzy: boolean): { score: number; ranges: Range[] } | undefined {
  const at = lower.indexOf(word);
  if (at >= 0) {
    const start = at === 0 || BOUNDARY.test(lower[at - 1]);
    return { score: 100 + word.length * 4 + (start ? 40 : 0) + (at === 0 ? 20 : 0) - Math.min(at, 60) * 0.3, ranges: [[at, at + word.length]] };
  }
  if (!fuzzy || word.length < 2) return undefined;
  const ranges: Range[] = [];
  let score = 0;
  let next = 0;
  for (const ch of word) {
    const last = ranges[ranges.length - 1];
    if (last && lower[last[1]] === ch) {
      last[1] += 1;
      next = last[1];
      score += 8;
      continue;
    }
    let j = -1;
    for (let k = next; k < lower.length; k++) {
      if (lower[k] === ch && (k === 0 || BOUNDARY.test(lower[k - 1]))) {
        j = k;
        break;
      }
    }
    if (j < 0) return undefined;
    ranges.push([j, j + 1]);
    next = j + 1;
    score += 10;
  }
  return { score, ranges };
}

/** A word found only in the second line counts for less than one in the name. */
const DETAIL_WEIGHT = 0.45;
/** Within a group, results scoring under this share of the best are noise. */
const CUTOFF = 0.5;

function match(words: string[], item: Item): Hit | undefined {
  if (words.length === 0) return { item, score: 0, label: [], detail: [] };
  const label = item.label.toLowerCase();
  const detail = (item.detail ?? "").toLowerCase();
  const keywords = (item.keywords ?? "").toLowerCase();
  const hit: Hit = { item, score: 0, label: [], detail: [] };
  for (const word of words) {
    const inLabel = findWord(word, label, !item.long);
    const inDetail = findWord(word, detail, false);
    const inKeywords = keywords.includes(word) ? 50 + word.length * 2 : 0;
    const inIds = word.length >= 6 && item.ids?.includes(word) ? 120 : 0;
    const best = Math.max(inLabel?.score ?? 0, (inDetail?.score ?? 0) * DETAIL_WEIGHT, inKeywords, inIds);
    if (best <= 0) return undefined;
    hit.score += best;
    if (inLabel && inLabel.score === best) hit.label.push(...inLabel.ranges);
    else if (inDetail && inDetail.score * DETAIL_WEIGHT === best) hit.detail.push(...inDetail.ranges);
  }
  // Among equals, the shorter name is the closer match.
  hit.score += (item.boost ?? 0) - Math.min(label.length, 200) * 0.05;
  return hit;
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Text with the matched letters marked; long text starts a little before its first match. */
function Marked({ text, ranges, long }: { text: string; ranges: Range[]; long?: boolean }) {
  const merged = merge(ranges);
  let from = 0;
  if (long && merged[0] && merged[0][0] > 48) {
    const cut = text.lastIndexOf(" ", merged[0][0] - 24);
    from = cut > 0 ? cut + 1 : merged[0][0] - 24;
  }
  const parts: ReactNode[] = from > 0 ? ["…"] : [];
  let at = from;
  for (const [s, e] of merged) {
    if (e <= at) continue;
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark key={s}>{text.slice(Math.max(s, at), e)}</mark>);
    at = e;
  }
  parts.push(text.slice(at, at + 400));
  return <>{parts}</>;
}

/** Prompts on one line, so a match is easy to show. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const LIMIT: Record<Group, number> = { "Go to": 12, Candidates: 8, Comparisons: 8, Actions: 10 };
const RECENT = 3;

/**
 * The console's command palette: Cmd+K or Ctrl+K anywhere, or "/" outside a
 * text field. It finds tabs, candidates, comparisons by prompt text, and the
 * console's actions. A native modal dialog keeps focus inside it; Escape closes
 * it and focus goes back where it was.
 */
export function CommandPalette({ tabs, data, summary }: { tabs: PaletteTab[]; data: RecordsState; summary?: Summary }) {
  const conn = useConnection();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** Where focus goes when the palette closes: back to where it was, or to the newly opened tab. */
  const returnTo = useRef<"opener" | "main">("opener");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<{ tone: "busy" | "ok" | "error"; text: string }>();
  const uid = useId();
  const mac = useMemo(isMac, []);
  const shortcut = mac ? "⌘K" : "Ctrl K";

  /** Mirrors `open` for event handlers, so closing runs its clean-up once. */
  const isOpen = useRef(false);

  const show = useCallback(() => {
    if (isOpen.current) return;
    isOpen.current = true;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnTo.current = "opener";
    setQuery("");
    setActive(0);
    setStatus(undefined);
    setOpen(true);
  }, []);

  /** Runs however the dialog closed: Escape, the backdrop, an action, or Cmd+K again. */
  const finish = useCallback(() => {
    if (!isOpen.current) return;
    isOpen.current = false;
    setOpen(false);
    setStatus(undefined);
    const target = returnTo.current === "main" ? document.getElementById("console") : opener.current;
    requestAnimationFrame(() => {
      if (target && target.isConnected) target.focus({ preventScroll: true });
      else document.getElementById("console")?.focus({ preventScroll: true });
    });
  }, []);

  const hide = useCallback(
    (to: "opener" | "main" = "opener") => {
      returnTo.current = to;
      if (dialog.current?.open) dialog.current.close();
      finish();
    },
    [finish],
  );

  // Some browsers report a closed dialog only through "toggle"; listen to both.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === "closed") finish();
    };
    d.addEventListener("toggle", onToggle);
    return () => d.removeEventListener("toggle", onToggle);
  }, [finish]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      input.current?.focus();
    }
    // Never leave an empty dialog (a backdrop with nothing on it) open.
    if (!open && d.open) d.close();
  }, [open]);

  // Cmd/Ctrl+K toggles; "/" opens when no field has focus. Neither fires over another dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const ours = isOpen.current;
      const other = !ours && document.querySelector("dialog[open]") !== null;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (other) return;
        e.preventDefault();
        if (ours) hide();
        else show();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !ours && !other && !inField(e.target)) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, hide]);

  const go = useCallback(
    (hash: string) => {
      hide("main");
      if (window.location.hash !== `#${hash}`) window.location.hash = hash;
    },
    [hide],
  );

  /** A long action: says what it is doing, closes when done, stays open with the reason when it fails. */
  const act = useCallback(
    async (busy: string, work: () => Promise<void>, done?: string) => {
      setStatus({ tone: "busy", text: busy });
      try {
        await work();
        if (done) {
          setStatus({ tone: "ok", text: done });
          await new Promise((r) => setTimeout(r, 700));
        }
        hide();
      } catch (err) {
        setStatus({ tone: "error", text: errorText(err) });
        input.current?.focus();
      }
    },
    [hide],
  );

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const out: Item[] = [];
    const current = window.location.hash.slice(1).split("/")[0] || "overview";

    for (const t of tabs) {
      const hint = TAB_HINTS[t.id];
      out.push({
        id: `tab-${t.id}`,
        group: "Go to",
        label: t.label,
        detail: hint?.detail,
        keywords: `${t.id} tab ${hint?.keywords ?? ""}`,
        meta: t.id === current ? <span className="cp-tag">Open now</span> : undefined,
        run: () => go(t.id),
      });
    }

    for (const p of summary?.pairs ?? []) {
      const key = candidateKey(p);
      const name = modelId(p.candidate);
      const words = `${name} ${modelId(p.source)} ${p.experiment} ${VERDICT_LABEL[p.verdict]} candidate`;
      out.push({
        id: `report-${key}`,
        group: "Candidates",
        label: `${p.candidate.model} readiness report`,
        detail: `${p.experiment}, ${pct(p.agreement_rate)} agreement`,
        keywords: words,
        boost: 6,
        meta: (
          <span className="verdict" data-verdict={p.verdict}>
            {VERDICT_LABEL[p.verdict]}
          </span>
        ),
        run: () => go(`report/${encodeURIComponent(key)}`),
      });
      out.push({
        id: `card-${key}`,
        group: "Candidates",
        label: `${p.candidate.model} scorecard`,
        detail: `On the overview, against ${p.source.model}`,
        keywords: `${words} overview`,
        meta: <span className="cp-tag num">{pct(p.agreement_lower_bound)} lower bound</span>,
        run: () => go("overview"),
      });
    }

    const records = [...data.records].reverse();
    for (const r of records) {
      const outcome = outcomeOf(r);
      out.push({
        id: `rec-${r.id}`,
        group: "Comparisons",
        label: r.prompt ? oneLine(r.prompt) : `Comparison ${r.id.slice(0, 8)}`,
        detail: `${modelId(r.candidate)}, ${ago(r.created_at, Date.now())}`,
        keywords: OUTCOME_LABEL[outcome],
        ids: `${r.id} ${r.request_id}`.toLowerCase(),
        long: Boolean(r.prompt),
        meta: (
          <span className="cp-outcome" data-outcome={outcome}>
            {OUTCOME_LABEL[outcome]}
          </span>
        ),
        run: () => go(`comparisons/${r.id}`),
      });
    }

    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    out.push(
      {
        id: "dl-scorecards",
        group: "Actions",
        label: "Download scorecards as CSV",
        keywords: "export save file spreadsheet",
        run: () => act("Preparing scorecards.csv…", async () => saveBlob(await conn.client.exportCSV("scorecards"), `relayproof-${stamp()}-scorecards.csv`)),
      },
      {
        id: "dl-records",
        group: "Actions",
        label: "Download comparisons as CSV",
        keywords: "export save file spreadsheet records",
        run: () => act("Preparing comparisons.csv…", async () => saveBlob(await conn.client.exportCSV("records"), `relayproof-${stamp()}-comparisons.csv`)),
      },
      {
        id: "dl-json",
        group: "Actions",
        label: "Download everything as JSON",
        detail: "Summary, comparisons and rollouts",
        keywords: "export save file backup",
        run: () =>
          act("Preparing shadow-export.json…", async () => {
            const body = JSON.stringify(await conn.client.exportJSON(), null, 2);
            saveBlob(new Blob([body], { type: "application/json" }), `relayproof-${stamp()}-shadow-export.json`);
          }),
      },
      {
        id: "copy-link",
        group: "Actions",
        label: "Copy a link to this view",
        keywords: "share url address clipboard",
        run: () => act("Copying…", () => copyText(window.location.href, dialog.current), "Link copied."),
      },
      {
        id: "docs",
        group: "Actions",
        label: "Open the documentation",
        detail: "Shadow traffic: fields, API, verdicts",
        keywords: "docs help reference manual",
        run: () => {
          window.open(LINKS.docs, "_blank", "noopener,noreferrer");
          hide();
        },
      },
      {
        id: "source",
        group: "Actions",
        label: "Open the source code",
        keywords: "github repository repo code",
        run: () => {
          window.open(LINKS.repo, "_blank", "noopener,noreferrer");
          hide();
        },
      },
      {
        id: "connect",
        group: "Actions",
        label: conn.mode === "trial" ? "Sign in to your own gateway" : `Signed in to ${conn.label}`,
        detail: conn.mode === "trial" ? "On the overview, with its dashboard login" : "Sign out on the overview",
        keywords: "connect login sign in out gateway trial",
        run: () => go("overview"),
      },
    );
    return out;
  }, [open, tabs, summary, data.records, conn, go, act, hide]);

  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);

  /** Results by group: every match, best first, groups ordered by their best result. */
  const groups = useMemo(() => {
    const by = new Map<Group, Hit[]>();
    for (const item of items) {
      const hit = match(words, item);
      if (!hit) continue;
      const list = by.get(item.group) ?? [];
      list.push(hit);
      by.set(item.group, list);
    }
    const order: Group[] = ["Go to", "Candidates", "Actions", "Comparisons"];
    const result = order
      .filter((g) => by.has(g))
      .map((g) => {
        let hits = by.get(g)!;
        if (words.length > 0) {
          hits.sort((a, b) => b.score - a.score);
          const floor = hits[0].score * CUTOFF;
          hits = hits.filter((h) => h.score >= floor);
        }
        const cap = words.length === 0 && g === "Comparisons" ? RECENT : LIMIT[g];
        return { group: g, total: hits.length, hits: hits.slice(0, cap) };
      });
    if (words.length > 0) result.sort((a, b) => b.hits[0].score - a.hits[0].score);
    return result;
  }, [items, words]);

  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const current = flat[Math.min(active, flat.length - 1)];
  const optionId = (h: Hit) => `${uid}-${h.item.id}`;

  // A new query starts at the best match.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!current) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
  });

  const run = (h: Hit | undefined) => {
    if (!h || status?.tone === "busy") return;
    void h.item.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const n = flat.length;
    const step = (d: number) => {
      e.preventDefault();
      if (n > 0) setActive((i) => (Math.min(i, n - 1) + d + n) % n);
    };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) step(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) step(-1);
    else if (e.key === "PageDown") step(Math.min(5, n - 1 - active) || 0);
    else if (e.key === "PageUp") step(-Math.min(5, active) || 0);
    else if (e.key === "Enter") {
      e.preventDefault();
      run(current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    } else if (e.key === "Tab") {
      // The input is the only stop: the list is driven by the arrow keys.
      e.preventDefault();
    }
  };

  const listId = `${uid}-list`;
  const statusId = `${uid}-status`;
  const records = data.records.length;

  return (
    <>
      <button
        type="button"
        className="cp-chip"
        onClick={show}
        aria-keyshortcuts={mac ? "Meta+K /" : "Control+K /"}
        aria-label={`Search the console (${mac ? "Command K" : "Control K"})`}
        hidden={open}
      >
        <SearchIcon />
        <span>Search</span>
        <kbd>{shortcut}</kbd>
      </button>

      <dialog
        ref={dialog}
        className="cp"
        aria-label="Search the console"
        onClose={finish}
        // A click on the dialog element itself lands on the backdrop.
        onClick={(e) => e.target === dialog.current && hide()}
      >
        {open && (
          <div className="cp__panel" data-lenis-prevent>
            <div className="cp__search">
              <SearchIcon />
              <input
                ref={input}
                type="text"
                role="combobox"
                aria-expanded={flat.length > 0}
                aria-controls={listId}
                aria-activedescendant={current ? optionId(current) : undefined}
                aria-autocomplete="list"
                aria-describedby={statusId}
                aria-label="Search tabs, candidates, comparisons and actions"
                placeholder="Search tabs, candidates, prompts, actions"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <kbd className="cp__esc">Esc</kbd>
            </div>

            <div className="cp__list" id={listId} role="listbox" aria-label="Results" ref={list}>
              {groups.map((g) => (
                <div key={g.group} role="group" aria-labelledby={`${uid}-${g.group}`} className="cp__group">
                  <div className="cp__head" id={`${uid}-${g.group}`} role="presentation">
                    {words.length === 0 && g.group === "Comparisons" ? "Recent comparisons" : g.group}
                    {g.total > g.hits.length && (
                      <span className="cp__count num">
                        {g.hits.length} of {g.total}
                      </span>
                    )}
                  </div>
                  {g.hits.map((h) => {
                    const on = h === current;
                    return (
                      <div
                        key={h.item.id}
                        id={optionId(h)}
                        role="option"
                        aria-selected={on}
                        className="cp__item"
                        data-group={h.item.group}
                        // Keep focus in the input; a click runs the item.
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => !on && setActive(flat.indexOf(h))}
                        onClick={() => run(h)}
                      >
                        <span className="cp__text">
                          <span className="cp__label" data-long={h.item.long || undefined}>
                            <Marked text={h.item.label} ranges={h.label} long={h.item.long} />
                          </span>
                          {h.item.detail && (
                            <span className="cp__detail">
                              <Marked text={h.item.detail} ranges={h.detail} />
                            </span>
                          )}
                        </span>
                        {h.item.meta && <span className="cp__meta">{h.item.meta}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {flat.length === 0 && (
              <div className="cp__empty">
                <p>
                  Nothing matches <b>&ldquo;{query.trim()}&rdquo;</b>.
                </p>
                <p className="small muted">
                  {records > 0
                    ? `Prompts are searched across the ${records.toLocaleString("en-US")} comparisons loaded. Try one word from the prompt, a model or a tab.`
                    : "Comparisons are searched once they have loaded: open the Comparisons tab first. Tabs, candidates and actions are always here."}
                </p>
              </div>
            )}

            <div className="cp__foot">
              <p id={statusId} className="cp__status" data-tone={status?.tone} role={status?.tone === "error" ? "alert" : "status"}>
                {status?.text ?? (flat.length > 0 ? `${flat.length} result${flat.length === 1 ? "" : "s"}` : "")}
              </p>
              <p className="cp__keys" aria-hidden="true">
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> move
                </span>
                <span>
                  <kbd>Enter</kbd> open
                </span>
                <span>
                  <kbd>Esc</kbd> close
                </span>
              </p>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}

/**
 * Copies text: the Clipboard API, else a selected textarea inside the open
 * dialog (the page behind a modal dialog cannot take the selection).
 */
async function copyText(text: string, host: HTMLElement | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Refused or unavailable: try the older way.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  (host ?? document.body).append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("The browser did not allow copying. The link is in the address bar.");
}

function SearchIcon() {
  return (
    <svg className="cp__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </svg>
  );
}
