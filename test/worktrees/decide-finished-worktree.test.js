import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FINISHED_REASONS, PULL_REQUEST_STATES, UNFINISHED_REASONS } from "../../src/worktrees/constants.js";
import { decideFinishedWorktree } from "../../src/worktrees/decide-finished-worktree.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = 100 * HOUR_MS;

/** A linked worktree with one commit of its own, idle for two hours, not yet integrated anywhere. */
const IDLE_WORKTREE = {
  isMain: false,
  locked: false,
  head: "head-commit",
  startCommit: "start-commit",
  lastActivityMs: NOW_MS - 2 * HOUR_MS,
  nowMs: NOW_MS,
  gracePeriodMs: HOUR_MS / 2,
  headInDefaultBranch: false,
  pullRequests: [],
};

describe("decideFinishedWorktree", () => {
  it("finishes a worktree whose own commits reached the default branch, as a direct push does", () => {
    assert.deepEqual(decideFinishedWorktree({ ...IDLE_WORKTREE, headInDefaultBranch: true }), {
      finished: true,
      reason: FINISHED_REASONS.IN_DEFAULT_BRANCH,
    });
  });

  it("finishes a worktree whose newest pull request was merged or closed with all its commits", () => {
    const merged = { number: 7, state: PULL_REQUEST_STATES.MERGED, containsHead: true };
    const closed = { number: 7, state: PULL_REQUEST_STATES.CLOSED, containsHead: true };
    assert.deepEqual(decideFinishedWorktree({ ...IDLE_WORKTREE, pullRequests: [merged] }), {
      finished: true,
      reason: FINISHED_REASONS.PULL_REQUEST_MERGED,
    });
    assert.deepEqual(decideFinishedWorktree({ ...IDLE_WORKTREE, pullRequests: [closed] }), {
      finished: true,
      reason: FINISHED_REASONS.PULL_REQUEST_CLOSED,
    });
  });

  it("keeps a worktree with commits made after its pull request was merged", () => {
    const merged = { number: 7, state: PULL_REQUEST_STATES.MERGED, containsHead: false };
    assert.deepEqual(decideFinishedWorktree({ ...IDLE_WORKTREE, pullRequests: [merged] }), {
      finished: false,
      reason: UNFINISHED_REASONS.WORK_NOT_INTEGRATED,
    });
  });

  it("keeps a worktree whose pull request head could not be compared", () => {
    const merged = { number: 7, state: PULL_REQUEST_STATES.MERGED, containsHead: null };
    assert.equal(decideFinishedWorktree({ ...IDLE_WORKTREE, pullRequests: [merged] }).finished, false);
  });

  it("keeps a worktree with an open pull request, even when an older one was merged", () => {
    const pullRequests = [
      { number: 9, state: PULL_REQUEST_STATES.OPEN, containsHead: true },
      { number: 7, state: PULL_REQUEST_STATES.MERGED, containsHead: true },
    ];
    assert.deepEqual(decideFinishedWorktree({ ...IDLE_WORKTREE, headInDefaultBranch: true, pullRequests }), {
      finished: false,
      reason: UNFINISHED_REASONS.OPEN_PULL_REQUEST,
    });
  });

  it("keeps a worktree whose HEAD never moved, as one just created for new work", () => {
    assert.deepEqual(
      decideFinishedWorktree({ ...IDLE_WORKTREE, startCommit: "head-commit", headInDefaultBranch: true }),
      { finished: false, reason: UNFINISHED_REASONS.NO_OWN_COMMITS },
    );
  });

  it("keeps a worktree whose HEAD never moved, even on a branch whose pull request was merged or closed", () => {
    const checkedOutBranch = { ...IDLE_WORKTREE, startCommit: "head-commit" };
    for (const state of [PULL_REQUEST_STATES.MERGED, PULL_REQUEST_STATES.CLOSED]) {
      const pullRequests = [{ number: 7, state, containsHead: true }];
      assert.deepEqual(decideFinishedWorktree({ ...checkedOutBranch, pullRequests }), {
        finished: false,
        reason: UNFINISHED_REASONS.NO_OWN_COMMITS,
      });
      assert.deepEqual(decideFinishedWorktree({ ...checkedOutBranch, headInDefaultBranch: true, pullRequests }), {
        finished: false,
        reason: UNFINISHED_REASONS.NO_OWN_COMMITS,
      });
    }
  });

  it("keeps a worktree whose start is unknown, as an empty HEAD reflog leaves it", () => {
    const merged = { number: 7, state: PULL_REQUEST_STATES.MERGED, containsHead: true };
    assert.deepEqual(decideFinishedWorktree({ ...IDLE_WORKTREE, startCommit: null, pullRequests: [merged] }), {
      finished: false,
      reason: UNFINISHED_REASONS.NO_OWN_COMMITS,
    });
  });

  it("keeps a worktree used within the grace period, even when its work is merged", () => {
    const recentlyUsed = { ...IDLE_WORKTREE, lastActivityMs: NOW_MS - 60_000, headInDefaultBranch: true };
    assert.deepEqual(decideFinishedWorktree(recentlyUsed), {
      finished: false,
      reason: UNFINISHED_REASONS.RECENTLY_ACTIVE,
    });
  });

  it("keeps a worktree whose last use is unknown", () => {
    assert.deepEqual(decideFinishedWorktree({ ...IDLE_WORKTREE, lastActivityMs: null, headInDefaultBranch: true }), {
      finished: false,
      reason: UNFINISHED_REASONS.ACTIVITY_UNKNOWN,
    });
  });

  it("keeps the main and locked worktrees", () => {
    const integrated = { ...IDLE_WORKTREE, headInDefaultBranch: true };
    assert.equal(decideFinishedWorktree({ ...integrated, isMain: true }).reason, UNFINISHED_REASONS.MAIN_WORKTREE);
    assert.equal(decideFinishedWorktree({ ...integrated, locked: true }).reason, UNFINISHED_REASONS.LOCKED);
  });

  it("decides from the default branch alone when pull requests could not be read", () => {
    assert.equal(decideFinishedWorktree({ ...IDLE_WORKTREE, pullRequests: null, headInDefaultBranch: true }).finished, true);
    assert.equal(decideFinishedWorktree({ ...IDLE_WORKTREE, pullRequests: null }).finished, false);
  });
});
