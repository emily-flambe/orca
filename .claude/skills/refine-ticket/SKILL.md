---
name: refine-ticket
description: Refine a single Linear issue. Fetches the full issue, picks the right template, rewrites the description, verifies acceptance criteria, re-evaluates priority, and cancels if not worth doing. Use when the user asks to refine, clean up, or fix a specific ticket.
argument-hint: "<issue-id>"
---

Refine a single Linear issue: `$ARGUMENTS`

## Steps

1. **Fetch** the full issue with `get_issue` (list results are truncated)
2. **Evaluate** using the criteria below
3. **Act** — update via `save_issue`, or cancel by setting state to "Cancelled"
4. **Report** — summarise what changed and why

---

## Evaluation Criteria

**Cancel (state → "Cancelled") if:**
- Already implemented in the codebase (check before assuming)
- Duplicates another open ticket
- Speculative work with no clear value
- Context that created it no longer applies

**Bump priority up if:**
- Security issue → at minimum High (2)
- Blocks other in-progress tickets
- Production bug affecting real users

**Drop priority if:**
- Purely cosmetic, no functional impact
- Nice-to-have with no concrete use case

**Rewrite description if:**
- Doesn't match a template (see below)
- Acceptance criteria are missing, vague, or unverifiable
- `repo:` line missing on an implementation ticket
- Description is a single sentence with no structure

---

## Templates

Choose the best fit. Full templates are in `docs/linear_issue_templates.md`.

### Feature Implementation
Use when shipping new functionality.
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

### Bug Fix
Use when fixing broken behaviour.
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

### Refactor
Use for cleanup with no behaviour change.
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

### Feature Planning
Use for large features broken into sub-issues. No `repo:` line — not meant for direct implementation.
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

### Discovery
Use for research that produces other tickets, not code.
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

## AC Quality Bar

Acceptance criteria must be:
- **Specific** — names exact files, endpoints, or UI elements
- **Verifiable** — clear pass/fail, no subjective judgment
- **Complete** — covers the happy path and at least one edge case for bugs

Reject: "works correctly", "looks good", "no regressions" (alone), "tests pass" without specifying which tests.

---

## Known repo paths

- Orca: `C:\Users\emily\Documents\Github\orca`
- Xikipedia: repo path unknown — use placeholder `repo: <xikipedia repo path>`
