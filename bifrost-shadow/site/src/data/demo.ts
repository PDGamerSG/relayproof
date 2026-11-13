/**
 * Numbers from the key-free demo (examples/shadow-demo): 300 mixed requests through a real
 * Bifrost gateway against a deterministic mock upstream. Scorecard rows are the run printed in
 * the project README; the disagreement records use the demo dataset's prompts and answers.
 */

import type { Verdict } from "../lib/stats";

export const EXPERIMENT = "gpt-4o cost-down";
export const SOURCE = "openai/gpt-4o";

export interface Candidate {
  id: string;
  model: string;
  short: string;
  samples: number;
  passes: number;
  errors: number;
  agreement: number;
  lowerBound: number;
  errorRate: number;
  judgePrimary: number;
  judgeCandidate: number;
  p50Primary: number;
  p50Candidate: number;
  savingsPct: number;
  savingsPerMillion: number;
  verdict: Verdict;
  reason: string;
}

export const CANDIDATES: Candidate[] = [
  {
    id: "mini",
    model: "openai/gpt-4o-mini",
    short: "gpt-4o-mini",
    samples: 162,
    passes: 161,
    errors: 0,
    agreement: 0.994,
    lowerBound: 0.966,
    errorRate: 0,
    judgePrimary: 9.0,
    judgeCandidate: 9.0,
    p50Primary: 918,
    p50Candidate: 339,
    savingsPct: 97.2,
    savingsPerMillion: 294,
    verdict: "ready",
    reason: "agreement 99.4% (95% lower bound 96.6%) clears 90%",
  },
  {
    id: "llama",
    model: "openai/llama-3.1-8b",
    short: "llama-3.1-8b",
    samples: 162,
    passes: 102,
    errors: 7,
    agreement: 0.63,
    lowerBound: 0.553,
    errorRate: 0.043,
    judgePrimary: 9.0,
    judgeCandidate: 6.6,
    p50Primary: 900,
    p50Candidate: 195,
    savingsPct: 99.3,
    savingsPerMillion: 300,
    verdict: "not_ready",
    reason: "agreement 63.0% is below 90%",
  },
];

export interface Answer {
  text: string;
  /** Latency and token counts, where the record was captured from a real demo run. */
  meta?: string;
}

export interface Disagreement {
  id: string;
  kind: string;
  prompt: string;
  primary: Answer;
  candidate: Answer;
  /** What decided the record. */
  basis: "judge" | "error";
  scores?: { primary: number; candidate: number };
  shownAs?: "A" | "B";
  reason: string;
  metrics: { label: string; value: string }[];
}

/**
 * The first llama record is copied from a demo run (the dashboard screenshot in docs/media).
 * The others pair a dataset prompt with the answers the mock models give for it and the
 * score the mock judge assigns; they carry no timings because none were recorded.
 */
export const DISAGREEMENTS: Record<string, Disagreement[]> = {
  llama: [
    {
      id: "write-05",
      kind: "Writing",
      prompt: "In two sentences, explain what rate limiting protects against.",
      primary: {
        text: "Rate limiting caps how many requests a client can make, protecting the service from overload and abuse. In practice this keeps systems predictable and efficient under real-world load.",
        meta: "319 ms, 32 tokens in, 39 out",
      },
      candidate: {
        text: "Rate limiting is used to compress responses.",
        meta: "48 ms, 32 tokens in, 11 out",
      },
      basis: "judge",
      scores: { primary: 9, candidate: 2 },
      shownAs: "B",
      reason: "response B is incorrect or malformed",
      metrics: [
        { label: "Lexical similarity", value: "11.1%" },
        { label: "Semantic similarity", value: "44.7%" },
        { label: "Length ratio", value: "0.24" },
        { label: "Finish reason", value: "Match" },
      ],
    },
    {
      id: "json-03",
      kind: "JSON mode",
      prompt:
        'Extract the contact as JSON with keys name and email: "Hi, this is Lucas Martin, reach me at lucas.martin@example.net about the renewal."',
      primary: {
        text: '{"name": "Lucas Martin", "email": "lucas.martin@example.net"}',
      },
      candidate: {
        text: "Sure! The contact is Lucas Martin and their email is lucas.martin@example.net.",
      },
      basis: "judge",
      scores: { primary: 9, candidate: 4 },
      shownAs: "A",
      reason: "response A is incorrect or malformed",
      metrics: [
        { label: "JSON structure", value: "No match" },
        { label: "Finish reason", value: "Match" },
      ],
    },
    {
      id: "tool-05",
      kind: "Tool call",
      prompt: "What's the weather like in Berlin right now?",
      primary: {
        text: 'get_weather({"city": "Berlin", "unit": "celsius"})',
      },
      candidate: {
        text: "No answer: the candidate's provider returned HTTP 503.",
      },
      basis: "error",
      reason: "A candidate error is a failure, and it counts against the error budget.",
      metrics: [{ label: "Candidate error", value: "HTTP 503" }],
    },
  ],
  mini: [
    {
      id: "qa-fact-06",
      kind: "Short answer",
      prompt: "What is the boiling point of water at sea level in Celsius?",
      primary: {
        text: "The answer is 100. Let me know if you would like more context or a source.",
      },
      candidate: {
        text: "90.",
      },
      basis: "judge",
      scores: { primary: 9, candidate: 2 },
      shownAs: "A",
      reason: "response A is incorrect or malformed",
      metrics: [{ label: "Finish reason", value: "Match" }],
    },
  ],
};

/** Request-path overhead: `go test -bench . -benchmem -count=5` in plugins/shadow, medians. */
export const OVERHEAD = [
  { path: "Request that matches no experiment", ns: 68, allocs: 0 },
  { path: "Matches, not sampled", ns: 99, allocs: 0 },
  { path: "Matches, not sampled, every core at once", ns: 54, allocs: 0 },
  { path: "Not sampled while a sampled request is in flight", ns: 160, allocs: 0 },
  { path: "The plugin's own work per streamed chunk", ns: 0.4, allocs: 0 },
  { path: "Sampled request: snapshot and hand-off", ns: 9600, allocs: 33 },
];
