import { LINKS } from "../data/site";
import { Cast } from "./Cast";
import { IconArrowDown } from "./Icons";
import { TrafficSim } from "./TrafficSim";
import "./Hero.css";

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap">
        <Cast as="h1" className="hero__title display" lines={["Every request", "casts a shadow."]} />

        <div className="hero__below">
          <p className="lede hero__lede">
            Bifrost Shadow is a plugin for the{" "}
            <a className="link" href={LINKS.bifrost}>
              Bifrost AI gateway
            </a>
            . It replays a sample of your live chat traffic against cheaper models after each answer has gone out, scores every pair
            against the model that answered, and tells you when a candidate is safe to switch to.
          </p>
          <div className="hero__actions">
            <a className="btn" href="#start">
              Run the key-free demo
            </a>
            <a className="btn btn--ghost" href="#how">
              See how it works
              <IconArrowDown />
            </a>
          </div>
        </div>

        <div className="hero__sim">
          <TrafficSim />
        </div>
      </div>
    </section>
  );
}
