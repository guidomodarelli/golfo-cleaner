import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { FINISHED_REASONS, UNFINISHED_REASONS } from "../../src/worktrees/constants.js";
import { gitFinishedWorktreeSystem } from "../../src/worktrees/finished-worktree-system.js";
import { removeFinishedWorktrees } from "../../src/worktrees/remove-finished-worktrees.js";

const execFileAsync = promisify(execFile);
/** Identity for the fixture commits, so the test does not depend on the machine's git config. */
const GIT_IDENTITY = ["-c", "user.name=golfo-cleaner test", "-c", "user.email=test@example.invalid"];
/** Far enough ahead that every fixture worktree is past the grace period. */
const LATER_MS = Date.now() + 24 * 60 * 60 * 1000;

/**
 * Runs git in a folder.
 * @param {string} folderPath - Folder git runs in.
 * @param {string[]} gitArguments - Arguments after `-C <folder>`.
 * @returns {Promise<string>} Standard output.
 */
async function git(folderPath, gitArguments) {
  const { stdout } = await execFileAsync("git", [...GIT_IDENTITY, "-C", folderPath, ...gitArguments]);
  return stdout;
}

/** Collects messages sent to `log` and `warn`. */
function createOutput() {
  /** @type {string[]} */
  const warnings = [];
  return {
    warnings,
    log: () => {},
    /** @param {string} message */
    warn: (message) => warnings.push(message),
  };
}

