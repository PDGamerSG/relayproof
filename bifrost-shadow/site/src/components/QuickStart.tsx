import { useEffect, useRef, useState } from "react";
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
    note: "A mock upstream plays all three models, so no provider keys are needed. The run ends by promoting the ready candidate to a 10% canary and checking the split.",
    code: `# Clone Bifrost at the pinned commit, add the plugin, apply the patches, build
bifrost-shadow/scripts/setup.sh

# Send 300 mixed requests through the gateway and print the scorecard
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh`,
  },
  {
    id: "config",
    tab: "config.json",
    file: "config.json",
    note: "Mirror a tenth of gpt-4o traffic to gpt-4o-mini, judge each pair, and stop at 20 dollars a day. Every provider named here needs an enabled key in Bifrost.",
    code: `{
  "plugins": [{
    "enabled": true,
    "name": "shadow",
    "config": {
      "sample_rate": 0.1,
      "experiments": [{
        "source": { "provider": "openai", "model": "gpt-4o" },
        "candidates": [{ "provider": "openai", "model": "gpt-4o-mini" }]
      }],
      "judge": { "provider": "openai", "model": "gpt-4o" },
      "daily_budget_usd": 20
    }
  }]
}`,
  },
  {
    id: "api",
    tab: "Promote by API",
    file: "shell",
    note: "The same two calls the dashboard makes. The first builds the routing rule, the second creates it.",
    code: `# Build the rule: 10% of openai/gpt-4o traffic to openai/gpt-4o-mini
curl -s "http://localhost:8080/api/shadow/canary-rule?experiment=gpt-4o%20cost-down&candidate=openai/gpt-4o-mini&weight=0.1" > rule.json

# Create it
curl -X POST http://localhost:8080/api/routing/rules \\
  -H "Content-Type: application/json" -d @rule.json`,
  },
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
    <section className="section umbra start" id="start">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">Two commands, no API keys.</h2>
          <p className="lede">
            The setup script builds a Bifrost gateway with the plugin on top of upstream <span className="model">{PINNED_COMMIT}</span>.
            The demo then runs a full experiment against a deterministic mock.
          </p>
        </div>

        <div className="start__grid">
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

          <div className="start__side">
            <p className="start__note" key={snippet.id}>
              {snippet.note}
            </p>
            <dl className="start__needs">
              <dt>You need</dt>
              <dd>git</dd>
              <dd>Go 1.27 or newer</dd>
              <dd>A C compiler, for the SQLite config store</dd>
              <dd>Node 26, for the dashboard build. Set SKIP_UI=1 to skip it.</dd>
            </dl>
            <a className="link start__docs" href={LINKS.docs}>
              Every option, in the feature documentation
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
