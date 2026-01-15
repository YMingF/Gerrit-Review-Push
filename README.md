# Gerrit Review Push

This is a small VSCode extension used locally in this workspace.

The extension activates in all workspaces by default.

## What it does

- Adds a status bar button: `Gerrit Push`
- Scans the workspace and detects projects with commits that are **ahead of upstream** (i.e. not yet contained in the upstream remote branch)
- Opens a single window to bulk push:
  - Select which projects to push
  - For each project, pick **one** commit (pushing the newest commit will include its parent commits in the push)
  - Pick a target branch (`refs/for/<branch>`)
- Manage target branches in the same window (add / edit / delete). Changes are saved locally (workspaceState) and do not touch git.
- Configure the Gerrit push command prefix (defaults to `push origin $SHA:refs/for/`). After you set it once, adding/editing branches only needs the branch name (e.g. `feature/1.1.0`).
- If there are multiple target branches, you must select one once; the extension remembers the **last selected** branch per project and auto-selects it next time.
- Edit the selected commit message:
  - If the selected commit is `HEAD`: uses `git commit --amend` (message only; requires **no staged changes**).
  - If the selected commit is **not** `HEAD`: uses a scripted `git rebase -i` with `reword` (this **rewrites history** and will change SHAs). It runs with `--autostash` by default, so dirty working trees are OK. If it fails, you may need `git rebase --abort` (and check `git stash list`).
  - The first time you rewrite history, the UI will ask you to confirm once; it remembers your acknowledgement for this workspace.
- Optional: open Gerrit in browser after push

> Note: Gerrit review-push (`refs/for/...`) does **not** update the remote branch head. A commit will remain "ahead of upstream" until it is merged into the remote branch.

## Install (local)

### Option A: Install from VSIX (recommended for daily use)

From `.local-vscode/vscode-gerrit-push`:

```bash
npx -y @vscode/vsce package
```

Then in VSCode:
- `Extensions: Install from VSIX...`
- Select the generated `.vsix` file.

### Option B: Run in Extension Development Host (for testing)

Open this folder in VSCode and press `F5` (Run Extension).

## Notes / Pitfalls

- Upstream must be configured (`@{u}` must work). If not, set it via `git push -u origin <branch>` or `git branch --set-upstream-to=origin/<branch>`.
- Git credential prompts are disabled (`GIT_TERMINAL_PROMPT=0`) to avoid hanging the extension host. If your SSH key needs a passphrase, ensure you have an agent running.
- For speed, scanning uses the local upstream ref (`@{u}`) and does not contact the remote. If your upstream tracking branch is stale, run `git fetch` or enable `localGerritPush.verifyRemoteHead` (slower).

## Settings

Open VSCode Settings and search for `Gerrit Review Push`:

- `localGerritPush.remote` (default: `origin`)
- `localGerritPush.targetBranches` (default: `["master"]`). This is the default list, but if you edit branches in the UI, the local UI list overrides it.
- `localGerritPush.limit` (default: `50`)
- `localGerritPush.verifyRemoteHead` (default: `false`). When enabled, uses `git ls-remote` to verify the remote branch head (more accurate, but slower).
- `localGerritPush.openAfterPush` (default: `false`)