describe("removeFinishedWorktrees with real git", () => {
  /** @type {string} */
  let fixtureFolder;
  /** @type {string} */
  let mainPath;

  before(async () => {
    fixtureFolder = realpathSync.native(mkdtempSync(path.join(tmpdir(), "golfo-cleaner-finished-")));
    const originPath = path.join(fixtureFolder, "origin.git");
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", originPath]);
    mainPath = path.join(fixtureFolder, "app");
    await execFileAsync("git", ["clone", originPath, mainPath]);
    writeFileSync(path.join(mainPath, "README.md"), "app\n");
    await git(mainPath, ["add", "README.md"]);
    await git(mainPath, ["commit", "-m", "initial commit"]);
    await git(mainPath, ["push", "origin", "main"]);
    await git(mainPath, ["remote", "set-head", "origin", "main"]);
  });

  after(() => {
    rmSync(fixtureFolder, { recursive: true, force: true, maxRetries: 5 });
  });

  /**
   * Adds a linked worktree on its own branch from `origin/main`, optionally with one commit.
   * @param {string} name - Folder and branch name.
   * @param {"empty" | "with-commit"} contents - Whether to commit something in it.
   * @returns {Promise<string>} Worktree folder.
   */
  async function addWorktree(name, contents) {
    const worktreePath = path.join(fixtureFolder, name);
    await git(mainPath, ["worktree", "add", "-b", name, worktreePath, "origin/main"]);
    if (contents === "with-commit") {
      writeFileSync(path.join(worktreePath, `${name}.txt`), `${name}\n`);
      await git(worktreePath, ["add", "."]);
      await git(worktreePath, ["commit", "-m", name]);
    }
    return worktreePath;
  }

  it("closes the worktrees whose work ended and keeps the rest, along with every branch", async () => {
    const pushedPath = await addWorktree("pushed-to-main", "with-commit");
    await git(pushedPath, ["push", "origin", "HEAD:main"]);
    const mergedPath = await addWorktree("merged-pr", "with-commit");
    const mergedHead = (await git(mergedPath, ["rev-parse", "HEAD"])).trim();
    const openPath = await addWorktree("open-pr", "with-commit");
    const openHead = (await git(openPath, ["rev-parse", "HEAD"])).trim();
    const unpushedPath = await addWorktree("unpushed-work", "with-commit");
    const freshPath = await addWorktree("fresh", "empty");
    const dirtyPath = await addWorktree("dirty-after-push", "with-commit");
    await git(dirtyPath, ["push", "origin", "HEAD:main"]);
    writeFileSync(path.join(dirtyPath, "draft.txt"), "not committed\n");

    /** @type {Record<string, import("../../src/worktrees/finished-worktree-system.js").PullRequestRecord[]>} */
    const pullRequestsByBranch = {
      "merged-pr": [{ number: 3, state: "MERGED", headRefOid: mergedHead }],
      "open-pr": [{ number: 4, state: "OPEN", headRefOid: openHead }],
    };
    const output = createOutput();
    const result = await removeFinishedWorktrees({
      repositoryPath: mainPath,
      currentDirectory: fixtureFolder,
      now: () => LATER_MS,
      // GitHub is the only part replaced: git runs for real against the fixture repository and its bare origin.
      finishedSystem: {
        ...gitFinishedWorktreeSystem,
        listPullRequests: async (_mainWorktreePath, branch) => pullRequestsByBranch[branch] ?? [],
      },
      ...output,
    });

    assert.deepEqual(output.warnings.filter((message) => !message.includes(dirtyPath)), []);
    assert.deepEqual(
      [...result.finished].sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: dirtyPath, reason: FINISHED_REASONS.IN_DEFAULT_BRANCH },
        { path: mergedPath, reason: FINISHED_REASONS.PULL_REQUEST_MERGED },
        { path: pushedPath, reason: FINISHED_REASONS.IN_DEFAULT_BRANCH },
      ],
    );
    assert.deepEqual(
      [...result.kept].sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: freshPath, reason: UNFINISHED_REASONS.NO_OWN_COMMITS },
        { path: openPath, reason: UNFINISHED_REASONS.OPEN_PULL_REQUEST },
        { path: unpushedPath, reason: UNFINISHED_REASONS.WORK_NOT_INTEGRATED },
      ],
    );
    assert.deepEqual(result.removal.refused, [{ path: dirtyPath, reason: "uncommitted-changes" }]);
    assert.equal(existsSync(pushedPath), false);
    assert.equal(existsSync(mergedPath), false);
    for (const keptPath of [openPath, unpushedPath, freshPath, dirtyPath]) assert.equal(existsSync(keptPath), true);
    assert.match(await git(mainPath, ["branch", "--list", "merged-pr"]), /merged-pr/u);
  });

  it("keeps a finished worktree whose HEAD moves while its pull requests are looked up", async () => {
    const movingPath = await addWorktree("commits-during-lookup", "with-commit");
    const mergedHead = (await git(movingPath, ["rev-parse", "HEAD"])).trim();
    const output = createOutput();
    const result = await removeFinishedWorktrees({
      repositoryPath: mainPath,
      currentDirectory: fixtureFolder,
      now: () => LATER_MS,
      finishedSystem: {
        ...gitFinishedWorktreeSystem,
        listPullRequests: async (_mainWorktreePath, branch) => {
          if (branch !== "commits-during-lookup") return [];
          // A session commits new work after the worktree's HEAD was read, while the lookup is still pending.
          writeFileSync(path.join(movingPath, "new-work.txt"), "new work\n");
          await git(movingPath, ["add", "new-work.txt"]);
          await git(movingPath, ["commit", "-m", "new work"]);
          return [{ number: 7, state: "MERGED", headRefOid: mergedHead }];
        },
      },
      ...output,
    });

    assert.deepEqual(output.warnings.filter((message) => message.includes(movingPath)), []);
    assert.equal(result.finished.some((worktree) => worktree.path === movingPath), false);
    assert.deepEqual(
      result.kept.find((worktree) => worktree.path === movingPath),
      { path: movingPath, reason: UNFINISHED_REASONS.RECENTLY_ACTIVE },
    );
    assert.equal(result.removal.removedPaths.includes(movingPath), false);
    assert.equal(existsSync(movingPath), true);
    assert.match(await git(movingPath, ["log", "-1", "--format=%s"]), /new work/u);
  });

  it("keeps a worktree used within the grace period", async () => {
    const recentPath = await addWorktree("recent-push", "with-commit");
    await git(recentPath, ["push", "origin", "HEAD:main"]);
    const result = await removeFinishedWorktrees({
      repositoryPath: mainPath,
      currentDirectory: fixtureFolder,
      dryRun: true,
      finishedSystem: { ...gitFinishedWorktreeSystem, listPullRequests: async () => [] },
      ...createOutput(),
    });
    assert.deepEqual(
      result.kept.find((worktree) => worktree.path === recentPath),
      { path: recentPath, reason: UNFINISHED_REASONS.RECENTLY_ACTIVE },
    );
    assert.equal(existsSync(recentPath), true);
  });
});
