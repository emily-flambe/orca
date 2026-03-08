---
name: refine-backlog
description: Backlog refinement workflow for Linear. Fetches all Backlog-status issues and applies the refine-ticket process to each one in parallel via subagents. Use when the user asks to "refine the backlog" or "clean up tickets".
argument-hint: "[project name or 'all']"
---

Run a full backlog refinement pass on Linear issues.

## Argument
`$ARGUMENTS` may specify a project name (e.g. "Orca", "Xikipedia") or be empty/`all` to process every backlog ticket.

## Step 1 — Fetch backlog issues

Use `list_issues` with `state: "Backlog"` and `includeArchived: false`. If `$ARGUMENTS` specifies a project, filter to that project.

## Step 2 — Batch into parallel subagents

Group issues into batches of 4–6 by topic area (e.g. security, testing, UI, core features). Spawn one general-purpose subagent per batch, all running in parallel.

Each subagent applies the **`/refine-ticket` process** to every issue in its batch. The full logic is defined in `.claude/skills/refine-ticket/SKILL.md` — read that file and follow it exactly for each ticket. In summary, each ticket gets:

1. `get_issue` to fetch the full description
2. Evaluated against the cancel/priority/rewrite criteria
3. Rewritten to the appropriate template if needed
4. Updated via `save_issue` (or cancelled)

Do not process tickets serially yourself — delegate everything to subagents.

## Step 3 — Report results

After all subagents complete, summarise what changed: tickets cancelled, priority bumps/drops, and descriptions rewritten.
