# Gerrit Review Push

Bulk-select “commits not yet merged to upstream” across multiple projects in one panel, and push them to Gerrit `refs/for/<branch>` to start a review. You can also manage target branches, configure the push prefix, and edit commit messages directly in the panel.

> Best for: teams using the Gerrit review workflow (`refs/for/*`).

---

## What it can do

- **One-click entry in the Status Bar**: click `Review Push` to open the panel.
- **Scan the current workspace**: find repos in the workspace that are **ahead of upstream**, and list commits you can push.
- **Bulk push (one window)**:
  - Select which projects to push (Select all / Select none)
  - Each project can pick **only one commit** (pushing the newest commit will also include its parent commits; this is the common Gerrit review-push behavior)
  - Choose a target branch for each project (`refs/for/<branch>`)
- **Manage target branches**: Add / Edit / Delete branches in the panel (saved locally; does not modify your repo files).
- **Configurable push prefix**: save `push <remote> $SHA:refs/for/` once; after that, adding/editing branches only needs the branch name (e.g. `feature/1.1.0`).
- **Open Gerrit after push**: when enabled, the extension opens the Gerrit page automatically after a successful push.
- **Edit commit message (in the panel)**:
  - Click `Edit msg` to edit the selected commit message.
  - `HEAD`: uses `git commit --amend` (message only)
  - Non-`HEAD`: uses a scripted `git rebase -i` + `reword` (rewrites history; SHAs will change)

---

## How to use (step-by-step)

1. Open a Git repo (single project), or a workspace that contains multiple Git repos (multi-project).
2. Click `Review Push` in the VSCode status bar.
   1. ![Open panel from status bar](image/README.en/1768447918646.png)
3. The panel scans your opened repos and only lists projects that have “review-pushable” commits (i.e. repos that are ahead of upstream):
   - **Project**: project name + current branch
   - **Commit**: commits that are ahead of upstream
   - **Target branch**: the branch you want to review-push to
4. (Optional) enable `Open Gerrit after push`.
5. Click `Push selected`.

---

## Target branches & Prefix

### 1) Prefix (set once)

In the `Target branches` panel, there is a `Command prefix` input:

- Required format: `push <remote> $SHA:refs/for/`
- Example: `push origin $SHA:refs/for/`

It is saved locally. All branch commands will be built from this prefix.

### 2) Branch list

- Default branch: `master`
- In the UI you can:
  - `Add branch`: add a branch name like `feature/1.1.0`
  - `Edit`: rename the branch
  - `Delete`: remove the branch (at least one branch must remain)

---

## Edit commit message (important: it can rewrite history)

### HEAD commit

- Uses `git commit --amend` to update the message.
- **Requirement**: no staged changes (otherwise amend may include staged changes).

### Non-HEAD commit

- Uses `git rebase -i` with `reword`.
- **Rewrites history**: the selected commit and all descendant commits will get new SHAs.
- The extension asks you to acknowledge this once; after that it won’t ask again.
