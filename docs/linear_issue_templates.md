# Linear Issue Templates

Use these templates when creating Linear issues via MCP. Apply the appropriate structure based on the issue type.

---

## Feature Implementation

**Title prefix:** `[Feature] `

```
repo: <path>

## Goal

<What needs to be built and why. 2-3 sentences max.>

## Implementation Notes

<Optional: constraints, patterns to follow, libraries to use, things to avoid.>

## Key Files

* <File or directory most likely to be modified>
* <File or directory most likely to be modified>

## Acceptance Criteria

- [ ] <Specific, verifiable outcome>
- [ ] <Specific, verifiable outcome>
- [ ] `npm run build` succeeds with no TypeScript errors
```

---

## Bug Fix

**Title prefix:** `[Bug] `

```
repo: <path>

## Problem

<What is broken. Include error message or unexpected behavior verbatim if possible.>

## Steps to Reproduce

1.
2.
3.

## Expected Behavior

<What should happen.>

## Suspected Cause

<Optional: where you think the bug is, if known.>

## Key Files

* <File most likely containing the bug>

## Acceptance Criteria

- [ ] The bug no longer reproduces following the steps above
- [ ] No regressions in related functionality
- [ ] `npm run build` succeeds with no TypeScript errors
```

---

## Refactor

**Title prefix:** `[Refactor] `

```
repo: <path>

## Goal

<What is being cleaned up and why — performance, maintainability, duplication, etc.>

## Scope

<What's in scope. Be explicit about what's OUT of scope to prevent over-engineering.>

## Key Files

* <File or directory to refactor>

## Acceptance Criteria

- [ ] <Specific structural outcome, e.g. "no duplicate X remains">
- [ ] Behavior is identical before and after — no functional changes
- [ ] `npm run build` succeeds with no TypeScript errors
```

---

## Feature Planning

**Title prefix:** `[Planning] `

```
repo: <path>

## Problem

<What user need or technical gap is this addressing? Why does it matter?>

## Proposed Approach

<High-level description of the solution. Not implementation details — the shape of the solution.>

## Open Questions

- [ ] <Decision that needs to be made before or during implementation>
- [ ] <Assumption that needs to be validated>

## Out of Scope

<Explicitly list what this does NOT cover to prevent scope creep.>

## Sub-Issues

<Break down into child tickets once approach is agreed:>

- [ ]
- [ ]
- [ ]

## Acceptance Criteria

- [ ] <High-level outcome — what does "done" look like for the overall feature?>
- [ ] `npm run build` succeeds with no TypeScript errors
```

---

## Discovery

**Title prefix:** `[Discovery] `

```
repo: <path>

## Goal

<What question is this discovery trying to answer, or what decision is it trying to inform?>

## Background

<Context needed to do this work. Links to relevant code, docs, prior discussions.>

## Tasks

- [ ] <Specific research or investigation step>
- [ ] <Specific research or investigation step>

## Out of Scope

<What this discovery is NOT trying to answer.>

## Definition of Done

This issue is complete when the following have been filed as standalone issues:

- [ ] <Issue to be created>
- [ ] <Issue to be created>

## Notes

<Findings, decisions, and reasoning captured here as work progresses.>
```
