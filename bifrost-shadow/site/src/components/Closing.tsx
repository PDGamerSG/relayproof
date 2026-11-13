import { LINKS, PINNED_COMMIT } from "../data/site";
import { Cast } from "./Cast";
import { IconExternal, Mark } from "./Icons";
import "./Closing.css";

const LIMITS = [
  {
    title: "Chat completions only",
    body: "Streaming included. The Responses API, embeddings, images and audio are not mirrored.",
  },
  {
    title: "Records stay on each gateway node",
    body: "They live in memory, optionally in a JSONL file. In a cluster, each node reports on the traffic it served.",
  },
  {
    title: "Compared with the primary, not with ground truth",
    body: "The judge measures “as good as the model you run today”, which is the question a cost-down switch needs answered.",
  },
  {
    title: "One turn at a time",
    body: "A multi-turn agent is evaluated on the turn that was sampled. The candidate's tool calls are compared, never executed.",
  },
];

const FOOT_LINKS = [
  { href: LINKS.readme, label: "README" },
  { href: LINKS.docs, label: "Feature documentation" },
  { href: LINKS.architecture, label: "Architecture" },
  { href: LINKS.testing, label: "Testing log" },
  { href: LINKS.demo, label: "Demo source" },
  { href: LINKS.bifrost, label: "Bifrost, upstream" },
];

export function Closing() {
  return (
    <>
      <section className="section limits" id="limits">
        <div className="wrap">
          <div className="head">
            <h2 className="h2">What it does not do</h2>
            <p className="lede">A readiness verdict is only useful if you know where it stops. These are the edges today.</p>
          </div>
          <ul className="limits__list">
            {LIMITS.map((l) => (
              <li key={l.title}>
                <h3 className="h3">{l.title}</h3>
                <p>{l.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="outro">
        <div className="wrap">
          <Cast as="h2" className="outro__title display" lines={["Find out in the shadow.", "Switch in the light."]} />
          <div className="outro__actions">
            <a className="btn" href="#start">
              Run the key-free demo
            </a>
            <a className="btn btn--ghost" href={LINKS.repo}>
              Read the source
              <IconExternal />
            </a>
          </div>
        </div>
      </section>

      <footer className="foot umbra">
        <div className="wrap foot__grid">
          <div className="foot__about">
            <p className="foot__brand">
              <Mark size={24} />
              RelayProof
            </p>
            <p>
              Shadow traffic evaluation for the Bifrost AI gateway: a built-in plugin, a gateway API, a dashboard page, schema, docs
              and tests, written as an upstream contribution against <span className="model">maximhq/bifrost@{PINNED_COMMIT}</span>.
            </p>
          </div>
          <nav className="foot__links" aria-label="Project">
            {FOOT_LINKS.map((l) => (
              <a key={l.label} className="link" href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="wrap foot__fine">
          <p>Built for the Geek Room Global AI Hackathon 2026, Bifrost track, problem statement 04.</p>
          <p>An independent contribution. Not affiliated with or endorsed by Maxim AI, the maker of Bifrost.</p>
        </div>
      </footer>
    </>
  );
}
