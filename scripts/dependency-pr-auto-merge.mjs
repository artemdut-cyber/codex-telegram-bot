import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  checksPassed,
  filesAllowed,
  trustedUpdate,
  unchangedSnapshot,
} from "./dependency-pr-policy.mjs";

const execute = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

export function mergeDependencies({ repo, run = execute, logger = console }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || ""))
    throw new Error("REPO must be owner/repository.");
  const gh = (...args) => run("gh", args);
  const api = (endpoint) => JSON.parse(gh("api", endpoint));
  const pages = (endpoint) =>
    JSON.parse(gh("api", "--paginate", "--slurp", endpoint));
  const repository = api(`repos/${repo}`);
  if (repository.full_name !== repo)
    throw new Error("Repository identity mismatch.");
  const prs = JSON.parse(
    gh(
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--base",
      "main",
      "--limit",
      "100",
      "--json",
      "number",
    ),
  );
  for (const { number } of prs) {
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error("Invalid PR number.");
    const snapshot = api(`repos/${repo}/pulls/${number}`);
    const source = trustedUpdate(snapshot, repository);
    if (!source) {
      logger.log(`Skipping PR #${number}: untrusted source.`);
      continue;
    }
    const sha = snapshot.head.sha;
    try {
      // Only trusted main is checked out. Read candidate files as data at exact
      // immutable commits; do not checkout or execute code from the PR.
      run("git", ["fetch", "--no-tags", "origin", snapshot.base.sha, sha]);
      const base = run("git", ["merge-base", snapshot.base.sha, sha]).trim();
      const fields = run("git", [
        "diff",
        "--no-renames",
        "--name-status",
        "-z",
        base,
        sha,
      ]).split("\0");
      fields.pop();
      const files = [];
      for (let i = 0; i < fields.length; i += 2)
        files.push({ status: fields[i], path: fields[i + 1] });
      const content = (side, file) =>
        run("git", ["show", `${side === "base" ? base : sha}:${file}`]);
      if (!filesAllowed(files, source, content)) {
        logger.log(`Skipping PR #${number}: changes require manual review.`);
        continue;
      }
      const checks = pages(
        `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`,
      ).flatMap((page) => page.check_runs);
      const statuses = pages(
        `repos/${repo}/commits/${sha}/status?per_page=100`,
      ).flatMap((page) => page.statuses);
      if (!checksPassed(checks, statuses, sha)) {
        logger.log(
          `Skipping PR #${number}: required CI is missing or unsuccessful.`,
        );
        continue;
      }
      const current = api(`repos/${repo}/pulls/${number}`);
      if (
        !unchangedSnapshot(snapshot, current, repository) ||
        current.mergeable_state !== "clean"
      ) {
        logger.log(
          `Skipping PR #${number}: head/base changed or merge is blocked.`,
        );
        continue;
      }
      gh(
        "pr",
        "merge",
        String(number),
        "--repo",
        repo,
        "--squash",
        "--delete-branch",
        "--match-head-commit",
        sha,
        "--subject",
        current.title,
        "--body",
        "Automatically merged after dependency policy and required CI passed for the exact head commit.",
      );
      const merged = api(`repos/${repo}/pulls/${number}`);
      if (!merged.merged || merged.head.sha !== sha)
        throw new Error(
          "GitHub did not confirm the inspected head was merged.",
        );
      logger.log(`Merged PR #${number} at ${sha}.`);
    } catch (error) {
      throw new Error(
        `Dependency PR #${number} could not be safely processed.`,
        { cause: error },
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  mergeDependencies({ repo: process.env.REPO });
