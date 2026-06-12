---
name: lint-and-fix
description: Use when preparing a commit, opening or reviewing a pull request, cutting a release, or triaging a code-style/lint-related issue. Runs ESLint + Prettier, tsc --noEmit, Stylelint (CSS/Tailwind), and markdown/yaml/json linters against changed files only, auto-fixes what's safe, then stages fixes and opens a PR. Triggers on "lint", "fix lint", "format code", "before commit", "pre-PR check", "release checklist", "CI is red".
---

# Lint and fix

Lint only what changed, fix what can be fixed safely, and surface the rest as a review checklist on a PR.

## When to use

- About to commit, open a PR, or publish a release.
- A code-style / lint issue is filed or CI is red on lint.
- User says "clean this up", "fix the lint errors", "format before PR".

Do **not** trigger on broad refactors or feature work — this skill is scoped to mechanical lint/format fixes, not behavior changes.

## Environment guardrail

Inside the Lovable sandbox, stateful git commands (`add`, `commit`, `checkout`, `push`, …) are blocked — the platform owns git state. If running there, do steps 1–3 only and report the diff; skip steps 4–5 and tell the user to commit via the Lovable UI. Steps 4–5 apply when this skill runs in a local checkout or CI.

## Workflow

Overview: diff → lint changed files → auto-fix → stage → PR.

1. **Determine base and changed files.**
   ```sh
   BASE="${BASE:-$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')}"
   git fetch origin "$BASE" --quiet
   CHANGED=$(git diff --name-only --diff-filter=ACMR "origin/$BASE"...HEAD)
   ```
   If `CHANGED` is empty, stop and say so — nothing to lint.

2. **Run the linters scoped to changed files.** Run them in parallel; collect exit codes; never abort on the first failure — the user wants the full report.

   | Files matched | Tool | Command |
   | --- | --- | --- |
   | `*.{ts,tsx,js,jsx,mjs,cjs}` | ESLint | `npx eslint --max-warnings=0 <files>` |
   | `*.{ts,tsx,js,jsx,json,md,yml,yaml,css}` | Prettier | `npx prettier --check <files>` |
   | `*.{ts,tsx}` anywhere | TypeScript | `npx tsc --noEmit` (whole project — types are global) |
   | `*.{css,scss}` | Stylelint | `npx stylelint <files>` |
   | `*.md` | markdownlint | `npx markdownlint-cli2 <files>` |
   | `*.{yml,yaml}` | yamllint | `yamllint <files>` |
   | `*.json` | jsonlint | `npx jsonlint -q <files>` |

   Skip any tool whose config file (`eslint.config.*`, `.prettierrc*`, `stylelint.config.*`, `.markdownlint*`, `.yamllint*`) is absent — don't impose tools the project hasn't adopted.

   **Success:** every tool ran (exit 0 or non-0); none crashed on missing binary. A non-zero exit is data, not a failure.

3. **Apply safe auto-fixes.** Only the tools below are safe to auto-fix without review; the rest produce report-only output the user must approve.
   ```sh
   npx eslint --fix <files>
   npx prettier --write <files>
   npx stylelint --fix <files>
   npx markdownlint-cli2 --fix <files>
   ```
   `tsc`, `yamllint`, and `jsonlint` are **report-only** — never rewrite YAML/JSON automatically (whitespace and key ordering carry meaning in some configs) and never silence type errors by editing types speculatively.

4. **Stage and commit fixes.** Re-run `git diff --name-only` to capture what the fixers touched, then:
   ```sh
   git add -- $(git diff --name-only)
   git commit -m "chore(lint): auto-fix lint and formatting"
   ```
   Skip if the working tree is clean after step 3.

5. **Open a PR with the remaining (non-auto-fixable) findings as the description.**
   ```sh
   BRANCH="lint/auto-fix-$(date +%Y%m%d-%H%M%S)"
   git checkout -b "$BRANCH"
   git push -u origin "$BRANCH"
   gh pr create --fill --body "$(cat <<'EOF'
   ## Auto-fixed
   - <list tools that wrote changes>

   ## Needs review
   - <unfixed eslint errors, tsc errors, stylelint warnings, etc. — file:line — rule — message>
   EOF
   )"
   ```
   **Success:** `gh pr view --json url` returns a URL.

## Conventions

- **Scope discipline.** Only touch files in `CHANGED`. Don't reformat the repo "while you're there" — that buries real review in noise. If the user explicitly asks for a repo-wide pass, run a separate commit so it's revertable on its own.
- **No rule disables to silence findings.** `// eslint-disable-next-line` and `@ts-ignore` are escape hatches for the human author, never for the lint-fixer. Surface the finding in the PR body instead.
- **Type errors block the PR's "ready" state.** Open it as draft if `tsc` reported errors; mark ready only when types are clean.
- **Bundler / package manager.** Use `npx` for tool invocation so the skill works across npm/pnpm/yarn/bun without branching. If the project pins a manager in `packageManager`, swap `npx` for that runner.

## Edge cases

- **Detached HEAD or no `origin/HEAD`.** Step 1 fails. Fall back to `BASE=main` then `BASE=master`; if neither exists, ask the user for the base branch.
- **Generated files in the diff** (`*.lock`, `dist/**`, `*.generated.*`). Exclude them from `CHANGED` before running tools — they'll re-generate next build and lint output on them is noise.
- **Pre-commit hook re-runs the same tools.** Expected; the commit in step 4 should be a no-op for the hook. If the hook still rewrites files, amend with `--no-edit`.
- **`gh` not installed or not authenticated.** Stop at step 4; print the branch name and ask the user to open the PR manually.
