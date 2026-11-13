import "./Problem.css";

const METHODS = [
  {
    name: "Offline eval set",
    rows: ["Prompts someone wrote by hand", "No", "How it does on the prompts you thought of", "The set goes stale, so you keep rebuilding it"],
  },
  {
    name: "A/B test",
    rows: ["Production traffic", "Yes, from the first request", "How users react, once they have been exposed", "Real users find the bad answers for you"],
  },
  {
    name: "Shadow traffic",
    rows: [
      "Production traffic",
      "No. Every caller gets the primary model's answer",
      "How often it agrees with the model you run today, with a 95% lower bound",
      "A sampled share of extra model calls, capped by a daily budget",
    ],
    ours: true,
  },
];

const QUESTIONS = ["Runs on", "Users see the candidate's answers", "What you learn", "What it costs you"];

export function Problem() {
  return (
    <section className="section problem" id="why">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">Switching models is the biggest cost lever, and the riskiest.</h2>
          <p className="lede">
            Model spend is the largest line item for most AI products, and the cheapest fix is a cheaper model. Teams rarely switch,
            because one question stays open: on our traffic, is the cheaper model as good?
          </p>
        </div>

        <div className="ways" role="table" aria-label="Three ways to test a cheaper model">
          <div className="ways__row ways__row--head" role="row">
            <span role="columnheader" className="ways__corner">
              <span className="sr-only">Question</span>
            </span>
            {METHODS.map((m) => (
              <span role="columnheader" key={m.name} className="ways__method" data-ours={m.ours}>
                {m.name}
              </span>
            ))}
          </div>
          {QUESTIONS.map((q, i) => (
            <div className="ways__row" role="row" key={q}>
              <span role="rowheader" className="ways__q">
                {q}
              </span>
              {METHODS.map((m) => (
                <span role="cell" key={m.name} className="ways__a" data-ours={m.ours} data-method={m.name}>
                  {m.rows[i]}
                </span>
              ))}
            </div>
          ))}
          <div className="ways__lift" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
