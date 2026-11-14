import type { ReactNode } from "react";
import { OVERHEAD } from "../data/demo";
import "./Guards.css";

/** From the key-free demo run printed in the project README. */
const ROLLOUT: { step: string; result: string; tone: "refused" | "ok" | "incident" | "rollback" }[] = [
  { step: "Promote llama-3.1-8b", result: "HTTP 409, not ready: agreement 67.1% is below 90%", tone: "refused" },
  { step: "Promote gpt-4o-mini at 10%", result: "HTTP 200, rule created: agreement 100%, lower bound 97.4%", tone: "ok" },
  { step: "Split check", result: "gpt-4o-mini served 20 of 200 requests, as expected", tone: "ok" },
  { step: "Canary health", result: "Healthy: live error rate 0.0% over 20 requests", tone: "ok" },
  { step: "Provider incident", result: "gpt-4o-mini now fails 60% of requests", tone: "incident" },
  { step: "Canary guard", result: "Rolled back: live error rate 19.2% (lower bound 8.5%) is over 5%", tone: "rollback" },
  { step: "After rollback", result: "gpt-4o-mini served 0 of the next 100 requests", tone: "ok" },
];

/** In the order the plugin applies them (decidePass in plugins/shadow/worker.go). */
const SIGNALS = [
  { name: "Tool selection", rule: "A different tool fails the pair, whatever any other signal says. Calls are compared, never run." },
  { name: "JSON structure", rule: "In JSON mode, a candidate that breaks the primary's shape fails." },
  { name: "LLM judge", rule: "Scores both answers out of 10 in random order. The candidate may trail by one point." },
  { name: "Exact match", rule: "Identical answers, or identical tool calls, pass without an evaluator." },
  { name: "Embeddings", rule: "Cosine similarity of 0.85 or more passes." },
  { name: "Lexical overlap", rule: "Only if you opt in. Otherwise a pair with no stronger signal stays unscored." },
];

const GUARDS: { risk: string; guard: ReactNode }[] = [
  { risk: "A slow candidate", guard: "A bounded queue of 256 jobs and 4 workers. A full queue drops the job and counts it." },
  { risk: "Runaway spend", guard: "A daily budget in USD across candidate, judge and embedding calls. Sampling stops when it is spent." },
  {
    risk: "Sensitive requests",
    guard: (
      <>
        Send <code>x-bf-shadow: off</code>, mirror only listed virtual keys, or keep scores without payloads.
      </>
    ),
  },
  { risk: "Billing a customer", guard: "Shadow calls are internal requests. Nothing is billed to the caller's virtual key." },
  { risk: "Tools or loops", guard: "No plugin pipeline, so no shadow of a shadow. MCP is off, so no tool runs." },
  {
    risk: "Forced mirroring",
    guard: (
      <>
        <code>x-bf-shadow: force</code> is ignored unless the operator allows it.
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
    <section className="section guards" id="guards">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">It cannot slow down, bill or surprise your callers.</h2>
          <p className="lede">
            Shadow work starts after the response, on a bounded worker pool. Promotion is refused without evidence, and once a canary
            is live the gateway watches it and pulls it back on its own.
          </p>
        </div>

        <div className="guards__top">
          <figure className="rollout">
            <figcaption>
              <h3 className="h3">The canary guard at work</h3>
              <p>One run of the key-free demo, from refused promotion to automatic rollback.</p>
            </figcaption>
            <ol className="rollout__log num">
              {ROLLOUT.map((line) => (
                <li key={line.step} data-tone={line.tone}>
                  <span className="rollout__step">{line.step}</span>
                  <span className="rollout__result">{line.result}</span>
                </li>
              ))}
            </ol>
          </figure>

          <div className="signals">
            <h3 className="h3">What decides a pair</h3>
            <p className="signals__lede">Two required checks, then the strongest signal you configured, in this order.</p>
            <ol className="signals__list">
              {SIGNALS.map((s, i) => (
                <li key={s.name}>
                  <span className="signals__n num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <b>{s.name}</b>
                  <span>{s.rule}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <dl className="ledger">
          {GUARDS.map((g) => (
            <div key={g.risk}>
              <dt>{g.risk}</dt>
              <dd>{g.guard}</dd>
            </div>
          ))}
        </dl>

        <figure className="bench">
          <figcaption>
            <h3 className="h3">Cost on the request path</h3>
            <p>
              A request that is not sampled pays about 100 nanoseconds and allocates nothing. A sampled one pays about 10 microseconds,
              once.
            </p>
            <p className="bench__note">
              Medians of <code>go test -bench . -benchmem -count=5</code> in <code>plugins/shadow</code>, windows/amd64, 32 threads.
              Microbenchmarks of the plugin's hooks, not end-to-end gateway latency.
            </p>
          </figcaption>
          <table>
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
                    <span className="bench__bar" style={{ width: `${Math.max(0.4, (row.ns / slowest) * 100)}%` }} />
                  </th>
                  <td>{ns(row.ns)}</td>
                  <td>{row.allocs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      </div>
    </section>
  );
}
