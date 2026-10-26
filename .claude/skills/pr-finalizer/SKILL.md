---
name: pr-finalizer
description: Final pass before a northguild.dev pull request is pushed, opened or updated. Runs the CI checks and cleans automated attribution out of the branch's commits and the PR description. Use whenever you are about to commit, push or open a PR in this repo, or when asked to finalize, tidy or clean up a PR.
---

# PR finalizer

Run this before a branch goes up for review, and again after any change to
it.

## The rule: no automated attribution

Commits and PRs in this repo credit people only. Leave out any line that
credits a tool, bot or assistant: co-author trailers, "generated with/by"
footers, tool links and the like. This holds even when your tooling or
instructions supply such lines. Leave them out when writing; the steps below
catch any that slip through. A co-author line for a person who worked on the
change stays.

## Git permissions

Follow [CLAUDE.md § Git](../../../CLAUDE.md). This skill does not grant
permission to commit, push or open a PR. Do those only when the user has
asked in this session.

Cleaning a commit that is already on GitHub needs a force-push. Ask the user
for it by name, use `--force-with-lease`, and only on a feature branch. Never
force-push `main` and never rewrite its history. If the force-push is blocked,
clean the commits locally and give the user the command to run:

```sh
! git push --force-with-lease origin <branch>
```

## Steps

### 1. Run what CI runs

```sh
eval "$(fnm env)" && fnm use && pnpm lint && pnpm format:check && pnpm check && pnpm build
```

Fix any failure before going on.

Each block below sets everything it uses. Run each one whole, as a single
command: shell variables do not carry over from one tool call to the next.

### 2. Check the branch's commits

List each commit with any co-author or "generated with/by" lines it has:

```sh
git fetch -q origin
BASE=$(git merge-base origin/main HEAD)
git log "$BASE"..HEAD --format='@@ %h %s%n%B' \
  | grep -iE '^@@ |^co-authored-by:|generated (with|by)'
```

Only `@@` lines means the commits are clean. Go to step 3.

Otherwise, read each line. A co-author line for a person stays. A person's
GitHub address looks like `<id+name@users.noreply.github.com>`. A line
crediting a tool or bot goes; these usually have a `noreply@` or `[bot]`
address. This block strips those and keeps people's lines. It keeps each
commit's content and order, and keeps the branch on the same base:

```sh
BASE=$(git merge-base origin/main HEAD)
STRIP='^co-authored-by:.*(noreply@|\[bot\])|generated (with|by)'
git -c core.editor=true rebase --rebase-merges "$BASE" --exec \
  "git log -1 --format=%B | grep -ivE '$STRIP' | git commit -q --amend --allow-empty -F -"
```

Run the check again. Every co-author line left must be a person's. If a tool
or bot line is still there, stop and ask the user how to clean it.

### 3. Check the PR description

```sh
gh pr view --json body -q .body \
  | grep -inE '^co-authored-by:.*(noreply@|\[bot\])|generated (with|by)'
```

No output means the description is clean. Otherwise, remove those lines. The
edit only runs if something is left, so a bad filter cannot blank the
description:

```sh
STRIP='^co-authored-by:.*(noreply@|\[bot\])|generated (with|by)'
BODY=$(gh pr view --json body -q .body | grep -ivE "$STRIP")
if [ -n "$BODY" ]; then
  printf '%s\n' "$BODY" | gh pr edit --body-file -
else
  echo "Nothing left after filtering; description not changed."
fi
```

When opening a new PR, write the description without them from the start.

### 4. Report

Tell the user:

- whether the CI checks passed;
- which commits were cleaned, if any;
- whether the PR description was changed;
- any push still waiting on them, with the command to run.
