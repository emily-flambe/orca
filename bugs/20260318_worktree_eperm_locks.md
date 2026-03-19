# Bug Report: WorktreeLockedError EPERM blocks task dispatch on Windows

**Date:** 2026-03-18
**Severity:** Medium
**Status:** Fixed
**Fixed in:** `93402ac` (2026-03-18)

## Summary

On Windows, orphaned Claude sessions leave filesystem locks on worktree directories. When Orca tries to create a new worktree for the same task, `rmSync` fails with EPERM even after killing known processes. The task enters a retry loop where every dispatch attempt fails with `WorktreeLockedError`.

## Symptoms

- 242 `WorktreeLockedError` occurrences across PM2 error logs
- Affected worktrees: `xikipedia-EMI-25`, `xikipedia-EMI-47`, `xikipedia-EMI-81`, `orca-EMI-321`, `orca-EMI-329`
- Tasks retry every 5 minutes but fail repeatedly until the lock is manually cleared or the machine reboots
- EMI-81 hit this for 6+ hours straight (16:02-18:05 local time on 2026-03-18)

## Root Cause

`src/worktree/index.ts:263-267`:

```typescript
// After killing processes and retrying rmSync, still EPERM
throw new WorktreeLockedError(
  `Worktree directory is locked (processes killed but EPERM persists): ${worktreePath}`
);
```

On Windows, file handles can be held by:
- Antivirus scanners (Windows Defender real-time protection)
- Git index.lock files from interrupted git operations
- Node.js file watchers from the Claude Code CLI
- Windows Search Indexer
- VSCode or other editors with the directory open

The existing retry logic kills known process trees but doesn't handle these external lock holders.

## Impact

- Tasks blocked from dispatch until locks clear (often requires reboot)
- Each failed dispatch burns a reconciliation cycle
- Contributes to `staleSessionRetryCount` accumulation

## Fix

Options (in order of preference):
1. Use a different worktree path on retry (append `-retry-N` suffix) instead of trying to reuse the locked path
2. Use Windows `handle.exe` (Sysinternals) to find and close the specific file handles
3. Add a longer backoff with jitter before EPERM retry (current retry may be too fast for antivirus to release)
4. Schedule locked directory cleanup via `cmd /c rd /s /q` in a delayed subprocess

## Timeline

| Time (UTC) | Event |
|------------|-------|
| Ongoing | EPERM locks persist after session kills, blocking dispatch |
| 2026-03-19 02:30 | Quantified: 242 occurrences in error logs |
