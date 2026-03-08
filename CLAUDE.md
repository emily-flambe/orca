# Orca — Project Instructions

## Creating Linear Issues

When creating Linear issues via MCP, always reference `docs/linear_issue_templates.md` and apply the appropriate template structure based on issue type (Feature Implementation, Bug Fix, Refactor, Feature Planning, or Discovery). Fill in all sections with real content — never leave placeholder text in the final issue.

## Git Workflow — PRs Are Mandatory

**NEVER push directly to main.** All changes must go through a pull request.

As an agent session, you MUST:
1. Work on the feature branch already checked out in your worktree — do not switch to main
2. Push your branch: `git push -u origin HEAD`
3. Open a PR: `gh pr create --fill`
4. Do NOT merge the PR — the orchestrator handles merging after CI passes

Direct pushes to main bypass CI checks and are not allowed.

## Deploying Changes

Deployment is **automatic** after a PR is merged to main — the orchestrator runs the deploy script. Agent sessions do NOT need to deploy manually.

For manual/emergency deploys only:

### How to deploy

```bash
bash /c/Users/emily/Documents/Github/orca/scripts/deploy.sh
```

This script handles everything: pull, install, frontend rebuild, kill old process, start new process with log redirection to `orca.log`.

**Do NOT start Orca manually** — always use `scripts/deploy.sh` to ensure consistent behavior.
