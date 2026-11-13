/**
 * The hero's traffic simulation: requests travel client -> gateway -> primary and back.
 * A sampled request is marked at the gateway on the way in, and when its answer passes the
 * gateway on the way out, one copy per candidate drops into the shadow lane, is answered by
 * the candidate, judged, and counted. Readiness comes from lib/stats, the plugin's own maths.
 *
 * State lives in plain objects that the component mutates inside requestAnimationFrame;
 * React only sees a snapshot a few times a second.
 */

import { read, type Reading } from "./stats";

export interface Geom {
  /** Narrow layout: the scorecard sits under the lanes instead of beside them. */
  compact: boolean;
  w: number;
  h: number;
  /** Height of the daylight lane; the ground line sits at this y. */
  lightH: number;
  client: number;
  gateway: number;
  primary: number;
  yOut: number;
  yRet: number;
  yCan: number;
  rows: [number, number];
  cand: number;
  judge: number;
  end: number;
}

export interface CandidateProfile {
  id: string;
  /** Chance a comparison passes, given the candidate answered. */
  passRate: number;
  errorRate: number;
  /** Seconds the candidate takes to answer in the simulation. */
  dwell: number;
}

/** Outcome rates follow the key-free demo run printed in the README. */
export const PROFILES: [CandidateProfile, CandidateProfile] = [
  { id: "mini", passRate: 0.994, errorRate: 0, dwell: 0.34 },
  { id: "llama", passRate: 0.658, errorRate: 0.043, dwell: 0.2 },
];

export type Outcome = "pass" | "fail" | "error";

interface Request {
  t: number;
  sampled: boolean;
  canary: boolean;
  dropped: boolean;
}

interface ShadowJob {
  t: number;
  row: 0 | 1;
  outcome: Outcome;
}

interface Ring {
  t: number;
  x: number;
  y: number;
  dark: boolean;
}

export interface Tally {
  samples: number;
  passes: number;
  errors: number;
  recent: Outcome[];
}

export interface Sim {
  rand: () => number;
  requests: Request[];
  jobs: ShadowJob[];
  rings: Ring[];
  nextSpawn: number;
  served: number;
  mirrored: number;
  viaCanary: number;
  tallies: [Tally, Tally];
}

export interface Params {
  sampleRate: number;
  /** Share of traffic routed to the promoted candidate, 0 when no canary exists. */
  canaryShare: number;
}

export interface Snapshot {
  served: number;
  mirrored: number;
  viaCanary: number;
  tallies: [Tally & Reading, Tally & Reading];
}

const RECENT = 44;

// Seconds per leg of the request path.
const T_IN = 0.55;
const T_GO = 0.55;
const T_PRIMARY = 0.62;
const T_CANARY = 0.26;
const T_BACK = 0.55;
const T_OUT = 0.55;

// Seconds per leg of the shadow path.
const S_DROP = 0.6;
const S_JUDGE_LEG = 0.42;
const S_JUDGE = 0.3;
const S_END = 0.42;

/** Small deterministic PRNG, so every visitor sees the same run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyTally(): Tally {
  return { samples: 0, passes: 0, errors: 0, recent: [] };
}

function record(tally: Tally, outcome: Outcome) {
  tally.samples++;
  if (outcome === "pass") tally.passes++;
  if (outcome === "error") tally.errors++;
  tally.recent.push(outcome);
  if (tally.recent.length > RECENT) tally.recent.shift();
}

function drawOutcome(rand: () => number, profile: CandidateProfile): Outcome {
  if (rand() < profile.errorRate) return "error";
  return rand() < profile.passRate ? "pass" : "fail";
}

/** A new run that already holds a few comparisons, so the first verdict arrives within seconds. */
export function createSim(seed = 20261112, warm = 16): Sim {
  const rand = mulberry32(seed);
  const sim: Sim = {
    rand,
    requests: [],
    jobs: [],
    rings: [],
    nextSpawn: 0,
    served: 0,
    mirrored: 0,
    viaCanary: 0,
    tallies: [emptyTally(), emptyTally()],
  };
  for (let i = 0; i < warm; i++) {
    record(sim.tallies[0], drawOutcome(rand, PROFILES[0]));
    record(sim.tallies[1], drawOutcome(rand, PROFILES[1]));
  }
  sim.mirrored = warm;
  sim.served = warm * 2;
  return sim;
}

function requestLife(r: Request): number {
  return T_IN + T_GO + (r.canary ? T_CANARY : T_PRIMARY) + T_BACK + T_OUT;
}

