import Database from 'better-sqlite3';

const db = new Database('orca.db');
const ids = ['EMI-214','EMI-222','EMI-223','EMI-224','EMI-230','EMI-231','EMI-232'];

console.log('=== MONITOR ITERATION ===');
console.log('Time:', new Date().toISOString());
console.log('');

let allDone = true;
const results = [];

for (const id of ids) {
  const t = db.prepare('SELECT linear_issue_id, orca_status, retry_count, review_cycle_count, pr_number, stale_session_retry_count FROM tasks WHERE linear_issue_id = ?').get(id);
  if (t) {
    if (t.orca_status !== 'done') allDone = false;
    results.push(t);
    console.log(`${t.linear_issue_id} | ${t.orca_status.padEnd(16)} | retries=${t.retry_count} | reviews=${t.review_cycle_count} | pr=${t.pr_number || '-'} | stale=${t.stale_session_retry_count}`);
  } else {
    allDone = false;
    console.log(`${id} | NOT FOUND`);
  }
}

// Check for failed tasks and get last invocation
const failed = results.filter(t => t.orca_status === 'failed');
if (failed.length > 0) {
  console.log('\n=== FAILED TASKS ===');
  for (const t of failed) {
    const inv = db.prepare('SELECT id, phase, status, num_turns, cost_usd, substr(output_summary,1,200) as summary FROM invocations WHERE linear_issue_id = ? ORDER BY id DESC LIMIT 1').get(t.linear_issue_id);
    if (inv) {
      console.log(`${t.linear_issue_id}: last inv ${inv.id} | phase=${inv.phase} | status=${inv.status} | turns=${inv.num_turns}`);
      console.log(`  summary: ${inv.summary}`);
    }
  }
}

// Check for dispatched/running tasks stuck > 30 min
const active = results.filter(t => t.orca_status === 'dispatched' || t.orca_status === 'running');
if (active.length > 0) {
  console.log('\n=== ACTIVE TASKS ===');
  for (const t of active) {
    const inv = db.prepare("SELECT id, phase, started_at FROM invocations WHERE linear_issue_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(t.linear_issue_id);
    if (inv) {
      const elapsed = (Date.now() - new Date(inv.started_at).getTime()) / 60000;
      console.log(`${t.linear_issue_id}: inv ${inv.id} | phase=${inv.phase} | running ${elapsed.toFixed(0)}min`);
      if (elapsed > 30) console.log(`  WARNING: stuck > 30min`);
    }
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Done: ${results.filter(t => t.orca_status === 'done').length}/7`);
console.log(`Failed: ${failed.length}`);
console.log(`Active: ${active.length}`);
console.log(`All done: ${allDone}`);

db.close();
