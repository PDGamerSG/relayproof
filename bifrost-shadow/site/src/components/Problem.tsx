import "./Problem.css";

const METHODS = [
  {
    name: "Offline eval set",
    rows: ["Prompts someone wrote by hand", "No", "How it does on the prompts you thought of", "Rebuilding the set as it goes stale"],
  },
  {
    name: "A/B test",
    rows: ["Production traffic", "Yes, from the first request", "How users react, after they have seen it", "Real users find the bad answers for you"],
  },
  {
    name: "Shadow traffic",
    rows: [
      "Production traffic",
      "No. Everyone gets the answer from the model you run today",
      "How often it agrees with that model, with a 95% lower bound",
      "Extra calls on a sample of requests, capped by a daily budget",
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
          <h2 className="h2">Why not test it offline, or with an A/B test?</h2>
          <p className="lede">
            Model spend is often the largest bill an AI product has, and a cheaper model is the quickest fix. Teams hold back because
            they cannot answer one question: on our own traffic, is it as good?
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
