import { OVERHEAD } from "../data/demo";
import "./Guards.css";

/** In the order the plugin tries them: the first signal that applies decides the pair. */
const SIGNALS = [
  {
    name: "LLM judge",
    rule: "Scores both answers out of 10, shown in a random order to cancel position bias. The candidate may trail the primary by one point and still pass.",
    knob: "judge, quality_tolerance",
  },
  {
    name: "Tool-call match",
    rule: "When the primary called tools, the candidate must make the same calls with the same arguments. Calls are compared, never executed.",
    knob: "always on",
  },
  {
    name: "JSON structure",
    rule: "In JSON mode the two answers must have the same shape. With embeddings on, similarity still decides.",
    knob: "always on",
  },
  {
    name: "Embedding similarity",
    rule: "Cosine similarity between the two answers of 0.85 or more.",
    knob: "embedding, semantic_threshold",
  },
  {
    name: "Lexical similarity",
    rule: "Token F1 of 0.6 or more, when nothing stronger is configured.",
    knob: "lexical_threshold",
  },
];

const GUARDS = [
  {
    risk: "Shadow work piles up behind a slow candidate",
    guard: "A bounded queue of 256 jobs and 4 workers. A full queue drops the new job and counts it; the caller's answer is already gone.",
  },
  {
    risk: "Evaluation spend runs away",
    guard: "A daily budget in USD across candidate, judge and embedding calls. When it is reached, sampling stops until the next UTC day.",
  },
  {
    risk: "A sensitive request gets mirrored",
    guard: (
      <>
        Send <code>x-bf-shadow: off</code> on the request, restrict mirroring to listed virtual keys, or turn payload storage off and
        keep only scores.
      </>
    ),
  },
  {
    risk: "Shadow calls bill a customer",
    guard: "They run as internal requests: no governance, and nothing billed to the caller's virtual key. The plugin tracks their cost itself.",
  },
  {
    risk: "A shadow call triggers tools or more shadow calls",
    guard: "Internal requests skip the plugin pipeline, so there is no shadow of a shadow. MCP is off for them, so no tool runs.",
  },
  {
    risk: "A caller forces mirroring to burn the budget",
    guard: (
      <>
        <code>x-bf-shadow: force</code> is ignored unless the operator turns it on.
      </>
    ),
  },
];

function ns(value: number): string {
  return value < 1 ? value.toString() : value.toLocaleString("en-US");
}

export function Guards() {
  const slowest = Math.max(...OVERHEAD.map((row) => row.ns));
  return (
    <>
      <section className="section signals" id="signals">
        <div className="wrap">
          <div className="head">
            <h2 className="h2">The strongest signal available decides each pair.</h2>
            <p className="lede">
              Every pair is measured the same way. Which measurement gets the final say depends on what the request was and what you
              have configured, in this order. A candidate error is always a failure.
            </p>
          </div>

          <ol className="cascade">
            {SIGNALS.map((s, i) => (
              <li key={s.name} style={{ "--i": i } as React.CSSProperties}>
                <span className="cascade__n num" aria-hidden="true">
                  {i + 1}
                </span>
                <h3 className="h3">{s.name}</h3>
                <p>{s.rule}</p>
                {s.knob === "always on" ? <span className="cascade__knob">Always on</span> : <code className="cascade__knob">{s.knob}</code>}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section guards" id="guards">
        <div className="wrap">
          <div className="head">
            <h2 className="h2">It cannot slow down, bill or surprise your callers.</h2>
            <p className="lede">
              Shadow calls start after the response and run on a bounded worker pool. Each thing that could go wrong has a limit in
              front of it.
            </p>
          </div>

          <dl className="ledger">
            <div className="ledger__head" aria-hidden="true">
              <span>What could go wrong</span>
              <span>What stops it</span>
            </div>
            {GUARDS.map((g) => (
              <div key={g.risk} className="ledger__row">
                <dt>{g.risk}</dt>
                <dd>{g.guard}</dd>
              </div>
            ))}
          </dl>

          <figure className="bench">
            <figcaption>
              <h3 className="h3">Cost on the request path</h3>
              <p>
                A request that is not sampled pays about 100 nanoseconds and allocates nothing. A sampled one pays about 10
                microseconds, once, for the snapshot and the hand-off.
              </p>
            </figcaption>
            <table className="num">
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">ns per op</th>
                  <th scope="col">Allocations</th>
                </tr>
              </thead>
              <tbody>
                {OVERHEAD.map((row) => (
                  <tr key={row.path} data-sampled={row.allocs > 0}>
                    <th scope="row">
                      {row.path}
                      <span className="bench__bar" style={{ width: `${(row.ns / slowest) * 100}%` }} />
                    </th>
                    <td>{ns(row.ns)}</td>
                    <td>{row.allocs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="bench__note small muted">
              Medians from <code>go test -bench . -benchmem -count=5</code> in <code>plugins/shadow</code>, on windows/amd64 with 32
              threads. These are microbenchmarks of the plugin's hooks, not a measurement of end-to-end gateway latency.
            </p>
          </figure>
        </div>
      </section>
    </>
  );
}
