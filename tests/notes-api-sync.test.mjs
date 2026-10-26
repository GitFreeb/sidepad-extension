import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_BACKOFF_MS, POLL_INTERVAL_MS, VisiblePoller, backoffDelay } from '../notes-api-sync.js';

function fakeClock() {
  const timers = [];
  return {
    timers,
    schedule(fn, delay) { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
    cancel(timer) { if (timer) timer.cancelled = true; },
    pending() { return timers.filter((timer) => !timer.cancelled && !timer.fired); },
    async fire() {
      const [timer] = this.pending();
      timer.fired = true;
      await timer.fn();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('backoff doubles from the base interval and stays bounded', () => {
  assert.equal(backoffDelay(0), POLL_INTERVAL_MS);
  assert.equal(backoffDelay(1), 4000);
  assert.equal(backoffDelay(2), 8000);
  assert.equal(backoffDelay(50), MAX_BACKOFF_MS);
  assert.ok(MAX_BACKOFF_MS <= 60000);
});

test('polls immediately on start and then every interval while visible', async () => {
  const clock = fakeClock();
  let ticks = 0;
  const poller = new VisiblePoller({ tick: async () => { ticks += 1; return 'ok'; }, isVisible: () => true, ...clock });
  poller.start();
  await flush();
  assert.equal(ticks, 1);
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [POLL_INTERVAL_MS]);
  await clock.fire();
  assert.equal(ticks, 2);
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [POLL_INTERVAL_MS]);
});

test('hidden panel makes no requests, only cheap visibility rechecks, and resumes even without an event', async () => {
  const clock = fakeClock();
  let visible = false;
  let ticks = 0;
  const poller = new VisiblePoller({ tick: async () => { ticks += 1; return 'ok'; }, isVisible: () => visible, ...clock });
  poller.start();
  await flush();
  assert.equal(ticks, 0);
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [POLL_INTERVAL_MS]);
  await clock.fire();
  assert.equal(ticks, 0);
  visible = true;
  await clock.fire();
  await flush();
  assert.equal(ticks, 1);
  assert.equal(clock.pending().length, 1);
});

test('visibility event wakes an immediate read', async () => {
  const clock = fakeClock();
  let visible = false;
  let ticks = 0;
  const poller = new VisiblePoller({ tick: async () => { ticks += 1; return 'ok'; }, isVisible: () => visible, ...clock });
  poller.start();
  visible = true;
  poller.wake();
  await flush();
  assert.equal(ticks, 1);
  assert.equal(clock.pending().length, 1);
});

test('offline, 429 and 503 results back off without a noisy loop and recover on success', async () => {
  const clock = fakeClock();
  const results = ['backoff', 'backoff', 'backoff', 'ok'];
  const poller = new VisiblePoller({ tick: async () => results.shift(), isVisible: () => true, ...clock });
  poller.start();
  await flush();
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [4000]);
  await clock.fire();
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [8000]);
  await clock.fire();
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [16000]);
  await clock.fire();
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [POLL_INTERVAL_MS]);
});

test('focus wakes an immediate read but keeps the backoff level and never overlaps requests', async () => {
  const clock = fakeClock();
  let release;
  let inFlight = 0;
  let maxInFlight = 0;
  let ticks = 0;
  const poller = new VisiblePoller({
    tick: () => {
      ticks += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => { release = () => { inFlight -= 1; resolve('backoff'); }; });
    },
    isVisible: () => true,
    ...clock,
  });
  poller.start();
  poller.wake();
  poller.wake();
  await flush();
  assert.equal(ticks, 1);
  release();
  await flush();
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [4000]);
  poller.wake();
  await flush();
  assert.equal(ticks, 2);
  release();
  await flush();
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [8000]);
  assert.equal(maxInFlight, 1);
});

test('stop cancels the timer and ignores late completions', async () => {
  const clock = fakeClock();
  let release;
  const poller = new VisiblePoller({
    tick: () => new Promise((resolve) => { release = () => resolve('ok'); }),
    isVisible: () => true,
    ...clock,
  });
  poller.start();
  await flush();
  poller.stop();
  release();
  await flush();
  assert.equal(clock.pending().length, 0);
});

test('a throwing tick counts as a failure instead of breaking the loop', async () => {
  const clock = fakeClock();
  const poller = new VisiblePoller({ tick: async () => { throw new Error('boom'); }, isVisible: () => true, ...clock });
  poller.start();
  await flush();
  assert.deepEqual(clock.pending().map((timer) => timer.delay), [4000]);
});

test('default timers are called unbound so browsers do not throw Illegal invocation', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = function strictSetTimeout(fn, delay) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    scheduled.push(delay);
    return 1;
  };
  try {
    const poller = new VisiblePoller({ tick: async () => 'ok', isVisible: () => true });
    poller.start();
    await flush();
    assert.deepEqual(scheduled, [POLL_INTERVAL_MS]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
