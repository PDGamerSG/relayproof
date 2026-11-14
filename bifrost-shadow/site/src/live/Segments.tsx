import { useMemo } from "react";
import { wilsonLowerBound } from "../lib/stats";
import { count, pct } from "./backend";
import { candidateKey, counts, type RecordsState } from "./records";
import type { ShadowRecord, Summary } from "./shadowClient";

interface Segment {
  id: string;
  label: string;
  hint: string;
  test: (r: ShadowRecord) => boolean;
}

const isTool = (r: ShadowRecord) => Boolean(r.primary_answer?.tool_calls?.length) || r.comparison?.tool_names_match !== undefined;
const isJson = (r: ShadowRecord) => !isTool(r) && r.comparison?.json_match !== undefined;

const SEGMENTS: Segment[] = [
  { id: "tool", label: "Tool calls", hint: "either model called a tool", test: isTool },
  { id: "json", label: "JSON output", hint: "JSON mode or a JSON answer", test: isJson },
  { id: "short", label: "Short answers", hint: "primary answered in 20 tokens or fewer", test: (r) => !isTool(r) && !isJson(r) && r.primary_output_tokens <= 20 },
  {
    id: "long",
    label: "Longer answers",
    hint: "primary answered in more than 20 tokens",
    test: (r) => !isTool(r) && !isJson(r) && r.primary_output_tokens > 20,
  },
  { id: "stream", label: "Streamed", hint: "the caller asked for a stream", test: (r) => r.stream },
];

interface Cell {
  n: number;
  agreement: number;
  lower: number;
}

/**
 * Agreement split by the kind of request. A candidate that is ready overall can
 * still fail one kind of request, such as tool calls, that an application
 * depends on; a blended rate hides that.
 */
export function Segments({ data, summary }: { data: RecordsState; summary?: Summary }) {
  const minAgreement = summary?.thresholds.min_agreement ?? 0.9;
  const pairs = summary?.pairs ?? [];

  const table = useMemo(() => {
    return SEGMENTS.map((seg) => {
      const cells = pairs.map((p) => {
        const key = candidateKey(p);
        let n = 0;
        let passes = 0;
        for (const r of data.records) {
          if (candidateKey(r) !== key || !counts(r) || !seg.test(r)) continue;
          n++;
          if (!r.candidate_error && r.pass) passes++;
        }
        return n === 0 ? undefined : ({ n, agreement: passes / n, lower: wilsonLowerBound(passes, n) } satisfies Cell);
      });
      return { seg, cells };
    }).filter((row) => row.cells.some((c) => c !== undefined));
  }, [data.records, pairs]);

  if (!data.loaded || pairs.length === 0 || table.length === 0) return null;

  return (
    <section className="wrap lv-section lv-seg" aria-labelledby="seg-h">
      <div className="lv-head">
        <h2 className="lv-h2" id="seg-h">
          By kind of request
        </h2>
        <p className="muted small">
          The same agreement, split by what was asked. A candidate can clear the bar overall and still fail the one kind of request your
          application depends on. Cells show agreement over the loaded comparisons; the bar marks the 95% lower bound against{" "}
          {pct(minAgreement, 0)}.
        </p>
      </div>
      <div className="lv-seg__scroll">
        <table className="lv-seg__table">
          <thead>
            <tr>
              <th scope="col">Requests</th>
              {pairs.map((p) => (
                <th key={candidateKey(p)} scope="col">
                  <span className="model">{p.candidate.model}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.map(({ seg, cells }) => (
              <tr key={seg.id}>
                <th scope="row">
                  {seg.label}
                  <small>{seg.hint}</small>
                </th>
                {cells.map((c, i) => (
                  <td key={i} data-state={!c ? "none" : c.n < 10 ? "thin" : c.lower >= minAgreement ? "clear" : c.agreement >= minAgreement ? "close" : "short"}>
                    {c ? (
                      <>
                        <span className="lv-seg__rate num">{pct(c.agreement, 0)}</span>
                        <span className="lv-seg__n small num">
                          {count(c.n)} {c.n === 1 ? "pair" : "pairs"}
                          {c.n < 10 && ", too few to tell"}
                        </span>
                        <span className="lv-seg__bar" aria-hidden="true">
                          <span style={{ width: `${(Math.max(0, c.lower - 0.5) / 0.5) * 100}%` }} />
                          <i style={{ left: `${((minAgreement - 0.5) / 0.5) * 100}%` }} />
                        </span>
                        <span className="sr-only">lower bound {pct(c.lower)}</span>
                      </>
                    ) : (
                      <span className="muted small">none</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="lv-seg__key small muted">
        <span data-state="clear">Lower bound clears the bar</span>
        <span data-state="close">Agreement clears it, the evidence does not yet</span>
        <span data-state="short">Falls short</span>
      </p>
    </section>
  );
}
