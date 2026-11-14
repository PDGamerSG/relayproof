/**
 * Records from the hosted gateway (bifrost-shadow/deploy, gateway-claude.json): real Claude models,
 * claude-opus-5-5 serving, claude-sonnet-5-5 and claude-haiku-5-5 shadowed, claude-opus-5-5 judging.
 * Copied from GET /api/shadow/records and /api/shadow/summary on 14 Nov 2026. The landing page never
 * calls the hosted backend: any call there marks the console as watched and starts paid traffic.
 */

export const PRIMARY = "claude-opus-5-5";
export const SHADOWED = ["claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type ShadowModel = (typeof SHADOWED)[number];

export type Reply = { kind: "text"; text: string } | { kind: "tool"; name: string; args: string };

export interface Run {
  reply: Reply;
  latencyMs: number;
  costUsd: number;
  outTokens: number;
}

export interface ShadowRun extends Run {
  model: ShadowModel;
  judge: { primary: number; candidate: number; reason: string; candidateShownFirst: boolean };
  pass: boolean;
  /** What the deterministic checks saw, when they apply. */
  check?: string;
}

export interface Specimen {
  id: string;
  label: string;
  /** UTC timestamp the request reached the gateway. */
  at: string;
  requestId: string;
  prompt: string;
  inTokens: number;
  primary: Run;
  shadow: [ShadowRun, ShadowRun];
}

const IDEMPOTENCY_OPUS =
  "An API operation is idempotent if making the same request multiple times has the same effect on the server as making it once. For example, PUT and DELETE are designed to be idempotent, so retrying them after a network failure is safe, while POST typically is not unless the API supports a mechanism such as an idempotency key.";

const RATE_LIMIT_OPUS =
  "Rate limiting protects systems from being overwhelmed by too many requests in a short period. Such floods can come from malicious attacks like DDoS, brute-force login attempts, or credential stuffing, or from buggy or overly aggressive clients. By capping how often a user, IP address, or API key can make requests, it preserves availability, ensures fair access to shared resources, and helps control infrastructure costs.";

const CONTACT_JSON = '```json\n{\n  "name": "Sara Haddad",\n  "email": "sara.haddad@example.com"\n}\n```';

export const SPECIMENS: Specimen[] = [
  {
    id: "idempotency",
    label: "Explain a concept",
    at: "2026-11-13T21:15:57Z",
    requestId: "ce4471b8",
    prompt: "In two sentences, explain idempotency in APIs.",
    inTokens: 39,
    primary: { reply: { kind: "text", text: IDEMPOTENCY_OPUS }, latencyMs: 1696, costUsd: 0.002216, outTokens: 103 },
    shadow: [
      {
        model: "claude-sonnet-5-5",
        reply: {
          kind: "text",
          text: "Idempotency in APIs means that making the same request multiple times produces the same result on the server as making it once, so retries won't cause unintended side effects like duplicate charges or records. For example, HTTP methods like GET, PUT, and DELETE are designed to be idempotent, while POST typically isn't unless you add an mechanism such as an idempotency key.",
        },
        latencyMs: 1915,
        costUsd: 0.001228,
        outTokens: 115,
        judge: {
          primary: 9,
          candidate: 8,
          reason: "Both are accurate two-sentence answers, but B contains a grammatical error ('an mechanism') while A is clean and precise.",
          candidateShownFirst: false,
        },
        pass: true,
      },
      {
        model: "claude-haiku-5-5",
        reply: {
          kind: "text",
          text: "An API operation is idempotent if making the same request multiple times produces the same effect on the server as making it once, so repeated calls don't cause extra side effects. This property is important for safely retrying requests after network failures; for example, a PUT that sets a resource to a specific value is idempotent, while a POST that creates a new record usually is not unless an idempotency key is used.",
        },
        latencyMs: 1171,
        costUsd: 0.0000619,
        outTokens: 116,
        judge: {
          primary: 9,
          candidate: 9,
          reason: "Both are accurate, two-sentence explanations with equivalent examples and caveats about idempotency keys.",
          candidateShownFirst: false,
        },
        pass: true,
      },
    ],
  },
  {
    id: "rate-limiting",
    label: "Follow an instruction",
    at: "2026-11-13T21:23:42Z",
    requestId: "c51744e2",
    prompt: "In two sentences, explain what rate limiting protects against.",
    inTokens: 40,
    primary: { reply: { kind: "text", text: RATE_LIMIT_OPUS }, latencyMs: 2051, costUsd: 0.0028, outTokens: 132 },
    shadow: [
      {
        model: "claude-sonnet-5-5",
        reply: {
          kind: "text",
          text: "Rate limiting protects against abuse and overload by capping how many requests a client can make in a given time, defending against threats like denial-of-service attacks, brute-force login attempts, and credential stuffing. It also prevents scraping and runaway clients from exhausting shared resources, keeping a service available, fair, and cost-controlled for legitimate users.",
        },
        latencyMs: 1986,
        costUsd: 0.00122,
        outTokens: 114,
        judge: {
          primary: 6,
          candidate: 9,
          reason: "Response B follows the two-sentence constraint while covering the key points; Response A uses three sentences, violating the instruction.",
          candidateShownFirst: false,
        },
        pass: true,
      },
      {
        model: "claude-haiku-5-5",
        reply: {
          kind: "text",
          text: "Rate limiting protects services from being overwhelmed by too many requests, whether from abusive actors (such as brute-force login attempts, scraping, or denial-of-service attacks) or from accidental overuse like runaway scripts or buggy clients. By capping how many requests a client can make in a given time window, it helps keep systems stable, preserve resources for legitimate users, and control costs.",
        },
        latencyMs: 1110,
        costUsd: 0.000067,
        outTokens: 126,
        judge: {
          primary: 5,
          candidate: 9,
          reason: "Response A follows the two-sentence constraint while giving accurate and complete content, whereas Response B uses three sentences and so breaks the instruction.",
          candidateShownFirst: true,
        },
        pass: true,
      },
    ],
  },
  {
    id: "json",
    label: "Extract JSON",
    at: "2026-11-14T18:13:57Z",
    requestId: "ba722c16",
    prompt: 'Extract the contact as JSON with keys name and email: "Hi, this is Sara Haddad, reach me at sara.haddad@example.com about the renewal."',
    inTokens: 74,
    primary: { reply: { kind: "text", text: CONTACT_JSON }, latencyMs: 1330, costUsd: 0.001116, outTokens: 41 },
    shadow: [
      {
        model: "claude-sonnet-5-5",
        reply: { kind: "text", text: CONTACT_JSON },
        latencyMs: 1159,
        costUsd: 0.000558,
        outTokens: 41,
        judge: {
          primary: 10,
          candidate: 10,
          reason: "Both responses are identical and correctly extract the name and email as JSON.",
          candidateShownFirst: false,
        },
        pass: true,
        check: "Same JSON keys and values",
      },
      {
        model: "claude-haiku-5-5",
        reply: { kind: "text", text: CONTACT_JSON },
        latencyMs: 619,
        costUsd: 0.0000279,
        outTokens: 41,
        judge: {
          primary: 10,
          candidate: 10,
          reason: "Both responses are identical and correctly extract the name and email as JSON.",
          candidateShownFirst: false,
        },
        pass: true,
        check: "Same JSON keys and values",
      },
    ],
  },
  {
    id: "tool",
    label: "Call a tool",
    at: "2026-11-14T18:18:41Z",
    requestId: "4dde9625",
    prompt: "What's the weather like in Nairobi right now?",
    inTokens: 424,
    primary: { reply: { kind: "tool", name: "get_weather", args: '{"city":"Nairobi"}' }, latencyMs: 1115, costUsd: 0.002736, outTokens: 52 },
    shadow: [
      {
        model: "claude-sonnet-5-5",
        reply: { kind: "tool", name: "get_weather", args: '{"city":"Nairobi","unit":"celsius"}' },
        latencyMs: 1298,
        costUsd: 0.001608,
        outTokens: 76,
        judge: {
          primary: 8,
          candidate: 8,
          reason:
            "Both responses call the right tool with the correct city; the optional celsius unit in B is a minor, reasonable addition that neither helps nor hurts meaningfully.",
          candidateShownFirst: false,
        },
        pass: true,
        check: "Same tool, one extra argument",
      },
      {
        model: "claude-haiku-5-5",
        reply: { kind: "tool", name: "get_weather", args: '{"city":"Nairobi"}' },
        latencyMs: 700,
        costUsd: 0.0000684,
        outTokens: 52,
        judge: {
          primary: 8,
          candidate: 8,
          reason: "Both responses make the same appropriate get_weather tool call with the correct city argument.",
          candidateShownFirst: false,
        },
        pass: true,
        check: "Same tool, same arguments",
      },
    ],
  },
];

/** Scorecards from GET /api/shadow/summary on the hosted gateway, 14 Nov 2026. */
export const HOSTED_SCORECARD = {
  compared: 248,
  minSamples: 30,
  rows: [
    { model: "claude-sonnet-5-5", passes: 248, lowerBound: 0.985, savingsPct: 54.5, judge: 9.4, judgePrimary: 9.2, p50: 1137 },
    { model: "claude-haiku-5-5", passes: 248, lowerBound: 0.985, savingsPct: 97.8, judge: 9.4, judgePrimary: 9.3, p50: 775 },
  ],
  primaryP50: 1163,
} as const;

/**
 * Per-million-token prices the hosted gateway charged. A least-squares fit of cost against input and
 * output tokens over its 490 records reproduces every record's cost exactly; they match the
 * pricing block in deploy/gateway-claude.json.
 */
export interface Price {
  model: string;
  input: number;
  output: number;
}

export const HOSTED_PRICES: Price[] = [
  { model: "claude-opus-5-5", input: 4, output: 20 },
  { model: "claude-sonnet-5-5", input: 2, output: 10 },
  { model: "claude-haiku-5-5", input: 0.1, output: 0.5 },
];

/**
 * The judge call, calibrated to the hosted gateway: its prompt is the rubric plus the request and both
 * answers, and its reply is a short JSON verdict. With these constants the model reproduces the mean
 * judge cost over the 490 records ($0.0024 per comparison).
 */
export const JUDGE_RUBRIC_TOKENS = 200;
export const JUDGE_REPLY_TOKENS = 50;
