/** Worktree as `git worktree list --porcelain` reports it. */
export interface WorktreeEntry {
  /** Worktree folder. */
  path: string;
  /** Whether it is the main worktree, the one that holds the repository. */
  isMain: boolean;
  /** Whether `git worktree lock` protects it. */
  locked: boolean;
}

/** Why a worktree is not removed. */
export type RefusalReason =
  | "not-a-worktree"
  | "main-worktree"
  | "locked"
  | "contains-current-directory"
  | "uncommitted-changes"
  | "status-unknown"
  | "missing-directory"
  | "contains-submodules";

/** Whether a worktree may be removed, and why not otherwise. */
export type WorktreeRemovalDecision =
  | { action: "remove"; worktreePath: string; mainWorktreePath: string }
  | { action: "remove-leftover"; worktreePath: string }
  | { action: "refuse"; reason: RefusalReason };

/** What is known about the folder to remove. */
export interface WorktreeRemovalInput {
  targetPath: string;
  targetExists: boolean;
  /** Names directly inside the folder, or `null` when unreadable. */
  folderEntries: string[] | null;
  worktrees: WorktreeEntry[];
  /** `null` when the status could not be read. */
  hasUncommittedChanges: boolean | null;
  /** `null` when it could not be read. */
  hasInitializedSubmodules: boolean | null;
  currentDirectory: string;
  force: boolean;
  platform: string;
}

/** Git and file system access. */
export interface WorktreeSystem {
  folderExists(folderPath: string): boolean;
  toCanonicalPath(folderPath: string): string;
  listFolderEntries(folderPath: string): string[];
  listWorktrees(folderPath: string): Promise<WorktreeEntry[]>;
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  hasInitializedSubmodules(worktreePath: string): Promise<boolean>;
  removeFolder(folderPath: string): void;
  pruneWorktrees(mainWorktreePath: string): Promise<void>;
}

/** Outcome of a removal run. */
export interface WorktreeRemovalResult {
  /** Worktrees removed (or, in a dry run, that would be removed). */
  removedPaths: string[];
  /** Worktrees kept by a guard. */
  refused: { path: string; reason: RefusalReason }[];
  /** Worktrees whose removal failed. */
  failed: { path: string; error: string }[];
}

