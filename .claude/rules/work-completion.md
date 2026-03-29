---
alwaysApply: true
---

# STOP. You are not done.

**If you just edited source code and are about to say "Done" — you are NOT done.**

Editing files is step 1 of 6. The full loop for Orca:

1. **Edit** source files
2. **Build** — `npm run build` (backend) + `cd web && npm run build` (frontend if touched)
3. **Test** — `npm test` + `cd web && npm test` (if frontend touched)
4. **Lint/format** — `npm run lint` + `npm run format:check`
5. **Commit and push** — `git add`, `git commit`, `git push`
6. **Deploy** — `bash /c/Users/emily/Documents/Github/orca/scripts/deploy.sh`

**You MUST complete every applicable step before responding to the user.** Do not stop after editing. Do not ask. Do not announce. Just do it.

## The failure this prevents

Claude edits a file, says "Done." and STOPS. The user has to ask "did you commit and push and deploy?" This has happened 3+ times. It is the user's #1 frustration.

## Self-check before ANY completion message

Before writing "Done", "Finished", "That should do it", etc.:

- [ ] Build passed?
- [ ] Tests passed?
- [ ] Changes committed and pushed?
- [ ] Deployed via deploy.sh?
- [ ] Verified the change works post-deploy?

If ANY box is unchecked, keep working. Do not respond yet.
