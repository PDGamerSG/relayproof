/**
 * Links and facts the whole site shares.
 * REPO_URL is the one value to change when the project moves to its public repository.
 */

export const REPO_URL = "https://github.com/PDGamerSG/relayproof";
const TREE = `${REPO_URL}/tree/main/bifrost-shadow`;
const BLOB = `${REPO_URL}/blob/main/bifrost-shadow`;

export const LINKS = {
  repo: TREE,
  readme: `${BLOB}/README.md`,
  docs: `${BLOB}/docs/features/shadow-traffic.mdx`,
  architecture: `${BLOB}/ARCHITECTURE.md`,
  testing: `${BLOB}/TESTING.md`,
  demo: `${TREE}/examples/shadow-demo`,
  bifrost: "https://github.com/maximhq/bifrost",
} as const;

export const PINNED_COMMIT = "ed62e4b";

export const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#scorecard", label: "Scorecard" },
  { href: "#evidence", label: "Evidence" },
  { href: "#guards", label: "Guards" },
  { href: "#start", label: "Quick start" },
] as const;
