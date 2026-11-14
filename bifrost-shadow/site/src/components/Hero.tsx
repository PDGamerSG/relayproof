import { LINKS } from "../data/site";
import { Specimen } from "./Specimen";
import "./Hero.css";

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap">
        <div className="hero__intro">
          <h1 className="hero__title display">Prove a cheaper model is good enough before you switch.</h1>

          <div className="hero__side">
            <p className="lede hero__lede">
              RelayProof is a plugin for the{" "}
              <a className="link" href={LINKS.bifrost}>
                Bifrost AI gateway
              </a>
              . It quietly re-runs a sample of your real requests on cheaper models, has a judge compare every answer with the one
              your user got, and tells you when a candidate has earned a share of your traffic.
            </p>
            <div className="hero__actions">
              <a className="btn btn--sun" href="live.html">
                Open the live console
              </a>
              <a className="btn btn--ghost" href={LINKS.repo}>
                View on GitHub
              </a>
            </div>
            <p className="hero__aside">The console runs on real Claude models. No sign-up.</p>
          </div>
        </div>

        <div className="hero__spec spec-frame">
          <Specimen />
        </div>
      </div>
    </section>
  );
}