function jobLife(job: ShadowJob): number {
  const dwell = PROFILES[job.row].dwell;
  return S_DROP + dwell + S_JUDGE_LEG + (job.outcome === "error" ? 0 : S_JUDGE) + S_END;
}

export function step(sim: Sim, dt: number, params: Params, geom: Geom) {
  const { rand } = sim;

  sim.nextSpawn -= dt;
  if (sim.nextSpawn <= 0) {
    sim.nextSpawn = 0.16 + rand() * 0.2;
    sim.requests.push({
      t: 0,
      sampled: rand() < params.sampleRate,
      canary: rand() < params.canaryShare,
      dropped: false,
    });
  }

  for (const r of sim.requests) {
    const before = r.t;
    r.t += dt;
    const answerAtGateway = requestLife(r) - T_OUT;

    // PreLLMHook: the sampling decision becomes visible as the request enters the gateway.
    if (r.sampled && before < T_IN && r.t >= T_IN) {
      sim.rings.push({ t: 0, x: geom.gateway, y: geom.yOut, dark: false });
    }

    // PostLLMHook: the answer is complete, so the copies are handed off. A request the canary
    // served is skipped, because its candidate is the model that answered.
    if (r.sampled && !r.dropped && r.t >= answerAtGateway) {
      r.dropped = true;
      sim.mirrored++;
      for (const row of [0, 1] as const) {
        if (r.canary && row === 0) continue;
        sim.jobs.push({ t: 0, row, outcome: drawOutcome(rand, PROFILES[row]) });
      }
      sim.rings.push({ t: 0, x: geom.gateway, y: geom.lightH, dark: true });
    }
  }

  const alive: Request[] = [];
  for (const r of sim.requests) {
    if (r.t < requestLife(r)) {
      alive.push(r);
    } else {
      sim.served++;
      if (r.canary) sim.viaCanary++;
    }
  }
  sim.requests = alive;

  const running: ShadowJob[] = [];
  for (const job of sim.jobs) {
    job.t += dt;
    if (job.t < jobLife(job)) running.push(job);
    else record(sim.tallies[job.row], job.outcome);
  }
  sim.jobs = running;

  for (const ring of sim.rings) ring.t += dt;
  sim.rings = sim.rings.filter((ring) => ring.t < 0.7);
}

export function snapshot(sim: Sim): Snapshot {
  const withReading = (t: Tally) => ({ ...t, recent: [...t.recent], ...read(t) });
  return {
    served: sim.served,
    mirrored: sim.mirrored,
    viaCanary: sim.viaCanary,
    tallies: [withReading(sim.tallies[0]), withReading(sim.tallies[1])],
  };
}

/* ------------------------------------------------------------------ drawing */

const INK = "#0f1030";
const SUN = "#ffc21a";
const LILAC = "#8f94ff";
const PASS = "#3ddc91";
const FAIL = "#ff7a7f";

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** Where a request is, and what it looks like, at its current time. */
function requestPose(r: Request, g: Geom) {
  let t = r.t;
  const dwell = r.canary ? T_CANARY : T_PRIMARY;
  const yGo = r.canary ? g.yCan : g.yOut;
  const yBack = r.canary ? g.yCan : g.yRet;

  if (t < T_IN) return { x: lerp(g.client, g.gateway, t / T_IN), y: g.yOut, answer: false, marked: false, hidden: false };
  t -= T_IN;
  if (t < T_GO) {
    const u = t / T_GO;
    // A canary request leaves the main track just after the gateway.
    const y = r.canary ? lerp(g.yOut, yGo, Math.min(1, u * 4)) : yGo;
    return { x: lerp(g.gateway, g.primary, u), y, answer: false, marked: r.sampled, hidden: false };
  }
  t -= T_GO;
  if (t < dwell) return { x: g.primary, y: yGo, answer: false, marked: r.sampled, hidden: true };
  t -= dwell;
  if (t < T_BACK) {
    const u = t / T_BACK;
    const y = r.canary ? lerp(yBack, g.yRet, Math.max(0, (u - 0.75) * 4)) : yBack;
    return { x: lerp(g.primary, g.gateway, u), y, answer: true, marked: r.sampled, hidden: false };
  }
  t -= T_BACK;
  return { x: lerp(g.gateway, g.client, Math.min(1, t / T_OUT)), y: g.yRet, answer: true, marked: false, hidden: false };
}

