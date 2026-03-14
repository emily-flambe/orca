// Monitoring helper — query orca API for ticket states
const PORT = process.argv[2] || '4000';
const BASE = `http://localhost:${PORT}`;
const IDS = ['EMI-214','EMI-222','EMI-223','EMI-224','EMI-230','EMI-231','EMI-232'];

async function main() {
  // Fetch tasks
  const tasksRes = await fetch(`${BASE}/api/tasks`);
  const tasks = await tasksRes.json();
  const monitored = tasks.filter(t => IDS.includes(t.linearIssueId));

  // Fetch running invocations
  const runRes = await fetch(`${BASE}/api/invocations/running`);
  const running = await runRes.json();
  const monitoredRunning = running.filter(i => IDS.includes(i.linearIssueId));

  // Print task table
  console.log('TASKS:');
  for (const t of monitored) {
    const runInv = monitoredRunning.find(i => i.linearIssueId === t.linearIssueId);
    const phase = runInv ? runInv.phase : '-';
    const invId = runInv ? runInv.id : '-';
    console.log(JSON.stringify({
      id: t.linearIssueId,
      status: t.orcaStatus,
      retries: t.retryCount,
      reviews: t.reviewCycleCount,
      branch: t.prBranchName || null,
      pr: t.prNumber || null,
      phase,
      invId,
    }));
  }

  // Missing tickets
  const found = new Set(monitored.map(t => t.linearIssueId));
  const missing = IDS.filter(id => !found.has(id));
  if (missing.length > 0) {
    console.log('MISSING:', missing.join(', '));
  }

  console.log('SUMMARY:', JSON.stringify({
    total: tasks.length,
    monitored: monitored.length,
    running: monitoredRunning.length,
    missing: missing.length,
  }));

  // For any failed tasks, try to get their last invocation
  const failed = monitored.filter(t => t.orcaStatus === 'failed');
  if (failed.length > 0) {
    console.log('FAILED_DETAILS:');
    for (const t of failed) {
      // Get task detail which may include invocations
      try {
        const detailRes = await fetch(`${BASE}/api/tasks/${t.linearIssueId}`);
        const detail = await detailRes.json();
        if (detail.invocations && detail.invocations.length > 0) {
          const last = detail.invocations[detail.invocations.length - 1];
          console.log(JSON.stringify({
            taskId: t.linearIssueId,
            lastInvId: last.id,
            phase: last.phase,
            status: last.status,
            summary: (last.outputSummary || '').substring(0, 200),
          }));
        }
      } catch {
        console.log(`Could not fetch detail for ${t.linearIssueId}`);
      }
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
