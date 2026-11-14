import { useEffect, useRef, useState } from "react";
import { PRIMARY, SHADOWED } from "../data/hosted";
import { LINKS, PINNED_COMMIT } from "../data/site";
import { IconCheck, IconCopy } from "./Icons";
import "./QuickStart.css";

interface Snippet {
  id: string;
  tab: string;
  file: string;
  note: string;
  code: string;
}

const SNIPPETS: Snippet[] = [
  {
    id: "demo",
    tab: "Key-free demo",
    file: "from the repository root",
    note: "A mock upstream plays every model, so no provider keys are needed. The run ends by promoting the ready candidate to a 10% canary, breaking it, and watching the guard roll it back.",
    code: `# Clone Bifrost at the pinned commit, add the plugin, apply the patches, build
bifrost-shadow/scripts/setup.sh

# Send 300 mixed requests through the gateway and print the scorecard
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh`,
  },
  {
    id: "config",
    tab: "config.json",
    file: "config.json",
    note: "Shadow a tenth of Opus traffic with Sonnet and Haiku, judge each pair with Opus, stop at 20 dollars a day, and let the guard roll back a bad canary. Every provider named here needs a key in Bifrost.",
    code: `{
  "plugins": [{
    "enabled": true,
    "name": "shadow",
    "config": {
      "sample_rate": 0.1,
      "experiments": [{
        "source": { "provider": "anthropic", "model": "claude-opus-5-5" },
        "candidates": [
          { "provider": "anthropic", "model": "claude-sonnet-5-5" },
          { "provider": "anthropic", "model": "claude-haiku-5-5" }
        ]
      }],
      "judge": { "provider": "anthropic", "model": "claude-opus-5-5" },
      "daily_budget_usd": 20,
      "canary": { "auto_rollback": true }
    }
  }]
}`,
  },
  {
    id: "api",
    tab: "Promote by API",
    file: "shell, against the demo gateway",
    note: "The first call previews the routing rule and any warnings. The second creates it, and is refused with a 409 unless the candidate is ready.",
    code: `# Preview: 10% of openai/gpt-4o traffic to openai/gpt-4o-mini
curl -s -X POST http://localhost:8080/api/shadow/promote \\
  -H "Content-Type: application/json" \\
  -d '{"experiment":"gpt-4o cost-down","candidate":"openai/gpt-4o-mini","weight":0.1,"dry_run":true}'

# Promote for real
curl -s -X POST http://localhost:8080/api/shadow/promote \\
  -H "Content-Type: application/json" \\
  -d '{"experiment":"gpt-4o cost-down","candidate":"openai/gpt-4o-mini","weight":0.1}'`,
  },
];

const CONSOLE = [
  "Ask your own question and read all three answers next to the judge's verdict",
  "Watch the scorecards fill, the lower bounds tighten and drift between recent and earlier traffic",
  "Open any comparison with the changed words marked, and check how far to trust the judge",
  "Move the readiness bar in the policy lab and see which verdicts flip",
  "Promote a ready candidate and let the guard ramp it from 25% to all traffic",
  "Simulate a provider outage and watch the guard roll the canary back",
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the code stays selectable.
    }
  };

  return (
    <button type="button" className="code__copy" onClick={copy} data-copied={copied}>
      {copied ? <IconCheck /> : <IconCopy />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/** Comment lines are dimmed; nothing else is highlighted. */
function Code({ code }: { code: string }) {
  return (
    <pre className="code__pre" data-lenis-prevent tabIndex={0}>
      <code>
        {code.split("\n").map((line, i) => (
          <span key={i} data-comment={line.trimStart().startsWith("#")}>
            {line}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function QuickStart() {
  const [active, setActive] = useState(SNIPPETS[0].id);
  const snippet = SNIPPETS.find((s) => s.id === active) ?? SNIPPETS[0];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = SNIPPETS.findIndex((s) => s.id === active);
    const next = SNIPPETS[(i + (e.key === "ArrowRight" ? 1 : SNIPPETS.length - 1)) % SNIPPETS.length];
    setActive(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <section className="section start" id="start">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">Try it on real models, or run it yourself.</h2>
          <p className="lede">
            The live console needs nothing from you. Running it locally takes two commands and no API keys: the setup script builds
            Bifrost <span className="model">{PINNED_COMMIT}</span> with the plugin, and the demo runs a full experiment.
          </p>
        </div>

        <div className="start__grid">
          <article className="path path--live">
            <h3 className="h3">In the live console</h3>
            <p className="path__lede">
              A hosted gateway on real Claude models: <span className="model">{PRIMARY}</span> answers, and{" "}
              <span className="model">{SHADOWED[0]}</span> and <span className="model">{SHADOWED[1]}</span> run in its shadow. No sign-up.
            </p>
            <ul className="path__list">
              {CONSOLE.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="path__actions">
              <a className="btn btn--sun" href="live.html">
                Open the live console
              </a>
            </div>
            <p className="path__fine">
              Spend is capped: 400 requests a day for the whole demo and 20 questions an hour for each visitor. Outages clear themselves
              after 3 minutes.
            </p>
          </article>

          <article className="path path--local">
            <h3 className="h3">On your machine</h3>
            <div className="code">
              <div className="code__bar">
                <div className="code__tabs" role="tablist" aria-label="Examples" onKeyDown={onKey}>
                  {SNIPPETS.map((s) => (
                    <button
                      key={s.id}
                      id={`tab-${s.id}`}
                      type="button"
                      role="tab"
                      aria-selected={s.id === active}
                      aria-controls="start-panel"
                      tabIndex={s.id === active ? 0 : -1}
                      onClick={() => setActive(s.id)}
                    >
                      {s.tab}
                    </button>
                  ))}
                </div>
                <CopyButton text={snippet.code} />
              </div>
              <div id="start-panel" role="tabpanel" aria-labelledby={`tab-${snippet.id}`} key={snippet.id} className="code__panel">
                <p className="code__file">{snippet.file}</p>
                <Code code={snippet.code} />
              </div>
            </div>
            <p className="start__note" key={snippet.id}>
              {snippet.note}
            </p>
            <p className="start__needs">
              You need git, Go 1.27 or newer, a C compiler for the SQLite config store, and Node 26 for the dashboard (set{" "}
              <code>SKIP_UI=1</code> to skip it).{" "}
              <a className="link" href={LINKS.docs}>
                Every option is in the feature documentation.
              </a>
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
