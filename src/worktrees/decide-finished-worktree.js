/** @module worktrees/decide-finished-worktree Pure decision of whether a worktree's work has ended. */
import { FINISHED_REASONS, PULL_REQUEST_STATES, UNFINISHED_REASONS } from "./constants.js";

/**
 * @typedef {"pull-request-merged" | "pull-request-closed" | "in-default-branch"} FinishedReason
 * @typedef {"main-worktree" | "locked" | "recently-active" | "activity-unknown" | "open-pull-request" |
 *   "no-own-commits" | "work-not-integrated"} UnfinishedReason
 */

/**
 * @typedef {object} PullRequestSummary
 * @property {number} number - Pull request number.
 * @property {"OPEN" | "MERGED" | "CLOSED"} state - State as `gh` reports it.
 * @property {boolean | null} containsHead - Whether the worktree's HEAD is the pull request's last commit or one of
 * its ancestors, so every commit of the worktree is in the pull request; `null` when it could not be checked.
 */

/**
 * @typedef {object} FinishedWorktreeInput
 * @property {boolean} isMain - Whether it is the main worktree.
 * @property {boolean} locked - Whether `git worktree lock` protects it.
 * @property {string} head - Commit the worktree's HEAD points to.
 * @property {string | null} startCommit - Commit the worktree started at (its oldest HEAD reflog entry), or `null`
 * when the reflog is empty.
 * @property {number | null} lastActivityMs - Time of the newest HEAD reflog entry, or `null` when unknown.
 * @property {number} nowMs - Current time.
 * @property {number} gracePeriodMs - Idle time required before closing it.
 * @property {boolean | null} headInDefaultBranch - Whether HEAD is in the remote default branch, or `null` when that
 * could not be checked.
 * @property {PullRequestSummary[] | null} pullRequests - Pull requests of its branch, newest first; empty for a
 * detached HEAD or a branch without pull requests, `null` when they could not be read.
 */

/**
 * @typedef {{ finished: true, reason: FinishedReason } | { finished: false, reason: UnfinishedReason }}
 *   FinishedWorktreeDecision
 */

/**
 * Decides whether the work of a linked worktree has ended, so its folder can be closed. Work has ended when every
 * commit of the worktree is in the remote default branch (a merge or a direct push), or when the newest pull request
 * of its branch was merged or closed and holds every commit of the worktree. Each guard errs on the side of keeping
 * it: the main and locked worktrees, a worktree touched within the grace period, one with an open pull request, one
 * whose HEAD never moved since it was created (a worktree just made for new work, even on a branch whose pull request
 * already ended) and anything that could not be checked. Uncommitted changes are guarded later, by the removal itself.
 * @param {FinishedWorktreeInput} input - What is known about the worktree.
 * @returns {FinishedWorktreeDecision} Whether it is finished, and why.
 */
export function decideFinishedWorktree({
  isMain,
  locked,
  head,
  startCommit,
  lastActivityMs,
  nowMs,
  gracePeriodMs,
  headInDefaultBranch,
  pullRequests,
}) {
  if (isMain) return { finished: false, reason: UNFINISHED_REASONS.MAIN_WORKTREE };
  if (locked) return { finished: false, reason: UNFINISHED_REASONS.LOCKED };
  if (lastActivityMs === null) return { finished: false, reason: UNFINISHED_REASONS.ACTIVITY_UNKNOWN };
  if (nowMs - lastActivityMs < gracePeriodMs) return { finished: false, reason: UNFINISHED_REASONS.RECENTLY_ACTIVE };
  if (pullRequests?.some((pullRequest) => pullRequest.state === PULL_REQUEST_STATES.OPEN)) {
    return { finished: false, reason: UNFINISHED_REASONS.OPEN_PULL_REQUEST };
  }

  // A worktree whose HEAD never moved starts at a commit that is already in the default branch or in its branch's
  // pull request (checking out a branch whose pull request already ended); that says nothing about its work being done.
  const hasOwnCommits = startCommit !== null && startCommit !== head;
  if (!hasOwnCommits) return { finished: false, reason: UNFINISHED_REASONS.NO_OWN_COMMITS };
  if (headInDefaultBranch) return { finished: true, reason: FINISHED_REASONS.IN_DEFAULT_BRANCH };

  const [newestPullRequest] = pullRequests ?? [];
  if (newestPullRequest?.containsHead) {
    if (newestPullRequest.state === PULL_REQUEST_STATES.MERGED) {
      return { finished: true, reason: FINISHED_REASONS.PULL_REQUEST_MERGED };
    }
    if (newestPullRequest.state === PULL_REQUEST_STATES.CLOSED) {
      return { finished: true, reason: FINISHED_REASONS.PULL_REQUEST_CLOSED };
    }
  }

  return { finished: false, reason: UNFINISHED_REASONS.WORK_NOT_INTEGRATED };
}
