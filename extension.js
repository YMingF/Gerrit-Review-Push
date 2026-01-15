const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUTPUT_CHANNEL_NAME = 'Gerrit Review Push';
// NOTE: Public release defaults to active in all workspaces.
const TARGET_BRANCHES_OVERRIDE_KEY = 'localGerritPush.targetBranchesOverride';
const PUSH_PREFIX_OVERRIDE_KEY = 'localGerritPush.pushPrefixOverride';
const LEGACY_LAST_SELECTED_TARGET_BRANCH_KEY = 'localGerritPush.lastSelectedTargetBranch';
const LAST_SELECTED_TARGET_BRANCH_BY_REPO_KEY = 'localGerritPush.lastSelectedTargetBranchByRepo';
const REWRITE_HISTORY_ACK_KEY = 'localGerritPush.rewriteHistoryAcked';

/** @type {vscode.ExtensionContext | null} */
let extensionContext = null;

/** @type {vscode.WebviewPanel | null} */
let bulkPanel = null;

/** @type {{ repos: RepoInfo[], options: { pushRemote: string, pushPrefix: string, targetBranches: string[], openAfterPush: boolean, lastSelectedTargetBranchByRepo: Record<string, string>, rewriteHistoryAcked: boolean }, output: vscode.OutputChannel } | null} */
let bulkState = null;

/** @type {boolean} */
let bulkPushInProgress = false;

/** @type {Map<string, string | null>} */
const repoRootCacheByFolderPath = new Map();

/**
 * @typedef {Object} CommitInfo
 * @property {string} fullSha
 * @property {string} shortSha
 * @property {string} date
 * @property {string} subject
 */

/**
 * @typedef {Object} RepoInfo
 * @property {string} repoRoot
 * @property {string} displayName
 * @property {string} currentBranch
 * @property {string} upstreamRef
 * @property {string} baseLabel
 * @property {number} totalCount
 * @property {CommitInfo[]} commits
 */

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import('child_process').ExecFileOptions} options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function gitWithEnv(cwd, args, extraEnv) {
  return execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ...(extraEnv ?? {}),
      // Avoid hanging on credential prompts inside the extension host.
      GIT_TERMINAL_PROMPT: '0'
    }
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function git(cwd, args) {
  return gitWithEnv(cwd, args, undefined);
}

/**
 * @param {string} repoRoot
 * @returns {Promise<string | null>}
 */
async function tryGetGitDirPath(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ['rev-parse', '--git-dir']);
    const gitDir = String(stdout ?? '').trim();
    if (!gitDir) return null;
    return path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
  } catch {
    return null;
  }
}

/**
 * @param {string} gitDirPath
 * @returns {boolean}
 */
