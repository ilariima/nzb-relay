import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EgressChecker } from '../src/egress-checker.mjs';

test('manual checks can force a fresh lookup and every grab is checked fresh', async () => {
  let checks = 0;
  const checker = new EgressChecker({
    fetchImpl: async () => {
      checks += 1;
      return new Response(JSON.stringify({ ip: `203.0.113.${checks}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const base = { egressCheckUrl: 'https://ip.invalid', requestTimeoutMs: 1_000 };

  assert.equal((await checker.get(base)).ip, '203.0.113.1');
  assert.equal((await checker.get(base)).ip, '203.0.113.1');
  assert.equal((await checker.get(base, { force: true })).ip, '203.0.113.2');
  assert.equal((await checker.enforce(base)).ip, '203.0.113.3');
  assert.equal(checks, 3);
});
