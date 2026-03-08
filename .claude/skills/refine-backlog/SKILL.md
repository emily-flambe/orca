---
name: refine-backlog
description: Backlog refinement workflow for Linear. Fetches all Backlog-status issues, rewrites descriptions to match templates, verifies acceptance criteria, re-evaluates priority, and cancels tickets that don't matter. Use when the user asks to "refine the backlog" or "clean up tickets".
argument-hint: "[project name or 'all']"
---

Run a full backlog refinement pass on Linear issues.

## Argument
`$ARGUMENTS` may specify a project name (e.g. "Orca", "Xikipedia") or be empty/`all` to process every backlog ticket.

## Step 1 — Fetch backlog issues

Use `list_issues` with `state: "Backlog"` and `includeArchived: false`. If `$ARGUMENTS` specifies a project, filter to that project.

## Step 2 — Batch into parallel subagents

Group issues into batches of 4–6 by topic area (e.g. security, testing, UI, core features). Spawn one general-purpose subagent per batch, all running in parallel. Do not process tickets serially yourself — delegate everything to subagents.

Each subagent should:
1. `get_issue` to fetch the full description (list results are truncated)
2. Evaluate the ticket (see criteria below)
3. Apply the appropriate template (see templates below)
4. Call `save_issue` to update description, priority, and/or state

## Step 3 — Report results

After all subagents complete, summarise what changed: tickets cancelled, priority bumps/drops, and descriptions rewritten.

---

## Evaluation Criteria

For each ticket, decide:

**Cancel (set state to "Cancelled") if:**
- The feature/bug is already implemented in the codebase
- It duplicates another ticket
- It describes speculative work with no clear value
- It was created for context that no longer applies

**Bump priority up if:**
- It's a security issue → at minimum High (2)
- It blocks other tickets that are in progress
- It's a production bug affecting users

**Drop priority if:**
- It's purely cosmetic with no functional impact
- It's a nice-to-have with no clear use case

**Rewrite description if:**
- It doesn't match a template (see below)
- Acceptance criteria are missing, vague, or unverifiable
- The `repo:` line is missing on implementation tickets

---

## Templates

Reference `docs/linear_issue_templates.md` in this repository for the full templates. Summary:

### Feature Implementation — use when shipping new functionality
```
repo: <absolute path to repo>

## Goal
<2-3 sentences: what and why>

## Implementation Notes
<Constraints, approach, things to avoid>

## Key Files
* <most likely modified files/dirs>

## Acceptance Criteria
- [ ] <specific, verifiable outcome>
- [ ] `npm run build` succeeds with no TypeScript errors
```

### Bug Fix — use when fixing broken behaviour
```
repo: <absolute path to repo>

## Problem
<What is broken — include error text or unexpected behaviour verbatim>

## Steps to Reproduce
1.
2.

## Expected Behavior
<What should happen>

## Suspected Cause
<Optional — include file:line if known>

## Key Files
* <file most likely containing the bug>

## Acceptance Criteria
- [ ] Bug no longer reproduces following the steps above
- [ ] No regressions in related functionality
- [ ] Build succeeds
```

### Refactor — use for cleanup with no behaviour change
```
repo: <absolute path to repo>

## Goal
<What is being cleaned up and why>

## Scope
<In scope. Explicitly list what is OUT of scope.>

## Key Files
* <file or directory to refactor>

## Acceptance Criteria
- [ ] <specific structural outcome>
- [ ] Behaviour is identical before and after — no functional changes
- [ ] Build succeeds
```

### Feature Planning — use for large features broken into sub-issues
```
## Problem
<What need or gap this addresses>

## Proposed Approach
<High-level shape of the solution — not implementation details>

## Open Questions
- [ ] <decision needed before implementation>

## Out of Scope
<Explicitly list what this does NOT cover>

## Sub-Issues
- [ ] <child ticket identifier and title>

## Acceptance Criteria
- [ ] <high-level outcome>
```

### Discovery — use for research that produces other tickets (not code)
```
repo: <absolute path to repo>

## Goal
<What question this discovery is trying to answer>

## Background
<Context, links to relevant code or prior discussions>

## Tasks
- [ ] <specific research step>

## Out of Scope
<What this is NOT trying to answer>

## Definition of Done
This issue is complete when the following have been filed as standalone issues:
- [ ] <issue to be created>

## Notes
<Findings captured here as work progresses>
```

---

## Known repo paths

- Orca: `C:\Users\emily\Documents\Github\orca`
- Xikipedia: repo path unknown — use placeholder `repo: <xikipedia repo path>`

---

## AC quality bar

Acceptance criteria must be:
- **Specific**: names exact files, endpoints, or UI elements
- **Verifiable**: pass/fail without subjective judgment
- **Complete**: covers the happy path and at least one edge case for bugs

Do not accept: "works correctly", "looks good", "no regressions" (alone), or "tests pass" without specifying which tests.
