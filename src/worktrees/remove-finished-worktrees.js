/**
 * @module worktrees/remove-finished-worktrees Closes the linked worktrees of a repository whose work has ended: their
 * pull request was merged or closed, or their commits reached the default branch.
 */
import process from "node:process";
import { FINISHED_REASONS, FINISHED_WORKTREE_GRACE_PERIOD_MS, UNFINISHED_REASONS, WORKTREES_LOG_PREFIX } from "./constants.js";
import { decideFinishedWorktree } from "./decide-finished-worktree.js";
import { gitFinishedWorktreeSystem } from "./finished-worktree-system.js";
import { gitWorktreeSystem } from "./git-worktree-system.js";
import { removeWorktrees } from "./remove-worktrees.js";

/** @typedef {import("./git-worktree-system.js").WorktreeSystem} WorktreeSystem */
/** @typedef {import("./finished-worktree-system.js").FinishedWorktreeSystem} FinishedWorktreeSystem */
/** @typedef {import("./decide-finished-worktree.js").FinishedReason} FinishedReason */
/** @typedef {import("./decide-finished-worktree.js").UnfinishedReason} UnfinishedReason */
/** @typedef {import("./decide-finished-worktree.js").PullRequestSummary} PullRequestSummary */
/** @typedef {import("./remove-worktrees.js").WorktreeRemovalResult} WorktreeRemovalResult */

/**
 * @typedef {object} FinishedWorktreesResult
 * @property {{ path: string, reason: FinishedReason }[]} finished - Worktrees whose work ended, handed to the removal.
 * @property {{ path: string, reason: UnfinishedReason }[]} kept - Worktrees still in use, or that could not be checked.
 * @property {WorktreeRemovalResult} removal - Outcome of removing the finished ones, with its own guards (uncommitted
 * changes, the current directory).
 */

/**
 * @typedef {object} FinishedWorktreesOptions
 * @property {string} [repositoryPath] - Any folder of the repository; defaults to the current directory.
 * @property {boolean} [dryRun] - Report what would be closed without closing it.
 * @property {number} [gracePeriodMs] - Idle time required before closing a worktree.
 * @property {() => number} [now] - Current time; replaceable for tests.
 * @property {string} [currentDirectory] - Working directory, which is never removed; defaults to the current one.
 * @property {string} [platform] - Platform name; defaults to the current one.
 * @property {WorktreeSystem} [system] - Git and file system access for listing and removing worktrees.
 * @property {FinishedWorktreeSystem} [finishedSystem] - Git and GitHub access for telling whether work ended.
 * @property {(message: string) => void} [log] - Receives informational messages.
 * @property {(message: string) => void} [warn] - Receives failures.
 */

/** Explains why each worktree counts as finished. */
const FINISHED_EXPLANATIONS = {
  [FINISHED_REASONS.PULL_REQUEST_MERGED]: "its pull request was merged",
  [FINISHED_REASONS.PULL_REQUEST_CLOSED]: "its pull request was closed",
  [FINISHED_REASONS.IN_DEFAULT_BRANCH]: "its commits are in the default branch",
};

/** Explains why each worktree is kept. */
const UNFINISHED_EXPLANATIONS = {
  [UNFINISHED_REASONS.MAIN_WORKTREE]: "it is the main worktree",
  [UNFINISHED_REASONS.LOCKED]: "it is locked",
  [UNFINISHED_REASONS.RECENTLY_ACTIVE]: "it was used recently",
  [UNFINISHED_REASONS.ACTIVITY_UNKNOWN]: "its HEAD reflog is empty, so its last use is unknown",
  [UNFINISHED_REASONS.OPEN_PULL_REQUEST]: "its pull request is open",
  [UNFINISHED_REASONS.NO_OWN_COMMITS]: "it has no commits of its own yet",
  [UNFINISHED_REASONS.WORK_NOT_INTEGRATED]: "its work is neither in the default branch nor in a finished pull request",
};

/**
 * Turns a caught value into a one-line reason, with its error code when there is one.
 * @param {unknown} error - Caught value.
 * @returns {string} Its code and message.
 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const errorCode = "code" in error && error.code ? String(error.code) : undefined;
  return errorCode && !error.message.includes(errorCode) ? `${errorCode}: ${error.message}` : error.message;
}

/**
 * Tells whether a commit is an ancestor of another, or `null` when git cannot tell.
 * @param {FinishedWorktreeSystem} finishedSystem - Git access.
 * @param {string} folderPath - Folder git runs in.
 * @param {string} ancestor - Possible ancestor.
 * @param {string} descendant - Possible descendant.
 * @returns {Promise<boolean | null>} The answer, or `null` when unknown.
 */
async function tryIsAncestor(finishedSystem, folderPath, ancestor, descendant) {
  try {
    return await finishedSystem.isAncestor(folderPath, ancestor, descendant);
  } catch {
    // An unknown commit (a pull request head never fetched) leaves the answer open; the decision keeps the worktree.
    return null;
  }
}