function jobPose(job: ShadowJob, g: Geom) {
  const y = g.rows[job.row];
  const dwell = PROFILES[job.row].dwell;
  const failedEarly = job.outcome === "error";
  let t = job.t;

  if (t < S_DROP) {
    // Down from the ground line, then along the row: one polyline, travelled at constant speed.
    const down = y - g.lightH;
    const across = g.cand - g.gateway;
    const d = (t / S_DROP) * (down + across);
    if (d < down) return { x: g.gateway, y: g.lightH + d, colour: LILAC };
    return { x: g.gateway + (d - down), y, colour: LILAC };
  }
  t -= S_DROP;
  if (t < dwell) return { x: g.cand, y, colour: LILAC, hidden: true };
  t -= dwell;
  if (t < S_JUDGE_LEG) return { x: lerp(g.cand, g.judge, t / S_JUDGE_LEG), y, colour: failedEarly ? FAIL : LILAC };
  t -= S_JUDGE_LEG;
  if (!failedEarly) {
    if (t < S_JUDGE) return { x: g.judge, y, colour: LILAC, hidden: true };
    t -= S_JUDGE;
  }
  const colour = job.outcome === "pass" ? PASS : FAIL;
  return { x: lerp(g.judge, g.end, Math.min(1, t / S_END)), y, colour };
}

function roundedSquare(ctx: CanvasRenderingContext2D, x: number, y: number, half: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x - half, y - half, half * 2, half * 2, r);
}

export function draw(ctx: CanvasRenderingContext2D, sim: Sim, g: Geom, canaryShare: number) {
  ctx.clearRect(0, 0, g.w, g.h);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Daylight tracks: out on top, back below.
  ctx.strokeStyle = "rgba(15,16,48,0.2)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(g.client, g.yOut);
  ctx.lineTo(g.primary, g.yOut);
  ctx.moveTo(g.client, g.yRet);
  ctx.lineTo(g.primary, g.yRet);
  ctx.stroke();

  if (canaryShare > 0) {
    ctx.strokeStyle = "rgba(15,16,48,0.2)";
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(g.gateway, g.yRet);
    ctx.lineTo(g.gateway + (g.primary - g.gateway) * 0.25, g.yCan);
    ctx.lineTo(g.primary, g.yCan);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Shadow tracks: down from the gateway at the ground line, then along each candidate row.
  ctx.strokeStyle = "rgba(169,173,255,0.22)";
  ctx.lineWidth = 1.25;
  for (const y of g.rows) {
    ctx.beginPath();
    ctx.moveTo(g.gateway, g.lightH);
    ctx.lineTo(g.gateway, y - 10);
    ctx.quadraticCurveTo(g.gateway, y, g.gateway + 10, y);
    ctx.lineTo(g.end, y);
    ctx.stroke();
  }

  // Rings: a sampling decision in the light, a hand-off at the ground line.
  for (const ring of sim.rings) {
    const u = ring.t / 0.7;
    ctx.strokeStyle = ring.dark ? `rgba(143,148,255,${0.7 * (1 - u)})` : `rgba(232,168,0,${0.9 * (1 - u)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ring.dark) {
      ctx.ellipse(ring.x, ring.y + 1, 10 + u * 34, 3 + u * 9, 0, 0, Math.PI);
    } else {
      ctx.arc(ring.x, ring.y, 26 + u * 22, 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  // Requests and the shadows they cast on the lit ground.
  for (const r of sim.requests) {
    const p = requestPose(r, g);
    if (p.hidden) continue;
    const half = 4.5;
    const reach = p.marked ? 30 : 9;

    const shadow = ctx.createLinearGradient(p.x, p.y + half, p.x + reach * 0.9, p.y + half + reach);
    shadow.addColorStop(0, `rgba(38,43,140,${p.marked ? 0.42 : 0.22})`);
    shadow.addColorStop(1, "rgba(38,43,140,0)");
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.moveTo(p.x - half, p.y + half);
    ctx.lineTo(p.x + half, p.y + half);
    ctx.lineTo(p.x + half + reach * 0.9, p.y + half + reach);
    ctx.lineTo(p.x - half + reach * 0.9, p.y + half + reach);
    ctx.closePath();
    ctx.fill();

    roundedSquare(ctx, p.x, p.y, half, 2);
    if (p.marked) {
      ctx.fillStyle = SUN;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (p.answer) {
      ctx.fillStyle = INK;
      ctx.fill();
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Shadow copies.
  for (const job of sim.jobs) {
    const p = jobPose(job, g);
    if (p.hidden) continue;
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = p.colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