/** Worktrees to remove and how. */
export interface WorktreeRemovalOptions {
  paths: string[];
  /** Remove even with uncommitted changes or an unreadable status. */
  force?: boolean;
  /** Report what would be removed without removing it. */
  dryRun?: boolean;
  /** Working directory, which is never removed; defaults to the current one. */
  currentDirectory?: string;
  platform?: string;
  system?: WorktreeSystem;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export declare const FORCE_FLAG: "--force";
export declare const LEFTOVER_ENTRY_NAMES: readonly string[];
export declare const REFUSAL_REASONS: {
  NOT_A_WORKTREE: "not-a-worktree";
  MAIN_WORKTREE: "main-worktree";
  LOCKED: "locked";
  CONTAINS_CURRENT_DIRECTORY: "contains-current-directory";
  UNCOMMITTED_CHANGES: "uncommitted-changes";
  STATUS_UNKNOWN: "status-unknown";
  MISSING_DIRECTORY: "missing-directory";
  CONTAINS_SUBMODULES: "contains-submodules";
};
export declare function toComparablePath(folderPath: string, platform: string): string;
export declare function decideWorktreeRemoval(input: WorktreeRemovalInput): WorktreeRemovalDecision;
export declare function parseWorktreeList(porcelainOutput: string): WorktreeEntry[];
export declare const gitWorktreeSystem: WorktreeSystem;
export declare function removeWorktrees(options: WorktreeRemovalOptions): Promise<WorktreeRemovalResult>;
export declare function worktreesCleanupApplies(): boolean;

/** Why a worktree counts as finished. */
export type FinishedReason = "pull-request-merged" | "pull-request-closed" | "in-default-branch";

/** Why a worktree does not count as finished yet. */
export type UnfinishedReason =
  | "main-worktree"
  | "locked"
  | "recently-active"
  | "activity-unknown"
  | "open-pull-request"
  | "no-own-commits"
  | "work-not-integrated";

/** Pull request of a worktree's branch, as the decision sees it. */
export interface PullRequestSummary {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** Whether the worktree's HEAD is the pull request's last commit or an ancestor; `null` when unknown. */
  containsHead: boolean | null;
}

/** What is known about a worktree to tell whether its work ended. */
export interface FinishedWorktreeInput {
  isMain: boolean;
  locked: boolean;
  head: string;
  /** Oldest commit of the worktree's HEAD reflog, or `null` when empty. */
  startCommit: string | null;
  /** Time of the newest HEAD reflog entry, or `null` when unknown. */
  lastActivityMs: number | null;
  nowMs: number;
  gracePeriodMs: number;
  /** `null` when it could not be checked. */
  headInDefaultBranch: boolean | null;
  /** Newest first; `null` when they could not be read. */
  pullRequests: PullRequestSummary[] | null;
}

/** Whether a worktree is finished, and why. */
export type FinishedWorktreeDecision =
  | { finished: true; reason: FinishedReason }
  | { finished: false; reason: UnfinishedReason };

/** Pull request as `gh pr list --json number,state,headRefOid` reports it. */
export interface PullRequestRecord {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefOid: string;
}

/** Git and GitHub access to tell whether a worktree's work ended. */
export interface FinishedWorktreeSystem {
  fetchRemote(mainWorktreePath: string): Promise<void>;
  findDefaultBranchRef(mainWorktreePath: string): Promise<string | null>;
  readHead(worktreePath: string): Promise<{ head: string; branch: string | null }>;
  readHeadReflog(worktreePath: string): Promise<{ startCommit: string | null; lastActivityMs: number | null }>;
  isAncestor(folderPath: string, ancestor: string, descendant: string): Promise<boolean>;
  listPullRequests(mainWorktreePath: string, branch: string): Promise<PullRequestRecord[]>;
}

/** Outcome of closing the finished worktrees of a repository. */
export interface FinishedWorktreesResult {
  finished: { path: string; reason: FinishedReason }[];
  kept: { path: string; reason: UnfinishedReason }[];
  removal: WorktreeRemovalResult;
}

/** Repository whose finished worktrees to close, and how. */
export interface FinishedWorktreesOptions {
  /** Any folder of the repository; defaults to the current directory. */
  repositoryPath?: string;
  dryRun?: boolean;
  gracePeriodMs?: number;
  now?: () => number;
  currentDirectory?: string;
  platform?: string;
  system?: WorktreeSystem;
  finishedSystem?: FinishedWorktreeSystem;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export declare const FINISHED_WORKTREE_GRACE_PERIOD_MS: number;
export declare const FINISHED_REASONS: {
  PULL_REQUEST_MERGED: "pull-request-merged";
  PULL_REQUEST_CLOSED: "pull-request-closed";
  IN_DEFAULT_BRANCH: "in-default-branch";
};
export declare const UNFINISHED_REASONS: {
  MAIN_WORKTREE: "main-worktree";
  LOCKED: "locked";
  RECENTLY_ACTIVE: "recently-active";
  ACTIVITY_UNKNOWN: "activity-unknown";
  OPEN_PULL_REQUEST: "open-pull-request";
  NO_OWN_COMMITS: "no-own-commits";
  WORK_NOT_INTEGRATED: "work-not-integrated";
};
export declare function decideFinishedWorktree(input: FinishedWorktreeInput): FinishedWorktreeDecision;
export declare const gitFinishedWorktreeSystem: FinishedWorktreeSystem;
export declare function removeFinishedWorktrees(options?: FinishedWorktreesOptions): Promise<FinishedWorktreesResult>;