function isGitOperationInProgress(gitDirPath) {
  const markers = [
    'rebase-apply',
    'rebase-merge',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG'
  ];

  for (const marker of markers) {
    try {
      if (fs.existsSync(path.join(gitDirPath, marker))) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * @param {string} repoRoot
 * @returns {Promise<string | null>}
 */
async function tryGetHeadSha(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ['rev-parse', 'HEAD']);
    const sha = String(stdout ?? '').trim();
    return sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 * @returns {Promise<boolean>}
 */
async function hasStagedChanges(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ['diff', '--cached', '--name-only']);
    return String(stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} commitSha
 * @returns {Promise<string>}
 */
async function getCommitMessage(repoRoot, commitSha) {
  const { stdout } = await git(repoRoot, ['show', '-s', '--format=%B', commitSha]);
  return String(stdout ?? '').replace(/\r\n/g, '\n');
}

/**
 * @param {string} repoRoot
 * @param {string} message
 * @param {vscode.OutputChannel} output
 * @returns {Promise<string>} new HEAD sha
 */
async function amendHeadCommitMessage(repoRoot, message, output) {
  const normalized = String(message ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) throw new Error('Commit message cannot be empty.');

  const gitDirPath = await tryGetGitDirPath(repoRoot);
  if (gitDirPath && isGitOperationInProgress(gitDirPath)) {
    throw new Error('Git operation in progress (rebase/merge/cherry-pick). Please finish it first.');
  }

  if (await hasStagedChanges(repoRoot)) {
    throw new Error('You have staged changes. Please unstage them before amending commit message.');
  }

  const fileName = `local-gerrit-push-commit-msg-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  const filePath = path.join(os.tmpdir(), fileName);
  const content = normalized.endsWith('\n') ? normalized : `${normalized}\n`;

  try {
    await fs.promises.writeFile(filePath, content, 'utf8');
    output.appendLine(`$ git commit --amend -F ${filePath}`);
    const { stdout, stderr } = await git(repoRoot, ['commit', '--amend', '-F', filePath]);
    const raw = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
    if (raw) output.appendLine(raw);
  } finally {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // ignore
    }
  }

  const newHead = await tryGetHeadSha(repoRoot);
  if (!newHead) throw new Error('Failed to read new HEAD sha after amend.');
  return newHead;
}

/**
 * @param {string} repoRoot
 * @returns {Promise<boolean>}
 */
async function hasUncommittedChanges(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ['status', '--porcelain']);
    return String(stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @returns {Promise<string | null>}
 */
async function tryGetStashHeadSha(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ['rev-parse', '-q', '--verify', 'refs/stash']);
    const sha = String(stdout ?? '').trim();
    return sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} commitSha
 * @returns {Promise<string[]>} parent SHAs
 */
async function getCommitParents(repoRoot, commitSha) {
  const { stdout } = await git(repoRoot, ['rev-list', '--parents', '-n', '1', commitSha]);
  const parts = String(stdout ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // first part is the commit itself
  return parts.slice(1);
}

/**
 * @param {string} repoRoot
 * @param {string} ancestorSha
 * @returns {Promise<boolean>}
 */
async function isAncestorOfHead(repoRoot, ancestorSha) {
  try {
    await git(repoRoot, ['merge-base', '--is-ancestor', ancestorSha, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite message for a non-HEAD commit by running a scripted interactive rebase with "reword".
 *
 * This rewrites history: the target commit and all descendants get new SHAs.
 *
 * @param {string} repoRoot
 * @param {string} commitSha
 * @param {string} message
 * @param {vscode.OutputChannel} output
 * @returns {Promise<void>}
 */
async function rewriteCommitMessageByRebase(repoRoot, commitSha, message, output) {
  const normalized = String(message ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) throw new Error('Commit message cannot be empty.');

  const gitDirPath = await tryGetGitDirPath(repoRoot);
  if (gitDirPath && isGitOperationInProgress(gitDirPath)) {
    throw new Error('Git operation in progress (rebase/merge/cherry-pick). Please finish it first.');
  }

  if (!(await isAncestorOfHead(repoRoot, commitSha))) {
    throw new Error('Selected commit is not an ancestor of HEAD (unexpected).');
  }

  const headSha = await tryGetHeadSha(repoRoot);
  if (headSha && headSha === commitSha) {
    throw new Error('Selected commit is HEAD. Use amend instead.');
  }

  const parents = await getCommitParents(repoRoot, commitSha);
  if (parents.length === 0) {
    throw new Error('Cannot rewrite the root commit message.');
  }
  if (parents.length > 1) {
    throw new Error('Merge commits are not supported for rewrite in this tool.');
  }

  const upstream = parents[0];
  if (!upstream) throw new Error('Failed to resolve parent commit.');

  const { stdout: logOut } = await git(repoRoot, ['log', '--reverse', '--format=%H%x09%s', `${upstream}..HEAD`]);
  const commits = String(logOut ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subjectParts] = line.split('\t');
      return { sha: String(sha ?? '').trim(), subject: subjectParts.join('\t') || '' };
    })
    .filter((c) => c.sha);

  if (commits.length === 0) {
    throw new Error('Failed to build rebase plan (no commits in range).');
  }

  const todoLines = commits.map((c) => {
    const action = c.sha === commitSha ? 'reword' : 'pick';
    const suffix = c.subject ? ` ${c.subject}` : '';
    return `${action} ${c.sha}${suffix}`.trimEnd();
  });

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-gerrit-push-reword-'));
  const todoPath = path.join(tmpDir, 'todo');
  const msgPath = path.join(tmpDir, 'message.txt');
  const seqEditorPath = path.join(tmpDir, 'sequence-editor.sh');
  const editorPath = path.join(tmpDir, 'editor.sh');

  const content = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  const wasDirty = await hasUncommittedChanges(repoRoot);

  try {
    await fs.promises.writeFile(todoPath, `${todoLines.join('\n')}\n`, 'utf8');
    await fs.promises.writeFile(msgPath, content, 'utf8');

    const seqScript = `#!/bin/sh
set -eu
cat "$(dirname "$0")/todo" > "$1"
`;
    const editorScript = `#!/bin/sh
set -eu
cat "$(dirname "$0")/message.txt" > "$1"
`;
    await fs.promises.writeFile(seqEditorPath, seqScript, { encoding: 'utf8', mode: 0o755 });
    await fs.promises.writeFile(editorPath, editorScript, { encoding: 'utf8', mode: 0o755 });

    const args = ['rebase', '-i', '--autostash', upstream];
    output.appendLine(`$ git rebase -i --autostash ${upstream}  # reword ${commitSha.slice(0, 7)}`);
    try {
      const { stdout, stderr } = await gitWithEnv(
        repoRoot,
        args,
        {
          GIT_SEQUENCE_EDITOR: seqEditorPath,
          GIT_EDITOR: editorPath
        }
      );
      const raw = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
      if (raw) output.appendLine(raw);
    } catch (e) {
      const anyErr = /** @type {any} */ (e);
      const combined = `${String(anyErr?.stdout ?? '')}\n${String(anyErr?.stderr ?? '')}`.toLowerCase();
      const autostashUnsupported = combined.includes('autostash') && combined.includes('unknown');
      if (!autostashUnsupported) throw e;

      output.appendLine(
        'Your git does not support `rebase --autostash`. Falling back to manual stash (tracked changes only).'
      );

      let stashSha = null;
      if (wasDirty) {
        const before = await tryGetStashHeadSha(repoRoot);
        const stashMsg = `local-gerrit-push autostash ${new Date().toISOString()}`;
        output.appendLine(`$ git stash push -m "${stashMsg}"`);
        await git(repoRoot, ['stash', 'push', '-m', stashMsg]);
        const after = await tryGetStashHeadSha(repoRoot);
        if (after && after !== before) stashSha = after;
      }

      try {
        output.appendLine(`$ git rebase -i ${upstream}  # reword ${commitSha.slice(0, 7)}`);
        const { stdout, stderr } = await gitWithEnv(
          repoRoot,
          ['rebase', '-i', upstream],
          {
            GIT_SEQUENCE_EDITOR: seqEditorPath,
            GIT_EDITOR: editorPath
          }
        );
        const raw = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
        if (raw) output.appendLine(raw);
      } catch (rebaseErr) {
        if (stashSha) {
          output.appendLine(
            `Manual autostash preserved as ${stashSha}. After you finish/abort the rebase, you can restore it via: git stash apply --index ${stashSha}`
          );
        }
        throw rebaseErr;
      }

      if (stashSha) {
        output.appendLine(`$ git stash apply --index ${stashSha}`);
        try {
          const { stdout, stderr } = await git(repoRoot, ['stash', 'apply', '--index', stashSha]);
          const raw = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
          if (raw) output.appendLine(raw);
        } catch (applyErr) {
          output.appendLine(formatExecError(output, applyErr));
          throw new Error(
            `Rebase succeeded but failed to re-apply autostash ${stashSha}. Resolve conflicts and retry 'git stash apply --index ${stashSha}'.`
          );
        }
        try {
          await git(repoRoot, ['stash', 'drop', stashSha]);
        } catch {
          // ignore
        }
      }
    }
  } catch (e) {
    output.appendLine(formatExecError(output, e));
    throw new Error(
      'Failed to rewrite commit message. If a rebase is in progress, resolve it or run `git rebase --abort`. If you used autostash, check `git stash list`.'
    );
  } finally {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * @param {vscode.Uri} [uri]
 * @returns {vscode.WorkspaceFolder | undefined}
 */
function pickWorkspaceFolder(uri) {
  if (uri) {
    return vscode.workspace.getWorkspaceFolder(uri);
  }
  const activeUri = vscode.window.activeTextEditor?.document?.uri;
  if (activeUri) {
    return vscode.workspace.getWorkspaceFolder(activeUri);
  }
  return vscode.workspace.workspaceFolders?.[0];
}

/**
 * @returns {string}
 */
function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * @param {unknown} branches
 * @returns {string[]}
 */
function normalizeTargetBranches(branches) {
  if (!Array.isArray(branches)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of branches) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    if (/\s/.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * @param {unknown} branches
 * @returns {string[]}
 */
function validateTargetBranchesList(branches) {
  if (!Array.isArray(branches)) throw new Error('targetBranches must be an array.');
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of branches) {
    const value = String(raw ?? '').trim();
    if (!value) throw new Error('Branch cannot be empty.');
    if (/\s/.test(value)) throw new Error(`Branch cannot contain whitespace: ${value}`);
    if (seen.has(value)) throw new Error(`Duplicate branch: ${value}`);
    seen.add(value);
    out.push(value);
  }
  if (out.length === 0) throw new Error('At least one target branch is required.');
  return out;
}

/**
 * @returns {string[] | null}
 */
function readTargetBranchesOverride() {
  if (!extensionContext) return null;
  const stored = extensionContext.workspaceState.get(TARGET_BRANCHES_OVERRIDE_KEY);
  const normalized = normalizeTargetBranches(stored);
  return normalized.length > 0 ? normalized : null;
}

/**
 * @param {string[]} branches
 * @returns {Promise<void>}
 */
async function writeTargetBranchesOverride(branches) {
  if (!extensionContext) return;
  const normalized = normalizeTargetBranches(branches);
  await extensionContext.workspaceState.update(TARGET_BRANCHES_OVERRIDE_KEY, normalized);
}

/**
 * @param {string} remote
 * @returns {string}
 */
function makeDefaultPushPrefix(remote) {
  return `push ${remote} $SHA:refs/for/`;
}

/**
 * Strictly validates and normalizes a Gerrit push prefix.
 *
 * Supported formats (whitespace separated):
 * - `push <remote> $SHA:refs/for/`
 * - `<remote> $SHA:refs/for/` (the leading `push` is optional)
 *
 * @param {unknown} input
 * @param {string} fallbackRemote
 * @returns {{ pushRemote: string, pushPrefix: string }}
 */
function parseAndNormalizePushPrefix(input, fallbackRemote) {
  const raw = String(input ?? '').trim();
  const fallback = String(fallbackRemote || 'origin').trim() || 'origin';
  if (!raw) return { pushRemote: fallback, pushPrefix: makeDefaultPushPrefix(fallback) };

  const parts = raw.split(/\s+/).filter(Boolean);
  let idx = 0;
  if (parts[idx] === 'git') idx += 1;
  if (parts[idx] === 'push') idx += 1;

  const remote = String(parts[idx] ?? '').trim();
  const template = String(parts[idx + 1] ?? '').trim();
  const extra = parts.slice(idx + 2);

  if (!remote || !template || extra.length > 0) {
    throw new Error('Invalid prefix. Expected: `push <remote> $SHA:refs/for/`');
  }
  if (remote.startsWith('-')) {
    throw new Error('Invalid remote in prefix (must not start with `-`).');
  }

  const expectedBase = '$SHA:refs/for';
  if (template !== expectedBase && template !== `${expectedBase}/`) {
    throw new Error('Invalid prefix. The last token must be exactly `$SHA:refs/for/`.');
  }

  return { pushRemote: remote, pushPrefix: makeDefaultPushPrefix(remote) };
}

/**
 * @returns {string | null}
 */
function readPushPrefixOverride() {
  if (!extensionContext) return null;
  const stored = extensionContext.workspaceState.get(PUSH_PREFIX_OVERRIDE_KEY);
  const value = String(stored ?? '').trim();
  return value ? value : null;
}

/**
 * @param {string} pushPrefix
 * @returns {Promise<void>}
 */
async function writePushPrefixOverride(pushPrefix) {
  if (!extensionContext) return;
  const value = String(pushPrefix ?? '').trim();
  await extensionContext.workspaceState.update(PUSH_PREFIX_OVERRIDE_KEY, value || undefined);
}

/**
 * @returns {string | null}
 */
function readLegacyLastSelectedTargetBranch() {
  if (!extensionContext) return null;
  const stored = extensionContext.workspaceState.get(LEGACY_LAST_SELECTED_TARGET_BRANCH_KEY);
  const value = String(stored ?? '').trim();
  if (!value) return null;
  if (/\s/.test(value)) return null;
  return value;
}

/**
 * @returns {Promise<void>}
 */
async function clearLegacyLastSelectedTargetBranch() {
  if (!extensionContext) return;
  await extensionContext.workspaceState.update(LEGACY_LAST_SELECTED_TARGET_BRANCH_KEY, undefined);
}

/**
 * @returns {Record<string, string>}
 */
function readLastSelectedTargetBranchByRepo() {
  if (!extensionContext) return {};
  const stored = extensionContext.workspaceState.get(LAST_SELECTED_TARGET_BRANCH_BY_REPO_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, rawValue] of Object.entries(/** @type {any} */ (stored))) {
    const repoRoot = String(key ?? '').trim();
    const branch = String(rawValue ?? '').trim();
    if (!repoRoot || !branch) continue;
    if (/\s/.test(branch)) continue;
    out[repoRoot] = branch;
  }
  return out;
}

/**
 * @param {Record<string, string>} map
 * @returns {Promise<void>}
 */
async function writeLastSelectedTargetBranchByRepo(map) {
  if (!extensionContext) return;
  const stored = map && typeof map === 'object' && !Array.isArray(map) ? map : {};

  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, rawValue] of Object.entries(stored)) {
    const repoRoot = String(key ?? '').trim();
    const branch = String(rawValue ?? '').trim();
    if (!repoRoot || !branch) continue;
    if (/\s/.test(branch)) continue;
    out[repoRoot] = branch;
  }

  await extensionContext.workspaceState.update(LAST_SELECTED_TARGET_BRANCH_BY_REPO_KEY, out);
}

/**
 * @returns {boolean}
 */
function readRewriteHistoryAcked() {
  if (!extensionContext) return false;
  return Boolean(extensionContext.workspaceState.get(REWRITE_HISTORY_ACK_KEY, false));
}

/**
 * @param {boolean} value
 * @returns {Promise<void>}
 */
async function writeRewriteHistoryAcked(value) {
  if (!extensionContext) return;
  await extensionContext.workspaceState.update(REWRITE_HISTORY_ACK_KEY, Boolean(value));
}

/**
 * @param {Record<string, string>} map
 * @param {string[]} allowedBranches
 * @returns {{ changed: boolean, map: Record<string, string> }}
 */
function pruneLastSelectedTargetBranchByRepo(map, allowedBranches) {
  const allowed = new Set(allowedBranches ?? []);
  /** @type {Record<string, string>} */
  const next = {};
  let changed = false;
  for (const [repoRoot, branch] of Object.entries(map ?? {})) {
    const value = String(branch ?? '').trim();
    if (!value) {
      changed = true;
      continue;
    }
    if (allowed.size > 0 && !allowed.has(value)) {
      changed = true;
      continue;
    }
    next[repoRoot] = value;
  }

  const prevKeys = Object.keys(map ?? {});
  const nextKeys = Object.keys(next);
  if (!changed && prevKeys.length !== nextKeys.length) changed = true;
  return { changed, map: next };
}

/**
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function tryGetRepoRoot(cwd) {
  const key = path.resolve(cwd);
  if (repoRootCacheByFolderPath.has(key)) return repoRootCacheByFolderPath.get(key) ?? null;
  try {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
    const root = stdout.trim();
    const resolved = root ? root : null;
    repoRootCacheByFolderPath.set(key, resolved);
    return resolved;
  } catch {
    repoRootCacheByFolderPath.set(key, null);
    return null;
  }
}

/**
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, worker) {
  const concurrency = Math.max(1, Math.floor(limit));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) runners.push(runOne());
  await Promise.all(runners);
  return results;
}

/**
 * @param {string} repoRoot
 * @returns {Promise<string>}
 */
async function getCurrentBranch(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * @param {string} repoRoot
 * @returns {Promise<string | null>}
 */
async function tryGetUpstreamRef(repoRoot) {
  try {
    const { stdout } = await git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const upstream = stdout.trim();
    return upstream ? upstream : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} remoteUrl
 * @returns {string | null}
 */
function extractHostFromRemoteUrl(remoteUrl) {
  let url = remoteUrl.trim();
  url = url.replace(/^ssh:\/\//, '').replace(/^https?:\/\//, '');
  url = url.replace(/^[^@]+@/, '');
  url = url.replace(/[:/].*$/, '');
  return url ? url : null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function findLastHttpUrl(text) {
  const matches = text.match(/https?:\/\/\S+/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1];
}

/**
 * @param {string} upstreamRef
 * @returns {{ remote: string, branch: string } | null}
 */
function parseUpstreamRemoteAndBranch(upstreamRef) {
  const trimmed = upstreamRef.trim();
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash <= 0) return null;
  const remote = trimmed.slice(0, firstSlash);
  const branch = trimmed.slice(firstSlash + 1);
  if (!remote || !branch) return null;
  return { remote, branch };
}

/**
 * @param {string} repoRoot
 * @param {string} remote
 * @param {string} branch
 * @returns {Promise<string | null>}
 */
async function getRemoteBranchHeadSha(repoRoot, remote, branch) {
  try {
    const { stdout } = await git(repoRoot, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    const line = stdout.trim().split('\n')[0] ?? '';
    const sha = line.split(/\s+/)[0] ?? '';
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} sha
 * @returns {Promise<boolean>}
 */
async function hasCommitObject(repoRoot, sha) {
  try {
    await git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} upstreamRef
 * @param {number} limit
 * @param {boolean} includeMergeCommits
 * @param {boolean} verifyRemoteHead
 * @param {vscode.OutputChannel} output
 * @returns {Promise<{baseLabel: string, totalCount: number, commits: CommitInfo[]}>}
 */
async function getAheadCommits(repoRoot, upstreamRef, limit, includeMergeCommits, verifyRemoteHead, output) {
  const upstreamParsed = parseUpstreamRemoteAndBranch(upstreamRef);
  let rangeBase = upstreamRef;
  let baseLabel = upstreamRef;

  if (verifyRemoteHead && upstreamParsed) {
    const remoteHeadSha = await getRemoteBranchHeadSha(repoRoot, upstreamParsed.remote, upstreamParsed.branch);
    if (remoteHeadSha && (await hasCommitObject(repoRoot, remoteHeadSha))) {
      rangeBase = remoteHeadSha;
      baseLabel = `${upstreamParsed.remote}/${upstreamParsed.branch} (remote head)`;
    } else if (remoteHeadSha) {
      output.appendLine(
        `[warn] Remote head commit is not present locally (${remoteHeadSha}). Falling back to local upstream ref '${upstreamRef}'.`
      );
    }
  }

  const countArgs = ['rev-list', '--count'];
  if (!includeMergeCommits) countArgs.push('--no-merges');
  countArgs.push(`${rangeBase}..HEAD`);
  const { stdout: countOut } = await git(repoRoot, countArgs);
  const parsedCount = Number.parseInt(String(countOut || '').trim(), 10);
  const totalCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 0;
  if (totalCount <= 0) return { baseLabel, totalCount: 0, commits: [] };

  const format = '%H%x09%h%x09%ad%x09%s';
  const args = ['log', '--date=short', `--format=${format}`, '-n', String(limit)];
  if (!includeMergeCommits) args.push('--no-merges');
  args.push(`${rangeBase}..HEAD`);

  const { stdout } = await git(repoRoot, args);
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  /** @type {CommitInfo[]} */
  const commits = [];
  for (const line of lines) {
    const [fullSha, shortSha, date, ...subjectParts] = line.split('\t');
    if (!fullSha || !shortSha) continue;
    commits.push({
      fullSha,
      shortSha,
      date: date ?? '',
      subject: subjectParts.join('\t') || ''
    });
  }

  return { baseLabel, totalCount, commits };
}

/**
 * @param {string} repoRoot
 * @param {string} remote
 * @param {string} commitSha
 * @returns {Promise<string | null>}
 */
async function buildFallbackGerritUrl(repoRoot, remote, commitSha) {
  try {
    const { stdout: remoteUrlOut } = await git(repoRoot, ['remote', 'get-url', remote]);
    const host = extractHostFromRemoteUrl(remoteUrlOut);
    if (!host) return null;

    const { stdout: messageOut } = await git(repoRoot, ['show', '-s', '--format=%B', commitSha]);
    const match = messageOut.match(/^Change-Id:\s*(\S+)\s*$/m);
    const changeId = match?.[1] ?? '';

    if (changeId) return `https://${host}/q/${encodeURIComponent(changeId)}`;
    return `https://${host}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} remote
 * @param {string} commitSha
 * @param {string} targetBranch
 * @param {vscode.OutputChannel} output
 * @returns {Promise<{rawOutput: string, gerritUrl: string | null}>}
 */
async function pushToGerrit(repoRoot, remote, commitSha, targetBranch, output) {
  const refspec = `${commitSha}:refs/for/${targetBranch}`;
  output.appendLine(`$ git push ${remote} ${refspec}`);

  const { stdout, stderr } = await git(repoRoot, ['push', remote, refspec]);
  const rawOutput = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
  if (rawOutput) output.appendLine(rawOutput);

  const urlFromOutput = findLastHttpUrl(rawOutput);
  const gerritUrl = urlFromOutput ?? (await buildFallbackGerritUrl(repoRoot, remote, commitSha));
  return { rawOutput, gerritUrl };
}

/**
 * @param {vscode.OutputChannel} output
 * @param {unknown} error
 * @returns {string}
 */
function formatExecError(output, error) {
  if (!(error instanceof Error)) return String(error);

  const anyErr = /** @type {any} */ (error);
  const stdout = String(anyErr.stdout ?? '').trim();
  const stderr = String(anyErr.stderr ?? '').trim();

  if (stdout) output.appendLine(stdout);
  if (stderr) output.appendLine(stderr);

  return stderr || stdout || error.message;
}

/**
 * @param {vscode.OutputChannel} output
 * @returns {Promise<RepoInfo[]>}
 */
async function collectReposWithAheadCommits(output) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return [];

  /** @type {Map<string, { repoRoot: string, displayName: string }>} */
  const uniqueRepos = new Map();
  const roots = await mapLimit(
    folders,
    4,
    async (folder) => ({
      repoRoot: await tryGetRepoRoot(folder.uri.fsPath),
      displayName: folder.name
    })
  );
  for (const r of roots) {
    if (!r.repoRoot) continue;
    if (!uniqueRepos.has(r.repoRoot)) uniqueRepos.set(r.repoRoot, { repoRoot: r.repoRoot, displayName: r.displayName });
  }

  if (uniqueRepos.size === 0) return [];

  const cfg = vscode.workspace.getConfiguration('localGerritPush');
  const limit = Math.max(1, Number(cfg.get('limit', 50)));
  const includeMergeCommits = Boolean(cfg.get('includeMergeCommits', false));
  const verifyRemoteHead = Boolean(cfg.get('verifyRemoteHead', false));

  /** @type {RepoInfo[]} */
  const repos = await mapLimit(Array.from(uniqueRepos.values()), 4, async (entry) => {
    const repoRoot = entry.repoRoot;
    const displayName = entry.displayName;

    try {
      const upstreamRef = await tryGetUpstreamRef(repoRoot);
      if (!upstreamRef) {
        output.appendLine(`[info] Skipping '${displayName}': no upstream configured for current branch.`);
        return null;
      }

      const { baseLabel, totalCount, commits } = await getAheadCommits(
        repoRoot,
        upstreamRef,
        limit,
        includeMergeCommits,
        verifyRemoteHead,
        output
      );
      if (totalCount <= 0 || commits.length === 0) return null;

      const currentBranch = await getCurrentBranch(repoRoot);

      return {
        repoRoot,
        displayName,
        currentBranch,
        upstreamRef,
        baseLabel,
        totalCount,
        commits
      };
    } catch (e) {
      output.appendLine(`[warn] Failed to scan '${displayName}': ${formatExecError(output, e)}`);
      return null;
    }
  });

  return repos.filter(Boolean);
}

/**
 * @param {string[]} targetBranches
 * @param {string} repoRoot
 * @param {Record<string, string>} lastSelectedTargetBranchByRepo
 * @returns {string}
 */
function chooseDefaultTargetBranch(targetBranches, repoRoot, lastSelectedTargetBranchByRepo) {
  if (!Array.isArray(targetBranches)) return '';
  if (targetBranches.length === 1) return targetBranches[0] ?? '';

  const key = String(repoRoot ?? '').trim();
  const last = key ? String(lastSelectedTargetBranchByRepo?.[key] ?? '').trim() : '';
  if (last && targetBranches.includes(last)) return last;
  return '';
}

/**
 * @param {vscode.Webview} webview
 * @param {RepoInfo[]} repos
 * @param {{ pushRemote: string, pushPrefix: string, targetBranches: string[], openAfterPush: boolean, lastSelectedTargetBranchByRepo: Record<string, string>, rewriteHistoryAcked: boolean }} options
 * @returns {string}
 */
function getBulkWebviewHtml(webview, repos, options) {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  const model = {
    options: {
      pushRemote: options.pushRemote,
      pushPrefix: options.pushPrefix,
      targetBranches: options.targetBranches,
      openAfterPush: options.openAfterPush,
      lastSelectedTargetBranchByRepo: options.lastSelectedTargetBranchByRepo,
      rewriteHistoryAcked: Boolean(options.rewriteHistoryAcked)
    },
    repos: repos.map((repo, idx) => ({
      id: String(idx),
      repoRoot: repo.repoRoot,
      displayName: repo.displayName,
      currentBranch: repo.currentBranch,
      upstreamRef: repo.upstreamRef,
      baseLabel: repo.baseLabel,
      totalCount: repo.totalCount,
      commits: repo.commits,
      defaultCommitSha: repo.commits[0]?.fullSha ?? '',
      defaultTargetBranch: chooseDefaultTargetBranch(options.targetBranches, repo.repoRoot, options.lastSelectedTargetBranchByRepo)
    }))
  };

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gerrit Review Push</title>
    <style>
      :root {
        --border: var(--vscode-editorWidget-border);
        --muted: var(--vscode-descriptionForeground);
        --error: var(--vscode-errorForeground);
      }

      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        margin: 0;
        padding: 12px;
      }

      h1 {
        font-size: 14px;
        margin: 0 0 10px 0;
        font-weight: 600;
      }

      .toolbar {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .spacer {
        flex: 1;
      }

      .hint {
        color: var(--muted);
        font-size: 12px;
      }

      .prefix-label {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
      }

      .prefix-label input {
        width: 340px;
        max-width: 60vw;
      }

      button {
        cursor: pointer;
        border: 1px solid var(--border);
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        padding: 4px 10px;
        border-radius: 4px;
      }

      button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }

      @keyframes lgp-spin {
        to {
          transform: rotate(360deg);
        }
      }

      button.loading {
        cursor: progress;
      }

      button.loading::after {
        content: '';
        width: 12px;
        height: 12px;
        margin-left: 8px;
        border-radius: 50%;
        border: 2px solid currentColor;
        border-right-color: transparent;
        display: inline-block;
        vertical-align: -2px;
        animation: lgp-spin 0.7s linear infinite;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
      }

      thead th {
        text-align: left;
        font-weight: 600;
        font-size: 12px;
        color: var(--muted);
        padding: 8px;
        border-bottom: 1px solid var(--border);
      }

      tbody td {
        padding: 8px;
        vertical-align: top;
        border-bottom: 1px solid var(--border);
      }

      tbody tr:last-child td {
        border-bottom: none;
      }

	      .repo-title {
	        font-weight: 600;
	      }

	      .project-name::before {
	        content: '▦';
	        display: inline-block;
	        margin-right: 6px;
	        color: var(--muted);
	        opacity: 0.9;
	      }

	      .project-branch {
	        display: flex;
	        gap: 6px;
	        align-items: center;
	      }

	      .branch-icon {
	        display: inline-flex;
	        align-items: center;
	        color: var(--muted);
	        opacity: 0.9;
	      }

	      .branch-icon svg {
	        width: 14px;
	        height: 14px;
	        fill: currentColor;
	      }

	      .branch-text {
	        word-break: break-all;
	      }

	      .repo-meta {
	        color: var(--muted);
	        font-size: 12px;
	        margin-top: 2px;
        word-break: break-all;
      }

      select {
        width: 100%;
        max-width: 540px;
        border: 1px solid var(--border);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 4px;
        border-radius: 4px;
      }

      input[type='text'] {
        width: 100%;
        max-width: 540px;
        border: 1px solid var(--border);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 4px;
        border-radius: 4px;
      }

      #branchPrefixInput {
        width: 340px;
        max-width: 60vw;
      }

      textarea {
        width: 100%;
        border: 1px solid var(--border);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 6px;
        border-radius: 4px;
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        resize: vertical;
        min-height: 140px;
      }

      .panel {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px;
        margin-bottom: 10px;
      }

      .panel-header {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 6px;
      }

      .panel-title {
        font-weight: 600;
      }

      .panel-footer {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 8px;
      }

      .branch-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .branch-item {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .branch-item code {
        flex: 1;
        padding: 4px 6px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--vscode-editorWidget-background);
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        word-break: break-all;
      }

      .branch-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      button.small {
        padding: 2px 8px;
        font-size: 12px;
      }

      .hidden {
        display: none;
      }

      .status {
        font-size: 12px;
        color: var(--muted);
      }

      .status.error {
        color: var(--error);
      }

      .status a {
        color: var(--vscode-textLink-foreground);
        text-decoration: none;
      }

      .status a:hover {
        text-decoration: underline;
      }

      .footer {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
      }

	      .footer .left {
	        flex: 1;
	        min-width: 200px;
	      }

	      .overlay {
	        position: fixed;
	        inset: 0;
	        background: rgba(0, 0, 0, 0.35);
	        display: flex;
	        align-items: center;
	        justify-content: center;
	        z-index: 9999;
	      }

	      .overlay.hidden {
	        display: none;
	      }

	      .dialog {
	        background: var(--vscode-editorWidget-background);
	        border: 1px solid var(--border);
	        border-radius: 6px;
	        padding: 12px;
	        max-width: 560px;
	        width: 90%;
	        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
	      }

	      .dialog-title {
	        font-weight: 600;
	        margin-bottom: 6px;
	      }

	      .dialog-text {
	        white-space: pre-wrap;
	        font-size: 13px;
	      }

	      .dialog-actions {
	        display: flex;
	        gap: 8px;
	        justify-content: flex-end;
	        margin-top: 10px;
	      }
	    </style>
	  </head>
  <body>
    <h1>Gerrit Review Push</h1>
	    <div class="toolbar">
	      <button id="selectAll" type="button">Select all</button>
	      <button id="selectNone" type="button">Select none</button>
	      <label class="hint"
	        ><input id="openAfterPush" type="checkbox" /> Open Gerrit after push</label
	      >
	      <div class="spacer"></div>
	      <span id="summary" class="hint"></span>
	    </div>

	    <div class="panel" id="branchesPanel">
	      <div class="panel-header">
	        <div class="panel-title">Target branches</div>
	        <label class="hint prefix-label"
	          >Command prefix:
	          <input
	            id="branchPrefixInput"
	            type="text"
	            spellcheck="false"
	            placeholder="push origin $SHA:refs/for/"
	            title="Format: push <remote> $SHA:refs/for/"
	            aria-label="Gerrit push command prefix"
	          />
	        </label>
	        <div class="spacer"></div>
	        <button id="branchAddBtn" type="button">Add branch</button>
	      </div>

	      <div id="branchAddRow" class="branch-item hidden">
	        <input id="branchAddInput" type="text" placeholder="feature/1.1.0" />
	        <div class="branch-actions">
	          <button id="branchAddOk" type="button" class="small primary">OK</button>
	          <button id="branchAddCancel" type="button" class="small">Cancel</button>
	        </div>
	      </div>

	      <div id="branchList" class="branch-list"></div>
	    </div>

	    <table>
	      <thead>
	        <tr>
	          <th style="width: 60px">Push</th>
          <th style="min-width: 240px">Project</th>
          <th style="min-width: 360px">Commit (ahead of upstream)</th>
          <th style="width: 220px">Target branch</th>
          <th style="width: 260px">Upstream</th>
          <th style="width: 220px">Status</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
	    </table>

	    <div class="panel hidden" id="commitEditorPanel">
	      <div class="panel-header">
	        <div class="panel-title">Edit commit message</div>
	        <span id="commitEditorMeta" class="hint"></span>
	        <div class="spacer"></div>
	        <button id="commitEditorClose" type="button" class="small">Close</button>
		      </div>
		      <div id="commitEditorHint" class="hint"></div>
		      <textarea id="commitEditorText" spellcheck="false"></textarea>
		      <label id="commitEditorRewriteAckRow" class="hint hidden"
		        ><input id="commitEditorRewriteAck" type="checkbox" /> I understand this rewrites history (non-HEAD)</label
		      >
			    <div class="panel-footer">
			        <button id="commitEditorSave" type="button" class="small primary">Save message</button>
			      </div>
			    </div>

		    <div id="confirmOverlay" class="overlay hidden">
		      <div class="dialog" role="dialog" aria-modal="true">
		        <div class="dialog-title">Discard unsaved changes?</div>
		        <div id="confirmText" class="dialog-text"></div>
		        <div class="dialog-actions">
		          <button id="confirmCancel" type="button" class="small">Cancel</button>
		          <button id="confirmOk" type="button" class="small primary">Switch</button>
		        </div>
		      </div>
		    </div>

		    <div class="footer">
		      <div class="left">
		        <div id="error" class="status error" role="alert"></div>
	      </div>
      <button id="push" type="button" class="primary">Push selected</button>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const model = ${toSafeJson(model)};

	      /** @type {boolean} */
	      let rewriteHistoryAcked = Boolean(model.options.rewriteHistoryAcked);

	      function makeInitialState() {
	        const selections = {};
	        for (const repo of model.repos) {
	          selections[repo.repoRoot] = {
	            include: true,
	            commitSha: repo.defaultCommitSha || '',
	            targetBranch: repo.defaultTargetBranch || '',
	            status: '',
	            gerritUrl: ''
	          };
	        }
	        return { openAfterPush: Boolean(model.options.openAfterPush), selections };
	      }

	      function loadState() {
	        const prev = vscode.getState();
	        const next = makeInitialState();
	        if (prev && typeof prev === 'object' && typeof prev.openAfterPush === 'boolean') next.openAfterPush = prev.openAfterPush;
	        return next;
	      }

	      /** @type {{ openAfterPush: boolean, selections: Record<string, any> }} */
	      let state = loadState();

	      /** @type {boolean} */
	      let isBusy = false;

	      /** @type {number} */
	      let editingBranchIndex = -1;

		      /** @type {number} */
		      let confirmDeleteBranchIndex = -1;

			      /** @type {{ repoRoot: string, displayName: string, commitSha: string, headSha: string | null, isHead: boolean, message: string, loaded: boolean } | null} */
			      let commitEditorState = null;

		      /** @type {Map<string, HTMLTableRowElement>} */
		      const rowByRepoRoot = new Map();

		      /** @type {Map<string, { include: HTMLInputElement, commitSelect: HTMLSelectElement, branchSelect: HTMLSelectElement, editMsgButton: HTMLButtonElement }>} */
		      const controlsByRepoRoot = new Map();

		      const els = {
		        rows: document.getElementById('rows'),
		        selectAll: document.getElementById('selectAll'),
		        selectNone: document.getElementById('selectNone'),
		        openAfterPush: document.getElementById('openAfterPush'),
	        branchPrefixInput: document.getElementById('branchPrefixInput'),
	        branchList: document.getElementById('branchList'),
	        branchAddBtn: document.getElementById('branchAddBtn'),
	        branchAddRow: document.getElementById('branchAddRow'),
		        branchAddInput: document.getElementById('branchAddInput'),
		        branchAddOk: document.getElementById('branchAddOk'),
		        branchAddCancel: document.getElementById('branchAddCancel'),
		        commitEditorPanel: document.getElementById('commitEditorPanel'),
		        commitEditorMeta: document.getElementById('commitEditorMeta'),
		        commitEditorHint: document.getElementById('commitEditorHint'),
		        commitEditorText: document.getElementById('commitEditorText'),
			        commitEditorRewriteAckRow: document.getElementById('commitEditorRewriteAckRow'),
			        commitEditorRewriteAck: document.getElementById('commitEditorRewriteAck'),
			        commitEditorClose: document.getElementById('commitEditorClose'),
			        commitEditorSave: document.getElementById('commitEditorSave'),
			        confirmOverlay: document.getElementById('confirmOverlay'),
			        confirmText: document.getElementById('confirmText'),
			        confirmCancel: document.getElementById('confirmCancel'),
			        confirmOk: document.getElementById('confirmOk'),
			        push: document.getElementById('push'),
			        summary: document.getElementById('summary'),
			        error: document.getElementById('error')
			      };

	      els.openAfterPush.checked = Boolean(state.openAfterPush);
	      els.branchPrefixInput.value = String(model.options.pushPrefix || '').trim();

			      function setError(text) {
			        els.error.textContent = text || '';
			      }

			      els.branchPrefixInput.addEventListener('keydown', (e) => {
			        if (e.key === 'Enter') {
			          e.preventDefault();
			          try {
			            els.branchPrefixInput.blur();
			          } catch {
			            // ignore
			          }
			        }
			        if (e.key === 'Escape') {
			          e.preventDefault();
			          els.branchPrefixInput.value = String(model.options.pushPrefix || '').trim();
			          try {
			            els.branchPrefixInput.blur();
			          } catch {
			            // ignore
			          }
			        }
			      });

			      els.branchPrefixInput.addEventListener('blur', () => {
			        if (isBusy) return;
			        const next = String(els.branchPrefixInput.value || '').trim();
			        const current = String(model.options.pushPrefix || '').trim();
			        if (next === current) return;
			        setError('');
			        vscode.postMessage({ type: 'updatePushPrefix', pushPrefix: next });
			      });

			      /** @type {boolean} */
			      let isCommitEditorSaving = false;

			      /**
			       * Shows/hides a small loading spinner on the commit editor save button.
			       * @param {boolean} value
			       */
			      function setCommitEditorSaving(value) {
			        const next = Boolean(value);
			        if (next === isCommitEditorSaving) return;
			        isCommitEditorSaving = next;

			        if (next) {
			          const label = commitEditorState && commitEditorState.isHead ? 'Saving...' : 'Rewriting...';
			          els.commitEditorSave.dataset.label = els.commitEditorSave.textContent || '';
			          els.commitEditorSave.classList.add('loading');
			          els.commitEditorPanel.setAttribute('aria-busy', 'true');
			          els.commitEditorSave.textContent = label;
			          els.commitEditorSave.disabled = true;
			          return;
			        }

			        els.commitEditorSave.classList.remove('loading');
			        els.commitEditorPanel.removeAttribute('aria-busy');

			        const prev = els.commitEditorSave.dataset.label;
			        if (typeof prev === 'string' && prev.length > 0) {
			          els.commitEditorSave.textContent = prev;
			        } else if (commitEditorState) {
			          els.commitEditorSave.textContent = commitEditorState.isHead ? 'Save message' : 'Rewrite message';
			        } else {
			          els.commitEditorSave.textContent = 'Save message';
			        }
			        delete els.commitEditorSave.dataset.label;
			      }

			      /** @type {{ resolve: (value: boolean) => void } | null} */
			      let confirmDialogState = null;
			      const hasConfirmUi = Boolean(
			        els.confirmOverlay && els.confirmText && els.confirmCancel && els.confirmOk
			      );

			      /**
			       * @param {string} text
			       * @returns {Promise<boolean>}
			       */
			      function showConfirmDialog(text) {
			        if (!hasConfirmUi) return Promise.resolve(confirm(String(text || '')));
			        if (confirmDialogState) return Promise.resolve(false);
			        els.confirmText.textContent = String(text || '');
			        els.confirmOverlay.classList.remove('hidden');
			        return new Promise((resolve) => {
			          confirmDialogState = { resolve };
			        });
			      }

			      /**
			       * @param {boolean} value
			       */
			      function resolveConfirmDialog(value) {
			        if (!confirmDialogState) return;
			        const resolve = confirmDialogState.resolve;
			        confirmDialogState = null;
			        els.confirmOverlay.classList.add('hidden');
			        els.confirmText.textContent = '';
			        resolve(Boolean(value));
			      }

			      if (hasConfirmUi) {
			        els.confirmCancel.addEventListener('click', () => {
			          if (isBusy) return;
			          resolveConfirmDialog(false);
			        });
			        els.confirmOk.addEventListener('click', () => {
			          if (isBusy) return;
			          resolveConfirmDialog(true);
			        });
			        els.confirmOverlay.addEventListener('click', (e) => {
			          if (e.target === els.confirmOverlay) resolveConfirmDialog(false);
			        });
			        window.addEventListener('keydown', (e) => {
			          if (!confirmDialogState) return;
			          if (e.key === 'Escape') resolveConfirmDialog(false);
			        });
			      }

			      function syncCommitEditorSaveState() {
			        const loaded = Boolean(commitEditorState && commitEditorState.loaded);
			        const isHead = Boolean(commitEditorState && commitEditorState.isHead);
			        const needsAck = Boolean(commitEditorState && !isHead && !rewriteHistoryAcked);
		        const ackOk = !needsAck || rewriteHistoryAcked || Boolean(els.commitEditorRewriteAck.checked);
		        els.commitEditorSave.disabled = isBusy || !commitEditorState || !loaded || !ackOk;
		      }

			      function setBusy(busy) {
			        isBusy = Boolean(busy);
			        if (!isBusy) setCommitEditorSaving(false);

			        els.push.disabled = isBusy;
			        els.selectAll.disabled = isBusy;
		        els.selectNone.disabled = isBusy;
		        els.openAfterPush.disabled = isBusy;
		        els.branchPrefixInput.disabled = isBusy;
		        els.branchAddBtn.disabled = isBusy;
		        els.branchAddInput.disabled = isBusy;
		        els.branchAddOk.disabled = isBusy;
		        els.branchAddCancel.disabled = isBusy;
		        els.commitEditorText.disabled = isBusy;
		        els.commitEditorRewriteAck.disabled = isBusy;
		        els.commitEditorClose.disabled = isBusy;

		        for (const controls of controlsByRepoRoot.values()) {
		          controls.include.disabled = isBusy;
		          controls.commitSelect.disabled = isBusy || !controls.include.checked;
			          controls.branchSelect.disabled = isBusy || !controls.include.checked;
			          controls.editMsgButton.disabled = isBusy || !controls.include.checked;
			        }

			        syncCommitEditorSaveState();
			        renderBranchList();
			      }

			      function hideCommitEditor() {
			        setCommitEditorSaving(false);
			        commitEditorState = null;
			        els.commitEditorMeta.textContent = '';
			        els.commitEditorMeta.title = '';
			        els.commitEditorHint.textContent = '';
			        els.commitEditorText.value = '';
			        els.commitEditorRewriteAck.checked = false;
			        els.commitEditorRewriteAckRow.classList.add('hidden');
			        els.commitEditorSave.textContent = 'Save message';
			        els.commitEditorPanel.classList.add('hidden');
			        els.commitEditorSave.disabled = true;
			      }

		      function showCommitEditor() {
		        els.commitEditorPanel.classList.remove('hidden');
		      }

		      function openCommitEditor(repo, commitSha) {
		        const sha = String(commitSha || '').trim();
		        if (!sha) {
		          setError('No commit selected.');
		          return;
		        }

		        setError('');
		        setCommitEditorSaving(false);
		        editingBranchIndex = -1;
		        confirmDeleteBranchIndex = -1;
		        showAddBranchRow(false);

			        commitEditorState = {
			          repoRoot: repo.repoRoot,
			          displayName: repo.displayName || repo.repoRoot,
				          commitSha: sha,
				          headSha: null,
				          isHead: false,
				          message: '',
			          loaded: false
			        };

			        els.commitEditorMeta.textContent = ' • ' + commitEditorState.displayName;
			        els.commitEditorMeta.title = sha;
			        els.commitEditorHint.textContent = 'Loading commit message...';
			        els.commitEditorText.value = '';
			        els.commitEditorRewriteAck.checked = Boolean(rewriteHistoryAcked);
			        els.commitEditorRewriteAckRow.classList.add('hidden');
			        els.commitEditorSave.textContent = 'Save message';
			        els.commitEditorSave.disabled = true;
			        showCommitEditor();

			        vscode.postMessage({ type: 'getCommitMessage', repoRoot: repo.repoRoot, commitSha: sha });
			      }

			      els.commitEditorClose.addEventListener('click', () => {
			        if (isBusy) return;
			        hideCommitEditor();
			      });

			      els.commitEditorRewriteAck.addEventListener('change', () => {
			        if (els.commitEditorRewriteAck.checked && !rewriteHistoryAcked) {
			          rewriteHistoryAcked = true;
			          vscode.postMessage({ type: 'ackRewriteHistory' });
			          els.commitEditorRewriteAckRow.classList.add('hidden');
			        }
			        syncCommitEditorSaveState();
			      });

			      els.commitEditorSave.addEventListener('click', () => {
			        if (isBusy) return;
			        if (!commitEditorState) return;
			        setError('');

			        const message = String(els.commitEditorText.value || '');
			        if (!message.trim()) {
			          setError('Commit message cannot be empty.');
			          return;
			        }

			        const allowRewrite = !commitEditorState.isHead;
			        if (allowRewrite && !rewriteHistoryAcked && !els.commitEditorRewriteAck.checked) {
			          setError('Editing a non-HEAD commit rewrites history. Please confirm the checkbox before saving.');
			          return;
			        }

			        setCommitEditorSaving(true);
			        vscode.postMessage({
			          type: 'updateCommitMessage',
			          repoRoot: commitEditorState.repoRoot,
			          commitSha: commitEditorState.commitSha,
			          message,
			          allowRewrite
			        });
			      });

		      function persistState() {
		        vscode.setState(state);
		      }

      function updateSummary() {
        const included = Object.values(state.selections).filter((s) => s && s.include).length;
        els.summary.textContent =
          included === 0
            ? 'No projects selected'
            : included === 1
              ? '1 project selected'
              : \`\${included} projects selected\`;
      }

	      function buildOption(label, value, selectedValue) {
	        const opt = document.createElement('option');
	        opt.value = value;
	        opt.textContent = label;
	        if (value === selectedValue) opt.selected = true;
	        return opt;
	      }

	      function validateTargetBranches(branches) {
	        if (!Array.isArray(branches)) throw new Error('Target branches must be an array.');
	        const normalized = [];
	        const seen = new Set();
	        for (const raw of branches) {
	          const value = String(raw || '').trim();
	          if (!value) throw new Error('Branch cannot be empty.');
	          if (/\\s/.test(value)) throw new Error('Branch cannot contain whitespace: ' + value);
	          if (seen.has(value)) throw new Error('Duplicate branch: ' + value);
	          seen.add(value);
	          normalized.push(value);
	        }
	        if (normalized.length === 0) throw new Error('At least one target branch is required.');
	        return normalized;
	      }

	      function getBranchCommand(branch) {
	        const prefix = String(model.options.pushPrefix || '').trim();
	        const normalized = prefix.endsWith('/') ? prefix : prefix + '/';
	        return normalized + branch;
	      }

	      function parseBranchFromInput(input) {
	        const text = String(input || '').trim();
	        if (!text) return '';
	        const marker = 'refs/for/';
	        const idx = text.indexOf(marker);
	        let branch = '';
	        if (idx >= 0) {
	          const after = text.slice(idx + marker.length);
	          branch = (after.split(/\\s+/)[0] || '').trim();
	        } else {
	          branch = text;
	        }
	        if (!branch || /\\s/.test(branch)) return '';
	        return branch;
	      }

	      function showAddBranchRow(show) {
	        if (show) {
	          els.branchAddRow.classList.remove('hidden');
	          els.branchAddInput.value = '';
	          try {
	            els.branchAddInput.focus();
	          } catch {
	            // ignore
	          }
	        } else {
	          els.branchAddRow.classList.add('hidden');
	          els.branchAddInput.value = '';
	        }
	      }

	      function applyTargetBranches(nextBranches) {
	        const normalized = validateTargetBranches(nextBranches);
	        editingBranchIndex = -1;
	        confirmDeleteBranchIndex = -1;
	        showAddBranchRow(false);
	        model.options.targetBranches = normalized;
	        vscode.postMessage({ type: 'updateBranches', targetBranches: normalized });
	        renderBranchList();
	        renderRows();
	        persistState();
	      }

	      function renderBranchList() {
	        els.branchList.textContent = '';
	        const branches = Array.isArray(model.options.targetBranches) ? model.options.targetBranches : [];

	        for (let i = 0; i < branches.length; i++) {
	          const branch = branches[i];
	          const row = document.createElement('div');
	          row.className = 'branch-item';

		          if (editingBranchIndex === i) {
	            const input = document.createElement('input');
	            input.type = 'text';
	            input.value = branch;
	            input.disabled = isBusy;
	            input.addEventListener('keydown', (e) => {
	              if (e.key === 'Enter') ok.click();
	              if (e.key === 'Escape') cancel.click();
	            });

	            const actions = document.createElement('div');
	            actions.className = 'branch-actions';

	            const ok = document.createElement('button');
	            ok.type = 'button';
	            ok.className = 'small primary';
	            ok.textContent = 'OK';
	            ok.disabled = isBusy;
		            ok.addEventListener('click', () => {
		              setError('');
		              try {
		                const next = branches.slice();
		                const parsed = parseBranchFromInput(input.value);
		                if (!parsed) throw new Error('Please enter a valid branch path (no whitespace).');
		                next[i] = parsed;
		                applyTargetBranches(next);
		              } catch (e) {
		                setError(e instanceof Error ? e.message : String(e));
		              }
		            });

		            const cancel = document.createElement('button');
		            cancel.type = 'button';
		            cancel.className = 'small';
		            cancel.textContent = 'Cancel';
		            cancel.disabled = isBusy;
		            cancel.addEventListener('click', () => {
		              editingBranchIndex = -1;
		              renderBranchList();
		            });

	            actions.appendChild(ok);
	            actions.appendChild(cancel);
	            row.appendChild(input);
	            row.appendChild(actions);
	            els.branchList.appendChild(row);

	            setTimeout(() => {
	              try {
	                input.focus();
	                input.select();
	              } catch {
	                // ignore
	              }
	            }, 0);
		            continue;
		          }

		          if (confirmDeleteBranchIndex === i) {
		            const code = document.createElement('code');
		            code.textContent = getBranchCommand(branch);

		            const actions = document.createElement('div');
		            actions.className = 'branch-actions';

		            const confirm = document.createElement('button');
		            confirm.type = 'button';
		            confirm.className = 'small primary';
		            confirm.textContent = 'Confirm';
		            confirm.disabled = isBusy;
		            confirm.addEventListener('click', () => {
		              setError('');
		              if (branches.length <= 1) {
		                setError('At least one target branch is required.');
		                return;
		              }
		              const next = branches.filter((_, idx) => idx !== i);
		              try {
		                applyTargetBranches(next);
		              } catch (e) {
		                setError(e instanceof Error ? e.message : String(e));
		              }
		            });

		            const cancel = document.createElement('button');
		            cancel.type = 'button';
		            cancel.className = 'small';
		            cancel.textContent = 'Cancel';
		            cancel.disabled = isBusy;
		            cancel.addEventListener('click', () => {
		              confirmDeleteBranchIndex = -1;
		              renderBranchList();
		            });

		            actions.appendChild(confirm);
		            actions.appendChild(cancel);

		            row.appendChild(code);
		            row.appendChild(actions);
		            els.branchList.appendChild(row);
		            continue;
		          }

		          const code = document.createElement('code');
		          code.textContent = getBranchCommand(branch);

	          const actions = document.createElement('div');
	          actions.className = 'branch-actions';

	          const edit = document.createElement('button');
	          edit.type = 'button';
	          edit.className = 'small';
	          edit.textContent = 'Edit';
		          edit.disabled = isBusy;
		          edit.addEventListener('click', () => {
		            setError('');
		            showAddBranchRow(false);
		            confirmDeleteBranchIndex = -1;
		            editingBranchIndex = i;
		            renderBranchList();
		          });

	          const del = document.createElement('button');
	          del.type = 'button';
	          del.className = 'small';
		          del.textContent = 'Delete';
		          del.disabled = isBusy;
		          del.addEventListener('click', () => {
		            setError('');
		            if (branches.length <= 1) {
		              setError('At least one target branch is required.');
		              return;
		            }
		            editingBranchIndex = -1;
		            showAddBranchRow(false);
		            confirmDeleteBranchIndex = i;
		            renderBranchList();
		          });

	          actions.appendChild(edit);
	          actions.appendChild(del);

	          row.appendChild(code);
	          row.appendChild(actions);
	          els.branchList.appendChild(row);
	        }

	        if (branches.length === 0) {
	          const empty = document.createElement('div');
	          empty.className = 'hint';
	          empty.textContent = 'No target branches configured.';
	          els.branchList.appendChild(empty);
	        }
	      }

	      els.branchAddBtn.addEventListener('click', () => {
	        if (isBusy) return;
	        setError('');
	        editingBranchIndex = -1;
	        confirmDeleteBranchIndex = -1;
	        showAddBranchRow(true);
	      });

	      els.branchAddCancel.addEventListener('click', () => {
	        if (isBusy) return;
	        setError('');
	        confirmDeleteBranchIndex = -1;
	        showAddBranchRow(false);
	      });

		      els.branchAddOk.addEventListener('click', () => {
		        if (isBusy) return;
		        setError('');
		        try {
		          const branch = parseBranchFromInput(els.branchAddInput.value);
		          if (!branch) throw new Error('Please enter a valid branch path (no whitespace).');
		          const next = (Array.isArray(model.options.targetBranches) ? model.options.targetBranches : []).slice();
		          next.push(branch);
		          applyTargetBranches(next);
		        } catch (e) {
		          setError(e instanceof Error ? e.message : String(e));
		        }
		      });

	      els.branchAddInput.addEventListener('keydown', (e) => {
	        if (e.key === 'Enter') els.branchAddOk.click();
	        if (e.key === 'Escape') els.branchAddCancel.click();
	      });

	      function renderRows() {
	        els.rows.textContent = '';
	        rowByRepoRoot.clear();
	        controlsByRepoRoot.clear();
	        let stateChanged = false;

	        for (const repo of model.repos) {
	          const row = document.createElement('tr');
          row.dataset.repoRoot = repo.repoRoot;
          rowByRepoRoot.set(repo.repoRoot, row);

          const selection = state.selections[repo.repoRoot];

	          const pushCell = document.createElement('td');
	          const include = document.createElement('input');
	          include.type = 'checkbox';
	          include.checked = Boolean(selection?.include);
	          include.disabled = isBusy;
	          include.addEventListener('change', () => {
	            state.selections[repo.repoRoot].include = include.checked;
	            commitSelect.disabled = isBusy || !include.checked;
	            branchSelect.disabled = isBusy || !include.checked;
	            editMsgButton.disabled = isBusy || !include.checked;
	            updateSummary();
	            persistState();
	          });
	          pushCell.appendChild(include);

	          const projectCell = document.createElement('td');
	          const title = document.createElement('div');
	          title.className = 'repo-title';
	          title.classList.add('project-name');
	          title.textContent = repo.displayName || repo.repoRoot;
	          const meta = document.createElement('div');
	          meta.className = 'repo-meta';
	          meta.classList.add('project-branch');
	          const branchIcon = document.createElement('span');
	          branchIcon.className = 'branch-icon';
	          branchIcon.setAttribute('aria-hidden', 'true');
	          branchIcon.innerHTML =
	            '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3" r="2" stroke="currentColor" stroke-width="1.5" fill="none"></circle><circle cx="4" cy="13" r="2" stroke="currentColor" stroke-width="1.5" fill="none"></circle><circle cx="12" cy="8" r="2" stroke="currentColor" stroke-width="1.5" fill="none"></circle><path d="M4 5v6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"></path><path d="M6 8h4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"></path></svg>';

	          const branchText = document.createElement('span');
	          branchText.className = 'branch-text';
	          branchText.textContent = \`\${repo.currentBranch}\`;

	          meta.appendChild(branchIcon);
	          meta.appendChild(branchText);
	          projectCell.title = repo.repoRoot;
	          projectCell.appendChild(title);
	          projectCell.appendChild(meta);

	          const commitCell = document.createElement('td');
		          const commitSelect = document.createElement('select');
		          commitSelect.disabled = isBusy || !include.checked;
		          const selectedCommitSha = selection?.commitSha || repo.defaultCommitSha || '';
		          for (const c of repo.commits || []) {
		            const subject = String(c.subject || '').trim();
		            const label = subject || '(no subject)';
		            const opt = buildOption(label, c.fullSha, selectedCommitSha);
	            opt.title = \`\${c.fullSha}\\n\${c.date || ''}\\n\${c.subject || ''}\`.trim();
	            commitSelect.appendChild(opt);
	          }
	          if (commitSelect.selectedIndex >= 0) {
	            commitSelect.title = commitSelect.options[commitSelect.selectedIndex]?.title || '';
	          }
	          if (commitSelect.value && commitSelect.value !== state.selections[repo.repoRoot].commitSha) {
	            state.selections[repo.repoRoot].commitSha = commitSelect.value;
	            stateChanged = true;
	          }
			          commitSelect.addEventListener('change', async () => {
			            const prevSha = String(state.selections[repo.repoRoot].commitSha || '').trim();
			            const nextSha = commitSelect.value;
			            state.selections[repo.repoRoot].commitSha = nextSha;
			            if (commitSelect.selectedIndex >= 0) {
			              commitSelect.title = commitSelect.options[commitSelect.selectedIndex]?.title || '';
			            }
			            persistState();

			            if (!commitEditorState) return;
			            if (els.commitEditorPanel.classList.contains('hidden')) return;
			            if (commitEditorState.repoRoot === repo.repoRoot && commitEditorState.commitSha === nextSha) return;

			            const hasUnsavedChanges =
			              String(els.commitEditorText.value || '') !== String(commitEditorState.message || '');
			            if (hasUnsavedChanges) {
			              const currentProject = commitEditorState.displayName || commitEditorState.repoRoot;
				              const nextProject = repo.displayName || repo.repoRoot;
				              const currentShort = commitEditorState.commitSha ? commitEditorState.commitSha.slice(0, 7) : '(unknown)';
				              const nextShort = nextSha ? nextSha.slice(0, 7) : '(unknown)';
				              const ok = await showConfirmDialog(
				                'You have unsaved edits in the commit message editor.\\n\\n' +
				                  'Current: ' +
				                  currentProject +
				                  ' • ' +
				                  currentShort +
				                  '\\n' +
				                  'Switch to: ' +
				                  nextProject +
				                  ' • ' +
				                  nextShort +
				                  '\\n\\n' +
				                  'Switching will discard your edits. Continue?'
				              );
			              if (!ok) {
			                commitSelect.value = prevSha;
			                state.selections[repo.repoRoot].commitSha = prevSha;
			                if (commitSelect.selectedIndex >= 0) {
			                  commitSelect.title = commitSelect.options[commitSelect.selectedIndex]?.title || '';
			                }
			                persistState();
			                return;
			              }
			            }

			            openCommitEditor(repo, nextSha);
			          });
		          commitSelect.style.flex = '1';

	          const editMsgButton = document.createElement('button');
	          editMsgButton.type = 'button';
	          editMsgButton.className = 'small';
	          editMsgButton.textContent = 'Edit msg';
	          editMsgButton.title = 'Edit commit message';
	          editMsgButton.setAttribute('aria-label', 'Edit commit message');
	          editMsgButton.disabled = isBusy || !include.checked;
	          editMsgButton.addEventListener('click', () => {
	            if (isBusy) return;
	            openCommitEditor(repo, commitSelect.value);
	          });

	          const commitContainer = document.createElement('div');
	          commitContainer.style.display = 'flex';
	          commitContainer.style.gap = '6px';
	          commitContainer.style.alignItems = 'center';
	          commitContainer.appendChild(commitSelect);
	          commitContainer.appendChild(editMsgButton);
	          commitCell.appendChild(commitContainer);

	          const branchCell = document.createElement('td');
	          const branchSelect = document.createElement('select');
	          branchSelect.disabled = isBusy || !include.checked;

	          const branches = Array.isArray(model.options.targetBranches) ? model.options.targetBranches : [];
	          const desiredBranch = String(selection?.targetBranch || '').trim();
	          const defaultBranch = String(repo.defaultTargetBranch || '').trim();

	          let selectedBranch = '';
	          if (desiredBranch && branches.includes(desiredBranch)) selectedBranch = desiredBranch;
	          if (!selectedBranch && defaultBranch && branches.includes(defaultBranch)) selectedBranch = defaultBranch;

	          if (branches.length > 1) {
	            const placeholder = document.createElement('option');
	            placeholder.value = '';
	            placeholder.textContent = '-- Select branch --';
	            placeholder.disabled = true;
	            if (!selectedBranch) placeholder.selected = true;
	            branchSelect.appendChild(placeholder);
	          }

	          for (const b of branches) {
	            branchSelect.appendChild(buildOption(b, b, selectedBranch));
	          }

	          if (branchSelect.value !== state.selections[repo.repoRoot].targetBranch) {
	            state.selections[repo.repoRoot].targetBranch = branchSelect.value;
	            stateChanged = true;
	          }

	          branchSelect.addEventListener('change', () => {
	            state.selections[repo.repoRoot].targetBranch = branchSelect.value;
	            if (branchSelect.value) {
	              if (!model.options.lastSelectedTargetBranchByRepo || typeof model.options.lastSelectedTargetBranchByRepo !== 'object') {
	                model.options.lastSelectedTargetBranchByRepo = {};
	              }
	              model.options.lastSelectedTargetBranchByRepo[repo.repoRoot] = branchSelect.value;
	              vscode.postMessage({ type: 'rememberLastBranch', repoRoot: repo.repoRoot, targetBranch: branchSelect.value });
	            }
	            persistState();
	          });

	          branchCell.appendChild(branchSelect);

	          controlsByRepoRoot.set(repo.repoRoot, { include, commitSelect, branchSelect, editMsgButton });

	          const upstreamCell = document.createElement('td');
	          const upstream = document.createElement('div');
	          upstream.className = 'repo-meta';
          upstream.textContent = repo.baseLabel || repo.upstreamRef || '';
          const count = document.createElement('div');
          count.className = 'repo-meta';
          count.textContent =
            repo.totalCount && repo.commits && repo.totalCount > repo.commits.length
              ? \`\${repo.commits.length} shown (of \${repo.totalCount})\`
              : \`\${repo.totalCount || (repo.commits ? repo.commits.length : 0)} commit(s)\`;
          upstreamCell.appendChild(upstream);
          upstreamCell.appendChild(count);

          const statusCell = document.createElement('td');
          const status = document.createElement('div');
          status.className = 'status';
          status.textContent = '';
          statusCell.appendChild(status);

          row.appendChild(pushCell);
          row.appendChild(projectCell);
          row.appendChild(commitCell);
          row.appendChild(branchCell);
          row.appendChild(upstreamCell);
          row.appendChild(statusCell);

          els.rows.appendChild(row);
        }

        updateSummary();
        if (stateChanged) persistState();
      }

      function setRowStatus(repoRoot, kind, message, gerritUrl) {
        const row = rowByRepoRoot.get(repoRoot);
        if (!row) return;
        const statusEl = row.querySelector('.status');
        if (!statusEl) return;

        statusEl.classList.remove('error');
        statusEl.textContent = '';

        if (kind === 'error') statusEl.classList.add('error');
        if (message) {
          const msg = document.createElement('div');
          msg.textContent = message;
          statusEl.appendChild(msg);
        }

        if (gerritUrl) {
          const link = document.createElement('a');
          link.href = '#';
          link.textContent = 'Open Gerrit';
          link.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'openExternal', url: gerritUrl });
          });
          statusEl.appendChild(link);
        }
      }

      function collectSelections() {
        /** @type {{ repoRoot: string, commitSha: string, targetBranch: string }[]} */
        const selections = [];
        for (const repo of model.repos) {
          const sel = state.selections[repo.repoRoot];
          if (!sel || !sel.include) continue;
          if (!sel.commitSha) throw new Error(\`Missing commit selection for \${repo.displayName || repo.repoRoot}\`);
          if (!sel.targetBranch)
            throw new Error(\`Missing target branch selection for \${repo.displayName || repo.repoRoot}\`);
          selections.push({ repoRoot: repo.repoRoot, commitSha: sel.commitSha, targetBranch: sel.targetBranch });
        }
        return selections;
      }

      els.selectAll.addEventListener('click', () => {
        for (const repo of model.repos) {
          state.selections[repo.repoRoot].include = true;
        }
        renderRows();
        persistState();
      });

      els.selectNone.addEventListener('click', () => {
        for (const repo of model.repos) {
          state.selections[repo.repoRoot].include = false;
        }
        renderRows();
        persistState();
      });

      els.openAfterPush.addEventListener('change', () => {
        state.openAfterPush = els.openAfterPush.checked;
        persistState();
      });

      els.push.addEventListener('click', () => {
        setError('');
        try {
          const selections = collectSelections();
          if (selections.length === 0) {
            setError('Please select at least one project to push.');
            return;
          }
          vscode.postMessage({ type: 'push', selections, openAfterPush: Boolean(state.openAfterPush) });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });

	      window.addEventListener('message', (event) => {
	        const msg = event.data;
	        if (!msg || typeof msg !== 'object') return;
	        if (msg.type === 'setBusy') {
	          setBusy(Boolean(msg.busy));
	          return;
	        }
	        if (msg.type === 'pushPrefixUpdated') {
	          const prefix = String(msg.pushPrefix || '').trim();
	          if (prefix) model.options.pushPrefix = prefix;
	          els.branchPrefixInput.value = String(model.options.pushPrefix || '').trim();
	          renderBranchList();
	          return;
	        }
	        if (msg.type === 'rewriteHistoryAcked') {
	          rewriteHistoryAcked = Boolean(msg.acked);
	          if (rewriteHistoryAcked) {
	            els.commitEditorRewriteAck.checked = true;
	            els.commitEditorRewriteAckRow.classList.add('hidden');
	          }
	          syncCommitEditorSaveState();
	          return;
	        }
		        if (msg.type === 'commitMessage') {
		          const repoRoot = String(msg.repoRoot || '').trim();
		          const commitSha = String(msg.commitSha || '').trim();
		          const message = String(msg.message || '');
		          const isHead = Boolean(msg.isHead);
	          const headSha = msg.headSha ? String(msg.headSha) : null;

	          if (
	            commitEditorState &&
	            commitEditorState.repoRoot === repoRoot &&
	            commitEditorState.commitSha === commitSha
	          ) {
		            commitEditorState.message = message;
		            commitEditorState.isHead = isHead;
		            commitEditorState.headSha = headSha;
		            commitEditorState.loaded = true;

		            els.commitEditorText.value = message;
		            if (isHead) {
		              els.commitEditorHint.textContent = 'Editing HEAD commit message. Note: staged changes must be empty.';
		              els.commitEditorRewriteAckRow.classList.add('hidden');
		              els.commitEditorSave.textContent = 'Save message';
		            } else {
		              const headShort = headSha ? headSha.slice(0, 7) : '(unknown)';
		              els.commitEditorHint.textContent =
		                'Editing a non-HEAD commit message rewrites history (rebase -i reword). Local changes will be auto-stashed and restored. SHAs will change. Current HEAD: ' +
		                headShort;
		              if (rewriteHistoryAcked) {
		                els.commitEditorRewriteAck.checked = true;
		                els.commitEditorRewriteAckRow.classList.add('hidden');
		              } else {
		                els.commitEditorRewriteAck.checked = false;
		                els.commitEditorRewriteAckRow.classList.remove('hidden');
		              }
		              els.commitEditorSave.textContent = 'Rewrite message';
		            }
		            syncCommitEditorSaveState();
		          }
		          return;
		        }
	        if (msg.type === 'rowStatus') {
	          setRowStatus(String(msg.repoRoot || ''), String(msg.kind || ''), String(msg.message || ''), msg.gerritUrl || '');
	          return;
	        }
	        if (msg.type === 'toast') {
          setError(String(msg.message || ''));
          return;
        }
      });

	      renderBranchList();
	      renderRows();
	      updateSummary();
	      persistState();
    </script>
  </body>
</html>`;
}

/**
 * @param {vscode.WebviewPanel} panel
 * @param {unknown} message
 * @param {vscode.OutputChannel} output
 */
async function handleBulkPanelMessage(panel, message, output) {
  if (!message || typeof message !== 'object') return;

  const anyMsg = /** @type {any} */ (message);
  const type = String(anyMsg.type ?? '');

  if (type === 'openExternal') {
    const url = String(anyMsg.url ?? '').trim();
    if (!url) return;
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch {
      vscode.window.showErrorMessage(`Failed to open URL: ${url}`);
    }
    return;
  }

  if (type === 'updateBranches') {
    try {
      const next = validateTargetBranchesList(anyMsg.targetBranches);
      await writeTargetBranchesOverride(next);
      if (bulkState) bulkState.options.targetBranches = next;

      const currentMap = readLastSelectedTargetBranchByRepo();
      const pruned = pruneLastSelectedTargetBranchByRepo(currentMap, next);
      if (pruned.changed) await writeLastSelectedTargetBranchByRepo(pruned.map);
      if (bulkState) bulkState.options.lastSelectedTargetBranchByRepo = pruned.map;

      const legacy = readLegacyLastSelectedTargetBranch();
      if (legacy && !next.includes(legacy)) await clearLegacyLastSelectedTargetBranch();
    } catch (e) {
      panel.webview.postMessage({ type: 'toast', message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  if (type === 'updatePushPrefix') {
    const cfg = vscode.workspace.getConfiguration('localGerritPush');
    const fallbackRemote = String(cfg.get('remote', 'origin') || 'origin').trim() || 'origin';
    const currentPrefix = bulkState?.options.pushPrefix ?? makeDefaultPushPrefix(fallbackRemote);

    try {
      const raw = String(anyMsg.pushPrefix ?? '').trim();
      const parsed = parseAndNormalizePushPrefix(raw, fallbackRemote);
      if (raw) {
        await writePushPrefixOverride(parsed.pushPrefix);
      } else {
        await writePushPrefixOverride('');
      }

      if (bulkState) {
        bulkState.options.pushPrefix = parsed.pushPrefix;
        bulkState.options.pushRemote = parsed.pushRemote;
      }
      panel.webview.postMessage({ type: 'pushPrefixUpdated', pushPrefix: parsed.pushPrefix });
    } catch (e) {
      panel.webview.postMessage({ type: 'toast', message: e instanceof Error ? e.message : String(e) });
      panel.webview.postMessage({ type: 'pushPrefixUpdated', pushPrefix: currentPrefix });
    }
    return;
  }

  if (type === 'rememberLastBranch') {
    const state = bulkState;
    const repoRoot = String(anyMsg.repoRoot ?? '').trim();
    const branch = String(anyMsg.targetBranch ?? '').trim();
    if (!repoRoot || !branch) return;

    const allowed = state?.options.targetBranches ?? [];
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(branch)) {
      panel.webview.postMessage({ type: 'toast', message: `Invalid target branch: ${branch}` });
      return;
    }

    const currentMap = readLastSelectedTargetBranchByRepo();
    const nextMap = { ...currentMap, [repoRoot]: branch };
    await writeLastSelectedTargetBranchByRepo(nextMap);
    if (bulkState) bulkState.options.lastSelectedTargetBranchByRepo = nextMap;
    return;
  }

  if (type === 'ackRewriteHistory') {
    await writeRewriteHistoryAcked(true);
    if (bulkState) bulkState.options.rewriteHistoryAcked = true;
    panel.webview.postMessage({ type: 'rewriteHistoryAcked', acked: true });
    return;
  }

  if (type === 'getCommitMessage') {
    const repoRoot = String(anyMsg.repoRoot ?? '').trim();
    const commitSha = String(anyMsg.commitSha ?? '').trim();
    if (!repoRoot || !commitSha) return;

    try {
      const message = await getCommitMessage(repoRoot, commitSha);
      const headSha = await tryGetHeadSha(repoRoot);
      const isHead = Boolean(headSha && headSha === commitSha);
      panel.webview.postMessage({ type: 'commitMessage', repoRoot, commitSha, message, isHead, headSha });
    } catch (e) {
      panel.webview.postMessage({ type: 'toast', message: formatExecError(output, e) });
    }
    return;
  }

  if (type === 'updateCommitMessage' || type === 'amendCommitMessage') {
    if (bulkPushInProgress) {
      vscode.window.showInformationMessage('A push is already in progress.');
      return;
    }

    const repoRoot = String(anyMsg.repoRoot ?? '').trim();
    const commitSha = String(anyMsg.commitSha ?? '').trim();
    const message = String(anyMsg.message ?? '');
    const allowRewrite = Boolean(anyMsg.allowRewrite);
    if (!repoRoot || !commitSha) return;

    panel.webview.postMessage({ type: 'setBusy', busy: true });
    try {
      const headSha = await tryGetHeadSha(repoRoot);
      if (!headSha) throw new Error('Failed to read HEAD.');
      const isHead = headSha === commitSha;

      if (isHead) {
        await amendHeadCommitMessage(repoRoot, message, output);
        panel.webview.postMessage({ type: 'toast', message: 'HEAD commit message updated. Rescanning...' });
      } else {
        if (!allowRewrite) {
          panel.webview.postMessage({
            type: 'toast',
            message:
              'Editing a non-HEAD commit rewrites history. Please confirm the checkbox in the editor panel before saving.'
          });
          return;
        }

        await rewriteCommitMessageByRebase(repoRoot, commitSha, message, output);
        panel.webview.postMessage({ type: 'toast', message: 'Commit message rewritten (history updated). Rescanning...' });
      }

      const refreshedMap = readLastSelectedTargetBranchByRepo();
      const rewriteHistoryAcked = readRewriteHistoryAcked();
      const state = bulkState;
      /** @type {{ pushRemote: string, pushPrefix: string, targetBranches: string[], openAfterPush: boolean, lastSelectedTargetBranchByRepo: Record<string, string>, rewriteHistoryAcked: boolean }} */
      let options;
      if (state) {
        options = { ...state.options, lastSelectedTargetBranchByRepo: refreshedMap, rewriteHistoryAcked };
      } else {
        const cfg = vscode.workspace.getConfiguration('localGerritPush');
        const cfgPushRemote = String(cfg.get('remote', 'origin') || 'origin').trim() || 'origin';
        const configuredTargetBranches = normalizeTargetBranches(cfg.get('targetBranches', []));
        const prefixOverride = readPushPrefixOverride();

        let pushRemote = cfgPushRemote;
        let pushPrefix = makeDefaultPushPrefix(cfgPushRemote);
        if (prefixOverride) {
          try {
            const parsed = parseAndNormalizePushPrefix(prefixOverride, cfgPushRemote);
            pushRemote = parsed.pushRemote;
            pushPrefix = parsed.pushPrefix;
          } catch {
            await writePushPrefixOverride('');
          }
        }

        options = {
          pushRemote,
          pushPrefix,
          targetBranches: configuredTargetBranches,
          openAfterPush: false,
          lastSelectedTargetBranchByRepo: refreshedMap,
          rewriteHistoryAcked
        };
      }

      const repos = await collectReposWithAheadCommits(output);
      if (repos.length === 0) {
        panel.webview.postMessage({ type: 'toast', message: 'No projects with commits ahead of upstream were found.' });
        return;
      }

      await showBulkPanelWithRepos(repos, options, output);
    } catch (e) {
      panel.webview.postMessage({ type: 'toast', message: formatExecError(output, e) });
    } finally {
      panel.webview.postMessage({ type: 'setBusy', busy: false });
    }
    return;
  }

  if (type !== 'push') return;

  if (bulkPushInProgress) {
    vscode.window.showInformationMessage('A push is already in progress.');
    return;
  }

  const state = bulkState;
  if (!state) return;

  const selections = Array.isArray(anyMsg.selections) ? anyMsg.selections : [];
  const openAfterPush = Boolean(anyMsg.openAfterPush ?? state.options.openAfterPush);

  /** @type {{ repoRoot: string, commitSha: string, targetBranch: string }[]} */
  const normalized = [];
  for (const sel of selections) {
    if (!sel || typeof sel !== 'object') continue;
    const repoRoot = String(sel.repoRoot ?? '').trim();
    const commitSha = String(sel.commitSha ?? '').trim();
    const targetBranch = String(sel.targetBranch ?? '').trim();
    if (!repoRoot || !commitSha || !targetBranch) continue;
    normalized.push({ repoRoot, commitSha, targetBranch });
  }

  if (normalized.length === 0) {
    panel.webview.postMessage({ type: 'toast', message: 'No valid selections to push.' });
    return;
  }

  /** @type {Map<string, RepoInfo>} */
  const repoByRoot = new Map(state.repos.map((r) => [r.repoRoot, r]));

  for (const sel of normalized) {
    const repo = repoByRoot.get(sel.repoRoot);
    if (!repo) {
      panel.webview.postMessage({
        type: 'rowStatus',
        repoRoot: sel.repoRoot,
        kind: 'error',
        message: 'Repository not found in current scan result.'
      });
      return;
    }

    if (!state.options.targetBranches.includes(sel.targetBranch)) {
      panel.webview.postMessage({
        type: 'rowStatus',
        repoRoot: sel.repoRoot,
        kind: 'error',
        message: `Invalid target branch: ${sel.targetBranch}`
      });
      return;
    }

    const commitExistsInList = repo.commits.some((c) => c.fullSha === sel.commitSha);
    if (!commitExistsInList) {
      panel.webview.postMessage({
        type: 'rowStatus',
        repoRoot: sel.repoRoot,
        kind: 'error',
        message: 'Selected commit is not in the ahead-commit list (please rescan).'
      });
      return;
    }
  }

  bulkPushInProgress = true;
  panel.webview.postMessage({ type: 'setBusy', busy: true });

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Pushing to Gerrit...'
      },
      async (progress) => {
        const total = normalized.length;
        for (let i = 0; i < normalized.length; i++) {
          const sel = normalized[i];
          const repo = repoByRoot.get(sel.repoRoot);
          if (!repo) continue;

          progress.report({
            message: `${repo.displayName} (${i + 1}/${total})`,
            increment: total > 0 ? (100 / total) : 0
          });

          panel.webview.postMessage({
            type: 'rowStatus',
            repoRoot: sel.repoRoot,
            kind: 'info',
            message: `Pushing ${sel.commitSha.slice(0, 7)} → ${sel.targetBranch}...`
          });

          output.appendLine('---');
          output.appendLine(`[${repo.displayName}] Pushing ${sel.commitSha} -> refs/for/${sel.targetBranch}`);

          try {
            const { gerritUrl } = await pushToGerrit(
              sel.repoRoot,
              state.options.pushRemote,
              sel.commitSha,
              sel.targetBranch,
              output
            );

            panel.webview.postMessage({
              type: 'rowStatus',
              repoRoot: sel.repoRoot,
              kind: 'success',
              message: 'Pushed.',
              gerritUrl
            });

            if (openAfterPush && gerritUrl) {
              await vscode.env.openExternal(vscode.Uri.parse(gerritUrl));
            }
          } catch (e) {
            const msg = formatExecError(output, e);
            panel.webview.postMessage({
              type: 'rowStatus',
              repoRoot: sel.repoRoot,
              kind: 'error',
              message: msg || 'Push failed.'
            });
          }
        }
      }
    );
  } finally {
    bulkPushInProgress = false;
    panel.webview.postMessage({ type: 'setBusy', busy: false });
  }
}

/**
 * @param {RepoInfo[]} repos
 * @param {{ pushRemote: string, pushPrefix: string, targetBranches: string[], openAfterPush: boolean, lastSelectedTargetBranchByRepo: Record<string, string>, rewriteHistoryAcked: boolean }} options
 * @param {vscode.OutputChannel} output
 */
async function showBulkPanelWithRepos(repos, options, output) {
  bulkState = { repos, options, output };

  if (bulkPanel) {
    bulkPanel.webview.html = getBulkWebviewHtml(bulkPanel.webview, repos, options);
    bulkPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'localGerritPush.bulkPanel',
    'Gerrit Review Push',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  bulkPanel = panel;
  panel.webview.html = getBulkWebviewHtml(panel.webview, repos, options);

  panel.onDidDispose(() => {
    bulkPanel = null;
    bulkState = null;
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      await handleBulkPanelMessage(panel, message, output);
    } catch (e) {
      output.appendLine(formatExecError(output, e));
      vscode.window.showErrorMessage('Gerrit Review Push failed. See output for details.');
    }
  });
}

/**
 * @param {vscode.OutputChannel} output
 */
async function openCommitPicker(output) {
  const cfg = vscode.workspace.getConfiguration('localGerritPush');
  const cfgPushRemote = String(cfg.get('remote', 'origin') || 'origin').trim() || 'origin';
  const configuredTargetBranches = normalizeTargetBranches(cfg.get('targetBranches', ['master']));
  const targetBranches = readTargetBranchesOverride() ?? configuredTargetBranches;
  const openAfterPush = Boolean(cfg.get('openAfterPush', false));

  const prefixOverride = readPushPrefixOverride();
  let pushRemote = cfgPushRemote;
  let pushPrefix = makeDefaultPushPrefix(cfgPushRemote);
  if (prefixOverride) {
    try {
      const parsed = parseAndNormalizePushPrefix(prefixOverride, cfgPushRemote);
      pushRemote = parsed.pushRemote;
      pushPrefix = parsed.pushPrefix;
    } catch (e) {
      output.appendLine(
        `Invalid stored push prefix override; resetting to default. (${e instanceof Error ? e.message : String(e)})`
      );
      await writePushPrefixOverride('');
      pushRemote = cfgPushRemote;
      pushPrefix = makeDefaultPushPrefix(cfgPushRemote);
    }
  }

  if (targetBranches.length === 0) {
    vscode.window.showErrorMessage('No target branches configured (localGerritPush.targetBranches is empty).');
    return;
  }

  output.show(true);
  output.appendLine('---');

  try {
    const repos = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Scanning workspace for ahead commits...'
      },
      async () => collectReposWithAheadCommits(output)
    );

    if (repos.length === 0) {
      vscode.window.showInformationMessage('No projects with commits ahead of upstream were found in this workspace.');
      return;
    }

    let lastSelectedTargetBranchByRepo = readLastSelectedTargetBranchByRepo();
    const legacy = readLegacyLastSelectedTargetBranch();

    if (legacy && targetBranches.includes(legacy) && Object.keys(lastSelectedTargetBranchByRepo).length === 0 && repos.length === 1) {
      const seeded = { ...lastSelectedTargetBranchByRepo, [repos[0].repoRoot]: legacy };
      await writeLastSelectedTargetBranchByRepo(seeded);
      await clearLegacyLastSelectedTargetBranch();
      lastSelectedTargetBranchByRepo = seeded;
    } else if (legacy && !targetBranches.includes(legacy)) {
      await clearLegacyLastSelectedTargetBranch();
    }

    const pruned = pruneLastSelectedTargetBranchByRepo(lastSelectedTargetBranchByRepo, targetBranches);
    if (pruned.changed) {
      await writeLastSelectedTargetBranchByRepo(pruned.map);
      lastSelectedTargetBranchByRepo = pruned.map;
    }

    const rewriteHistoryAcked = readRewriteHistoryAcked();
    const options = { pushRemote, pushPrefix, targetBranches, openAfterPush, lastSelectedTargetBranchByRepo, rewriteHistoryAcked };
    await showBulkPanelWithRepos(repos, options, output);
  } catch (e) {
    output.appendLine(formatExecError(output, e));
    vscode.window.showErrorMessage('Failed to scan workspace repositories. See output for details.');
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  extensionContext = context;

  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(cloud-upload) Review Push';
  status.tooltip = 'Pick an ahead commit and push it to Gerrit for review (refs/for/...)';
  status.command = 'localGerritPush.openPicker';
  context.subscriptions.push(status);
  status.show();

  const disposable = vscode.commands.registerCommand('localGerritPush.openPicker', async () => {
    await openCommitPicker(output);
  });
  context.subscriptions.push(disposable);

}

function deactivate() {}

module.exports = { activate, deactivate };
