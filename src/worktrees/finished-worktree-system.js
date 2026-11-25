/**
 * @module worktrees/finished-worktree-system Reads, through git and the GitHub CLI, what tells whether a worktree's
 * work has ended.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_BRANCH_FALLBACK_REFS,
  GIT_COMMAND_MAX_BUFFER_BYTES,
  NETWORK_COMMAND_TIMEOUT_MS,
  PULL_REQUEST_LOOKUP_LIMIT,
} from "./constants.js";
import { runGit } from "./git-worktree-system.js";

/**
 * @typedef {object} PullRequestRecord
 * @property {number} number - Pull request number.
 * @property {"OPEN" | "MERGED" | "CLOSED"} state - State as `gh` reports it.
 * @property {string} headRefOid - Last commit of the pull request.
 */

/**
 * @typedef {object} FinishedWorktreeSystem
 * @property {(mainWorktreePath: string) => Promise<void>} fetchRemote - Updates the remote-tracking refs of `origin`.
 * @property {(mainWorktreePath: string) => Promise<string | null>} findDefaultBranchRef - Remote-tracking ref of the
 * default branch (`origin/main`), or `null` when the repository has none.
 * @property {(worktreePath: string) => Promise<{ head: string, branch: string | null }>} readHead - Commit and branch
 * of the worktree's HEAD; `branch` is `null` for a detached HEAD.
 * @property {(worktreePath: string) => Promise<{ startCommit: string | null, lastActivityMs: number | null }>}
 * readHeadReflog - Oldest commit and time of the newest entry of the worktree's own HEAD reflog.
 * @property {(folderPath: string, ancestor: string, descendant: string) => Promise<boolean>} isAncestor - Whether a
 * commit is the other one or one of its ancestors; throws when git cannot tell (for example, an unknown commit).
 * @property {(mainWorktreePath: string, branch: string) => Promise<PullRequestRecord[]>} listPullRequests - Pull
 * requests whose head is the branch, in any state; throws when `gh` is missing or fails.
 */

const execFileAsync = promisify(execFile);

/** Exit code of `git merge-base --is-ancestor` when the commit is not an ancestor. */
const NOT_AN_ANCESTOR_EXIT_CODE = 1;

/** Matches the time that `--date=unix` puts in a reflog selector, as in `HEAD@{1732550400}`. */
const REFLOG_TIME_PATTERN = /@\{(\d+)\}$/u;

/** @type {FinishedWorktreeSystem} */
export const gitFinishedWorktreeSystem = {
  async fetchRemote(mainWorktreePath) {
    await runGit(mainWorktreePath, ["fetch", "--prune", "--quiet", "origin"], NETWORK_COMMAND_TIMEOUT_MS);
  },
  async findDefaultBranchRef(mainWorktreePath) {
    for (const candidate of ["origin/HEAD", ...DEFAULT_BRANCH_FALLBACK_REFS]) {
      try {
        const resolvedRef = (await runGit(mainWorktreePath, ["rev-parse", "--abbrev-ref", candidate])).trim();
        // `origin/HEAD` resolves to the branch it points to; a missing ref fails and the next candidate is tried.
        if (resolvedRef && resolvedRef !== "origin/HEAD") return resolvedRef;
      } catch {
        // The candidate does not exist in this repository; the next one may.
      }
    }
    return null;
  },
  async readHead(worktreePath) {
    const head = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();
    try {
      const branch = (await runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      return { head, branch: branch || null };
    } catch {
      // `symbolic-ref` fails on a detached HEAD, which has no branch.
      return { head, branch: null };
    }
  },
  async readHeadReflog(worktreePath) {
    // A linked worktree keeps its own HEAD reflog, so its entries describe only the work done in that folder.
    const reflogOutput = await runGit(worktreePath, ["reflog", "show", "--date=unix", "--format=%H %gd", "HEAD"]);
    const entries = reflogOutput.split("\n").filter((line) => line.trim().length > 0);
    if (entries.length === 0) return { startCommit: null, lastActivityMs: null };
    const [newestCommitAndSelector] = entries;
    const oldestCommitAndSelector = entries[entries.length - 1];
    const timeMatch = REFLOG_TIME_PATTERN.exec(newestCommitAndSelector.trim());
    return {
      startCommit: oldestCommitAndSelector.split(" ")[0],
      lastActivityMs: timeMatch ? Number(timeMatch[1]) * 1000 : null,
    };
  },
  async isAncestor(folderPath, ancestor, descendant) {
    try {
      await runGit(folderPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === NOT_AN_ANCESTOR_EXIT_CODE) return false;
      throw error;
    }
  },
  async listPullRequests(mainWorktreePath, branch) {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        String(PULL_REQUEST_LOOKUP_LIMIT),
        "--json",
        "number,state,headRefOid",
      ],
      {
        cwd: mainWorktreePath,
        maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
        timeout: NETWORK_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const pullRequests = JSON.parse(stdout);
    return Array.isArray(pullRequests) ? pullRequests : [];
  },
};
