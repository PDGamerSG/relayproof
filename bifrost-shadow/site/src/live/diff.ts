/**
 * Word-level diff for two short answers: a longest common subsequence over
 * word, space and punctuation tokens. Answers in the shadow records are short
 * (a few hundred tokens), so the quadratic table stays small; past the cap the
 * diff is skipped rather than slowing the page.
 */

export interface Segment {
  text: string;
  kind: "same" | "add" | "del";
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const CAP = 900;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Segments that turn `before` into `after`; undefined when either side is too long. */
export function wordDiff(before: string, after: string): Segment[] | undefined {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > CAP || b.length > CAP) return undefined;
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:], flattened.
  const lcs = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const out: Segment[] = [];
  const push = (text: string, kind: Segment["kind"]) => {
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], "same");
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
      push(a[i++], "del");
    } else {
      push(b[j++], "add");
    }
  }
  while (i < n) push(a[i++], "del");
  while (j < m) push(b[j++], "add");
  return out;
}
