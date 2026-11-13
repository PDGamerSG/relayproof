import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createSim, draw, snapshot, step, type Geom, type Outcome, type Sim, type Snapshot } from "../lib/sim";
import { pct, VERDICT_LABEL, type Reading } from "../lib/stats";
import { CANDIDATES, SOURCE } from "../data/demo";
import { IconPause, IconPlay, IconRestart } from "./Icons";
import "./TrafficSim.css";

const RAMP = [0.1, 0.25, 0.5];
const SLOTS = 44;

/** Axis of the interval bar: 40% to 100%, which keeps both candidates' intervals readable. */
const AXIS_MIN = 0.4;
function axis(fraction: number): string {
  const u = (Math.min(1, Math.max(AXIS_MIN, fraction)) - AXIS_MIN) / (1 - AXIS_MIN);
  return `${(u * 100).toFixed(2)}%`;
}

function measure(stage: HTMLElement, light: HTMLElement, score: HTMLElement): Geom {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const lightH = light.offsetHeight;
  const darkH = h - lightH;
  // The container query in TrafficSim.css decides the layout; read its answer rather than repeat the breakpoint.
  const compact = getComputedStyle(stage).getPropertyValue("--compact").trim() === "1";

  if (compact) {
    const yOut = Math.round(lightH * 0.34);
    return {
      compact,
      w,
      h,
      lightH,
      client: 30,
      gateway: Math.round(w * 0.36),
      primary: Math.round(w * 0.8),
      yOut,
      yRet: yOut + 26,
      yCan: lightH - 34,
      rows: [lightH + Math.round(darkH * 0.36), lightH + Math.round(darkH * 0.76)],
      cand: Math.round(w * 0.61),
      judge: Math.round(w * 0.85),
      end: w - 8,
    };
  }

  const scoreLeft = w - score.offsetWidth;
  const gateway = Math.round(Math.max(236, w * 0.26));
  const yOut = Math.round(lightH * 0.37);
  return {
    compact,
    w,
    h,
    lightH,
    client: 70,
    gateway,
    primary: Math.round(w * 0.56),
    yOut,
    yRet: yOut + 28,
    yCan: lightH - 40,
    rows: [lightH + Math.round(darkH * 0.3), lightH + Math.round(darkH * 0.7)],
    cand: Math.round(gateway + (scoreLeft - gateway) * 0.37),
    judge: Math.round(gateway + (scoreLeft - gateway) * 0.74),
    end: scoreLeft - 4,
  };
}

function at(x: number, y: number): CSSProperties {
  return { left: x, top: y };
}

function Tally({ recent }: { recent: Outcome[] }) {
  const cells = recent.slice(-SLOTS);
  return (
    <div className="sim-tally" aria-hidden="true">
      {Array.from({ length: SLOTS }, (_, i) => (
        <i key={i} data-o={cells[i] ?? "empty"} />
      ))}
    </div>
  );
}

function ScoreRow({ model, tally, children }: { model: string; tally: Reading & { samples: number; recent: Outcome[] }; children?: React.ReactNode }) {
  return (
    <div className="sim-row">
      <div className="sim-row__top">
        <span className="model">{model}</span>
        <span className="verdict" data-verdict={tally.verdict}>
          {VERDICT_LABEL[tally.verdict]}
        </span>
      </div>
      <dl className="sim-row__figures num">
        <div>
          <dt>Agreement</dt>
          <dd>{pct(tally.agreement)}</dd>
        </div>
        <div>
          <dt>95% lower bound</dt>
          <dd>{pct(tally.lowerBound)}</dd>
        </div>
        <div>
          <dt>Compared</dt>
          <dd>{tally.samples}</dd>
        </div>
      </dl>
      <div className="sim-bar" aria-hidden="true">
        <span className="sim-bar__need" style={{ left: axis(0.9) }} />
        <span
          className="sim-bar__interval"
          data-clear={tally.lowerBound >= 0.9}
          style={{ left: axis(tally.lowerBound), right: `calc(100% - ${axis(tally.agreement)})` }}
        />
        <span className="sim-bar__point" style={{ left: axis(tally.agreement) }} />
      </div>
      <Tally recent={tally.recent} />
      {children}
    </div>
  );
}

