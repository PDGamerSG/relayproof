import "./ConsoleTour.css";

interface Stop {
  id: string;
  name: string;
  text: string;
  icon: string;
}

/** The live console's tabs, in the order of the job: watch, decide, act. Paths match the console's sidebar icons. */
const GROUPS: { name: string; job: string; stops: Stop[] }[] = [
  {
    name: "Watch",
    job: "See what the candidates do with your traffic.",
    stops: [
      {
        id: "overview",
        name: "Overview",
        text: "Scorecards with their agreement trend, drift between recent and earlier traffic, and agreement by kind of request.",
        icon: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
      },
      {
        id: "ask",
        name: "Ask",
        text: "Send your own question through the gateway and read all three answers with the judge's verdict.",
        icon: "M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z",
      },
      {
        id: "comparisons",
        name: "Comparisons",
        text: "Every shadowed request, searchable, with the candidate's answer diffed word by word against the one the user got.",
        icon: "M2.5 2.5h4.5v11H2.5zM9 2.5h4.5v11H9zM9 6h4.5M9 9.5h4.5",
      },
      {
        id: "performance",
        name: "Performance",
        text: "Latency, tokens and cost per model, and whether the evaluation pays for itself.",
        icon: "M8 14a6 6 0 1 1 6-6M8 8l3-3M2.5 14h11",
      },
    ],
  },
  {
    name: "Decide",
    job: "Check the evidence before you trust it.",
    stops: [
      {
        id: "judge",
        name: "Judge check",
        text: "Whether answer order or length sways the LLM judge, and a blind labelling loop that measures your agreement with it.",
        icon: "M8 2v11.5M4.5 13.5h7M3 4.5h10M3 4.5 1.5 8.5a1.6 1.6 0 0 0 3 0zM13 4.5l-1.5 4a1.6 1.6 0 0 0 3 0z",
      },
      {
        id: "policy",
        name: "Policy lab",
        text: "Move the readiness bar, the judge tolerance and the error budget, and see which verdicts would flip.",
        icon: "M2.5 4h11M2.5 8h11M2.5 12h11M5.5 2.5v3M10.5 6.5v3M7 10.5v3",
      },
      {
        id: "report",
        name: "Report",
        text: "One page per candidate that answers “can we switch?”, ready to print or paste into a pull request.",
        icon: "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5",
      },
    ],
  },
  {
    name: "Act",
    job: "Move traffic, and let the gateway undo it.",
    stops: [
      {
        id: "rollout",
        name: "Rollout",
        text: "Promote to a canary, break the candidate with a simulated outage, and watch the guard roll it back.",
        icon: "M2.5 13.5 6.5 9l2.5 2.5 4.5-6M10 5.5h3.5V9",
      },
      {
        id: "setup",
        name: "Set up",
        text: "Build the plugin's configuration for your own gateway, with the commands to check it works.",
        icon: "M3 2.5h10v11H3zM5.5 5.5l2 2-2 2M8.5 10h2",
      },
    ],
  },
];

export function ConsoleTour() {
  return (
    <section className="section tour" id="console" aria-labelledby="tour-h">
      <div className="wrap">
        <div className="head">
          <h2 className="h2" id="tour-h">
            One console for the whole decision
          </h2>
          <p className="lede">
            The live console runs on a real gateway calling real Claude models. It follows the job in order: watch what the cheaper
            models do with live traffic, check the evidence and the judge behind it, then move traffic and let the guard undo it.
          </p>
        </div>

        <div className="tour__groups">
          {GROUPS.map((g) => (
            <section key={g.name} className="tour__group" aria-labelledby={`tour-${g.name}`}>
              <h3 className="tour__name" id={`tour-${g.name}`}>
                {g.name}
              </h3>
              <p className="tour__job">{g.job}</p>
              <ul className="tour__stops">
                {g.stops.map((s) => (
                  <li key={s.id}>
                    <a className="tour__stop" href={`live.html#${s.id}`}>
                      <svg className="tour__icon" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
                        <path d={s.icon} />
                      </svg>
                      <span className="tour__text">
                        <b>{s.name}</b>
                        <span>{s.text}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
