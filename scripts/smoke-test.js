#!/usr/bin/env node
/**
 * ClarityCart Automated API & Security Smoke Test Suite
 * Usage:
 *   node scripts/smoke-test.js
 *   SMOKE_BASE_URL=https://claritycart-landing.vercel.app node scripts/smoke-test.js
 */

const baseUrl = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

const checks = [
  {
    name: 'GET /api/health returns 200 OK',
    path: '/api/health',
    method: 'GET',
    expectedStatuses: [200],
    validateBody: (json) => json && json.status === 'ok'
  },
  {
    name: 'GET /api/config rejects missing domain with 400',
    path: '/api/config',
    method: 'GET',
    expectedStatuses: [400]
  },
  {
    name: 'GET /api/account rejects unauthenticated request with 401',
    path: '/api/account',
    method: 'GET',
    expectedStatuses: [401]
  },
  {
    name: 'GET /api/knowledge rejects unauthenticated request with 401',
    path: '/api/knowledge',
    method: 'GET',
    expectedStatuses: [401]
  },
  {
    name: 'GET /api/events rejects unauthenticated request with 401',
    path: '/api/events',
    method: 'GET',
    expectedStatuses: [401]
  },
  {
    name: 'POST /api/events rejects missing widget session with 401/403',
    path: '/api/events',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'product_view' }),
    expectedStatuses: [400, 401, 403]
  },
  {
    name: 'GET /api/billing/status rejects unauthenticated request with 401',
    path: '/api/billing/status',
    method: 'GET',
    expectedStatuses: [401]
  },
  {
    name: 'POST /api/chat rejects missing widget session / store binding',
    path: '/api/chat',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'test' }),
    expectedStatuses: [400, 401, 403]
  },
  {
    name: 'POST /api/widget-session rejects unprovisioned store',
    path: '/api/widget-session',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    expectedStatuses: [400, 401, 403, 404]
  },
  {
    name: 'GET /api/admin/overview rejects unauthenticated access with 401/403',
    path: '/api/admin/overview',
    method: 'GET',
    expectedStatuses: [401, 403]
  },
  {
    name: 'GET /api/detect-color returns valid JSON fallback when no domain given',
    path: '/api/detect-color',
    method: 'GET',
    expectedStatuses: [200, 400],
    validateBody: (json) => json && (typeof json.color === 'string' || typeof json.error === 'string')
  }
];

async function runSmokeTests() {
  console.log(`\n🚀 Running ClarityCart Smoke Tests against: ${baseUrl}\n`);
  let passed = 0;
  let failed = 0;

  for (const check of checks) {
    const url = `${baseUrl}${check.path}`;
    try {
      const res = await fetch(url, {
        method: check.method,
        headers: check.headers || {},
        body: check.body,
        signal: AbortSignal.timeout(6000)
      });

      let bodyJson = null;
      const text = await res.text();
      try {
        bodyJson = JSON.parse(text);
      } catch {
        // Non-JSON response
      }

      const statusOk = check.expectedStatuses.includes(res.status);
      const bodyOk = check.validateBody ? check.validateBody(bodyJson) : true;

      if (statusOk && bodyOk) {
        console.log(`  ✅ PASS: ${check.name} (HTTP ${res.status})`);
        passed++;
      } else {
        console.error(`  ❌ FAIL: ${check.name} -> Expected [${check.expectedStatuses.join(',')}], got HTTP ${res.status} (${text.slice(0, 120)})`);
        failed++;
      }
    } catch (err) {
      console.error(`  ❌ ERROR: ${check.name} -> ${err.message}`);
      failed++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Summary: ${passed}/${checks.length} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
}

runSmokeTests();