export function TrafficSim() {
  const stageRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const simRef = useRef<Sim>(createSim());
  const geomRef = useRef<Geom | null>(null);
  const paramsRef = useRef({ sampleRate: 0.5, canaryShare: 0 });
  const runningRef = useRef(true);
  const visibleRef = useRef(false);

  const [geom, setGeom] = useState<Geom | null>(null);
  const [snap, setSnap] = useState<Snapshot>(() => snapshot(simRef.current));
  const [sampleRate, setSampleRate] = useState(0.5);
  const [canaryShare, setCanaryShare] = useState(0);
  const [running, setRunning] = useState(true);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const g = geomRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !g || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, simRef.current, g, paramsRef.current.canaryShare);
  }, []);

  // Measure the stage and keep the canvas and the node labels on the same coordinates.
  useEffect(() => {
    const stage = stageRef.current;
    const light = lightRef.current;
    const score = scoreRef.current;
    const canvas = canvasRef.current;
    if (!stage || !light || !score || !canvas) return;

    const layout = () => {
      const g = measure(stage, light, score);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(g.w * dpr);
      canvas.height = Math.round(g.h * dpr);
      geomRef.current = g;
      setGeom(g);
      paint();
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(stage);
    observer.observe(score);
    return () => observer.disconnect();
  }, [paint]);

  // The loop. It idles while the simulation is paused, off screen, or in a background tab.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // No autoplay: show the state a minute of traffic would reach, and leave Play to the reader.
      runningRef.current = false;
      setRunning(false);
      const g = geomRef.current;
      if (g) {
        for (let i = 0; i < 1800; i++) step(simRef.current, 1 / 30, paramsRef.current, g);
        setSnap(snapshot(simRef.current));
        paint();
      }
    }

    const io = new IntersectionObserver(([entry]) => (visibleRef.current = entry.isIntersecting), { rootMargin: "120px" });
    io.observe(stage);

    let raf = 0;
    let last = performance.now();
    let sinceSnap = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const g = geomRef.current;
      if (!g || !runningRef.current || !visibleRef.current || document.hidden) return;
      step(simRef.current, dt, paramsRef.current, g);
      paint();
      sinceSnap += dt;
      if (sinceSnap > 0.15) {
        sinceSnap = 0;
        setSnap(snapshot(simRef.current));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [paint]);

  const toggle = () => {
    runningRef.current = !runningRef.current;
    setRunning(runningRef.current);
  };

  const restart = () => {
    simRef.current = createSim();
    paramsRef.current.canaryShare = 0;
    setCanaryShare(0);
    setSnap(snapshot(simRef.current));
    paint();
  };

  const changeRate = (value: number) => {
    paramsRef.current.sampleRate = value;
    setSampleRate(value);
  };

  const promote = () => {
    const next = RAMP[RAMP.indexOf(canaryShare) + 1] ?? RAMP[0];
    paramsRef.current.canaryShare = next;
    setCanaryShare(next);
    paint();
  };

  const [mini, llama] = snap.tallies;
  const ready = mini.verdict === "ready";
  const nextShare = RAMP[RAMP.indexOf(canaryShare) + 1];
  const compact = geom?.compact ?? false;
  const midY = geom ? (geom.yOut + geom.yRet) / 2 : 0;

  return (
    <div className="sim-frame">
    <div className="sim">
      <div className="sim__light" ref={lightRef}>
        <p className="sim__lane-name">Request path</p>
        <div className="sim__readout num">
          <dl>
            <div>
              <dt>Answers served</dt>
              <dd>{snap.served.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Mirrored</dt>
              <dd>{snap.mirrored.toLocaleString("en-US")}</dd>
            </div>
          </dl>
          <p>Every answer leaves before any shadow work starts.</p>
        </div>
      </div>

      <div className="sim__dark umbra">
        <p className="sim__lane-name">
          Shadow path<span>, after the answer is sent</span>
        </p>
        <ul className="sim__legend" aria-hidden="true">
          <li data-k="request">Request</li>
          <li data-k="answer">Answer</li>
          <li data-k="sampled">Sampled</li>
          <li data-k="copy">Shadow copy</li>
          <li data-k="pass">Agrees with the primary</li>
          <li data-k="fail">Disagrees or failed</li>
        </ul>
      </div>

      <div
        className="sim__stage"
        ref={stageRef}
        role="img"
        aria-label={`Animated diagram. Requests travel from your app through Bifrost to ${SOURCE} and the answers travel back. Sampled requests drop a copy into a shadow path, where two cheaper models answer it and a judge scores each answer against the primary's.`}
      >
        <canvas ref={canvasRef} className="sim__canvas" aria-hidden="true" />
        {geom && (
          <div className="sim__nodes" aria-hidden="true">
            <span className="sim-node sim-node--plain" style={at(geom.client, midY)}>
              {compact ? "App" : "Your app"}
            </span>
            <span
              className="sim-node sim-node--gateway"
              style={{ left: geom.gateway, top: geom.yOut - 30, height: geom.lightH - (geom.yOut - 30) }}
            >
              Bifrost
            </span>
            <span className="sim-node sim-node--model" style={at(geom.primary, midY)}>
              <small>Primary</small>
              {compact ? "gpt-4o" : SOURCE}
            </span>
            <span className="sim-node sim-node--model sim-node--canary" data-on={canaryShare > 0} style={at(geom.primary, geom.yCan)}>
              <small>Canary, {Math.round(canaryShare * 100)}%</small>
              {CANDIDATES[0].short}
            </span>

            <span className="sim-node sim-node--judge" style={{ left: geom.judge, top: geom.rows[0] - 30, height: geom.rows[1] - geom.rows[0] + 60 }}>
              Judge
            </span>
            {CANDIDATES.map((c, i) => (
              <span key={c.id} className="sim-node sim-node--candidate" style={at(geom.cand, geom.rows[i])}>
                {c.short}
              </span>
            ))}
          </div>
        )}
      </div>

      <aside className="sim__score umbra" ref={scoreRef} aria-label="Live scorecard">
        <ScoreRow model={CANDIDATES[0].model} tally={mini}>
          <div className="sim-promote">
            <button type="button" className="btn btn--sun btn--small" onClick={promote} disabled={!ready || (canaryShare > 0 && !nextShare)}>
              {canaryShare === 0 ? "Promote to canary" : nextShare ? `Ramp to ${nextShare * 100}%` : "Canary at 50%"}
            </button>
            <p className="num">
              {canaryShare > 0
                ? `${Math.round(canaryShare * 100)}% of traffic now gets ${CANDIDATES[0].short}. ${snap.viaCanary} answered so far.`
                : ready
                  ? "The lower bound cleared 90%. Send it a share of real traffic."
                  : "Unlocks when the lower bound clears 90%."}
            </p>
          </div>
        </ScoreRow>
        <ScoreRow model={CANDIDATES[1].model} tally={llama} />
      </aside>

      <div className="sim__controls umbra">
        <label className="sim-rate">
          <span>Sample rate</span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(sampleRate * 100)}
            onChange={(e) => changeRate(Number(e.target.value) / 100)}
            style={{ "--fill": `${((sampleRate * 100 - 5) / 95) * 100}%` } as CSSProperties}
          />
          <output className="num">{Math.round(sampleRate * 100)}%</output>
        </label>
        <div className="sim__buttons">
          <button type="button" className="sim-icon" onClick={toggle} aria-label={running ? "Pause the simulation" : "Play the simulation"}>
            {running ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="sim-icon" onClick={restart} aria-label="Restart the simulation">
            <IconRestart />
          </button>
        </div>
        <p className="sim__note">A simulation. Outcome rates follow the demo run; verdicts use the plugin's readiness maths.</p>
      </div>
    </div>
    </div>
  );
}