/**
 * Closes the linked worktrees of a repository whose work has ended: the newest pull request of their branch was
 * merged or closed and holds all their commits, or their commits reached the remote default branch (a direct push).
 * It first fetches `origin` so the answer is current, and asks `gh` for pull requests; when either fails it warns and
 * decides with what it knows, which only keeps more worktrees. The finished ones go through the regular removal, so a
 * worktree with uncommitted changes or the current directory is still kept. The branch and its commits stay. Never
 * throws.
 * @param {FinishedWorktreesOptions} [options] - Repository and how.
 * @returns {Promise<FinishedWorktreesResult>} What was closed and kept.
 */
export async function removeFinishedWorktrees({
  repositoryPath = process.cwd(),
  dryRun = false,
  gracePeriodMs = FINISHED_WORKTREE_GRACE_PERIOD_MS,
  now = Date.now,
  currentDirectory = process.cwd(),
  platform = process.platform,
  system = gitWorktreeSystem,
  finishedSystem = gitFinishedWorktreeSystem,
  log = console.log,
  warn = console.warn,
} = {}) {
  /** @type {FinishedWorktreesResult} */
  const result = { finished: [], kept: [], removal: { removedPaths: [], refused: [], failed: [] } };

  /** @type {import("./decide-worktree-removal.js").WorktreeEntry[]} */
  let worktrees;
  try {
    // Git prints forward slashes on Windows; the canonical path matches what the removal reports and compares.
    worktrees = (await system.listWorktrees(repositoryPath)).map((worktree) => ({
      ...worktree,
      path: system.toCanonicalPath(worktree.path),
    }));
  } catch (error) {
    warn(`${WORKTREES_LOG_PREFIX} listWorktrees failed in ${repositoryPath}: ${describeError(error)}.`);
    return result;
  }
  const mainWorktree = worktrees.find((worktree) => worktree.isMain);
  const linkedWorktrees = worktrees.filter((worktree) => !worktree.isMain);
  if (!mainWorktree || linkedWorktrees.length === 0) return result;

  try {
    await finishedSystem.fetchRemote(mainWorktree.path);
  } catch (error) {
    warn(`${WORKTREES_LOG_PREFIX} fetchRemote failed in ${mainWorktree.path}: ${describeError(error)}. Deciding with the refs already fetched.`);
  }
  const defaultBranchRef = await finishedSystem.findDefaultBranchRef(mainWorktree.path);
  let pullRequestLookupFailed = false;

  for (const worktree of linkedWorktrees) {
    if (!system.folderExists(worktree.path)) {
      // A record without a folder holds no work; `git worktree prune` drops it, and the removal of a finished worktree
      // runs that prune too.
      log(`${WORKTREES_LOG_PREFIX} Skipped ${worktree.path}: its folder no longer exists; run \`git worktree prune\` to drop the record.`);
      continue;
    }
    let head;
    let branch;
    let startCommit;
    let lastActivityMs;
    try {
      ({ head, branch } = await finishedSystem.readHead(worktree.path));
      ({ startCommit, lastActivityMs } = await finishedSystem.readHeadReflog(worktree.path));
    } catch (error) {
      warn(`${WORKTREES_LOG_PREFIX} readHead failed for ${worktree.path}: ${describeError(error)}. Kept it.`);
      result.kept.push({ path: worktree.path, reason: UNFINISHED_REASONS.ACTIVITY_UNKNOWN });
      continue;
    }

    const headInDefaultBranch = defaultBranchRef
      ? await tryIsAncestor(finishedSystem, worktree.path, head, defaultBranchRef)
      : null;

    /** @type {PullRequestSummary[] | null} */
    let pullRequests = [];
    if (branch) {
      try {
        const records = await finishedSystem.listPullRequests(mainWorktree.path, branch);
        const newestFirst = [...records].sort((left, right) => right.number - left.number);
        pullRequests = await Promise.all(
          newestFirst.map(async (record) => ({
            number: record.number,
            state: record.state,
            containsHead:
              record.headRefOid === head ? true : await tryIsAncestor(finishedSystem, worktree.path, head, record.headRefOid),
          })),
        );
      } catch (error) {
        pullRequests = null;
        if (!pullRequestLookupFailed) {
          warn(`${WORKTREES_LOG_PREFIX} listPullRequests failed in ${mainWorktree.path}: ${describeError(error)}. Only worktrees whose commits are in the default branch are closed.`);
          pullRequestLookupFailed = true;
        }
      }
    }

    const decision = decideFinishedWorktree({
      isMain: worktree.isMain,
      locked: worktree.locked,
      head,
      startCommit,
      lastActivityMs,
      nowMs: now(),
      gracePeriodMs,
      headInDefaultBranch,
      pullRequests,
    });
    if (decision.finished) {
      result.finished.push({ path: worktree.path, reason: decision.reason });
      log(`${WORKTREES_LOG_PREFIX} ${worktree.path} is finished: ${FINISHED_EXPLANATIONS[decision.reason]}.`);
    } else {
      result.kept.push({ path: worktree.path, reason: decision.reason });
      log(`${WORKTREES_LOG_PREFIX} Kept ${worktree.path}: ${UNFINISHED_EXPLANATIONS[decision.reason]}.`);
    }
  }

  if (result.finished.length > 0) {
    result.removal = await removeWorktrees({
      paths: result.finished.map((worktree) => worktree.path),
      dryRun,
      currentDirectory,
      platform,
      system,
      log,
      warn,
    });
  }
  return result;
}
