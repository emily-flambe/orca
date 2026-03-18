// Standalone test for monitor-snapshot-logic.mjs
// Run with: node test/monitor-snapshot-logic.test.mjs
import assert from 'node:assert/strict';
import { formatDuration, defaultState, processCheckResult } from '../scripts/monitor-snapshot-logic.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ─── formatDuration ───────────────────────────────────────────────────────────

console.log('\nformatDuration');

test('seconds only', () => {
  assert.equal(formatDuration(45), '45s');
});

test('minutes and seconds', () => {
  assert.equal(formatDuration(969), '16m 9s');
});

test('exact minute', () => {
  assert.equal(formatDuration(60), '1m 0s');
});

test('hours, minutes, seconds', () => {
  assert.equal(formatDuration(3930), '1h 5m 30s');
});

test('exact hour', () => {
  assert.equal(formatDuration(3600), '1h 0m 0s');
});

test('zero', () => {
  assert.equal(formatDuration(0), '0s');
});

// ─── processCheckResult ───────────────────────────────────────────────────────

console.log('\nprocessCheckResult');

const T0 = '2026-03-10T04:16:12Z';
const T1 = '2026-03-10T04:31:12Z'; // 15m after T0
const T2 = '2026-03-10T04:32:21Z'; // 16m 9s after T0

// 1. First DOWN snapshot: consecutiveDownCount=1, no alert
test('first DOWN: count=1, no alert', () => {
  const prev = defaultState(); // lastStatus: 'UP', consecutiveDownCount: 0
  const result = processCheckResult(prev, { up: false, port: null, error: 'ECONNREFUSED' }, T0);
  assert.equal(result.snapshot.status, 'DOWN');
  assert.equal(result.snapshot.consecutiveDownCount, 1);
  assert.equal(result.snapshot.error, 'ECONNREFUSED');
  assert.equal(result.newState.consecutiveDownCount, 1);
  assert.equal(result.newState.lastStatus, 'DOWN');
  assert.equal(result.newState.downtimeStartedAt, T0);
  assert.equal(result.alert, null);
});

// 2. Second DOWN snapshot: consecutiveDownCount=2, alert fires
test('second DOWN: count=2, alert fires', () => {
  const prev = {
    lastKnownPort: 4000,
    consecutiveDownCount: 1,
    downtimeStartedAt: T0,
    lastStatus: 'DOWN',
  };
  const result = processCheckResult(prev, { up: false, port: null, error: 'ECONNREFUSED' }, T1);
  assert.equal(result.snapshot.consecutiveDownCount, 2);
  assert.notEqual(result.alert, null);
  assert.equal(result.alert.type, 'downtime_alert');
  assert.equal(result.alert.consecutiveDownCount, 2);
  assert.equal(result.alert.downtimeStartedAt, T0);
});

// 3. Third DOWN snapshot: alert fires again
test('third DOWN: count=3, alert fires again', () => {
  const prev = {
    lastKnownPort: 4001,
    consecutiveDownCount: 2,
    downtimeStartedAt: T0,
    lastStatus: 'DOWN',
  };
  const result = processCheckResult(prev, { up: false, port: null, error: 'ETIMEDOUT' }, T1);
  assert.equal(result.snapshot.consecutiveDownCount, 3);
  assert.notEqual(result.alert, null);
  assert.equal(result.alert.type, 'downtime_alert');
  assert.equal(result.alert.consecutiveDownCount, 3);
});

// 4. UP after DOWN: recovery alert, downtimeDuration computed correctly
test('UP after DOWN: recovery alert with correct duration', () => {
  const prev = {
    lastKnownPort: 4001,
    consecutiveDownCount: 2,
    downtimeStartedAt: T0,
    lastStatus: 'DOWN',
  };
  // T2 is 16m 9s after T0
  const result = processCheckResult(prev, { up: true, port: 4001, error: null }, T2);
  assert.equal(result.snapshot.status, 'UP');
  assert.equal(result.snapshot.recoveredFromDowntime, true);
  assert.equal(result.snapshot.downtimeDuration, '16m 9s');
  assert.equal(result.snapshot.downtimeStartedAt, T0);
  assert.equal(result.newState.consecutiveDownCount, 0);
  assert.equal(result.newState.lastStatus, 'UP');
  assert.notEqual(result.alert, null);
  assert.equal(result.alert.type, 'recovery');
  assert.equal(result.alert.downtimeDuration, '16m 9s');
});

// 5. UP after UP: no alert, normal UP snapshot
test('UP after UP: no alert, normal snapshot', () => {
  const prev = defaultState(); // lastStatus: 'UP'
  const result = processCheckResult(prev, { up: true, port: 4000, error: null }, T0);
  assert.equal(result.snapshot.status, 'UP');
  assert.equal(result.snapshot.recoveredFromDowntime, undefined);
  assert.equal(result.alert, null);
  assert.equal(result.newState.consecutiveDownCount, 0);
  assert.equal(result.newState.lastStatus, 'UP');
});

// 6. DOWN preserves downtimeStartedAt from previous state
test('DOWN preserves original downtimeStartedAt', () => {
  const prev = {
    lastKnownPort: 4000,
    consecutiveDownCount: 3,
    downtimeStartedAt: T0,
    lastStatus: 'DOWN',
  };
  const result = processCheckResult(prev, { up: false, port: null, error: 'ECONNREFUSED' }, T1);
  assert.equal(result.newState.downtimeStartedAt, T0);
});

// 7. HTTP non-200 treated as DOWN
test('HTTP_503 treated as DOWN', () => {
  const prev = defaultState();
  const result = processCheckResult(prev, { up: false, port: null, error: 'HTTP_503' }, T0);
  assert.equal(result.snapshot.status, 'DOWN');
  assert.equal(result.snapshot.error, 'HTTP_503');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
