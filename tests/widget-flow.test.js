const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function widgetHarness(fetchImpl, options = {}) {
  const source = fs.readFileSync('clarity.js', 'utf8');
  const start = source.indexOf('const handleAsk = async');
  const end = source.indexOf('            chips.forEach', start);
  const messages = [], events = [], calls = [];
  const storage = options.storage || new Map();
  const ctx = {
    isRequestPending: false, openChat() {}, addMessage(text, sender) { messages.push({ text, sender }); },
    input: { value: '', disabled: false, style: {}, focus() {} }, sendBtn: { style: {} },
    loader: { classList: { add() {}, remove() {} } }, chatHistory: {},
    developerAuthorized: true, getRequestSession: async () => ({widget_session:'test-session',expires_at:Math.floor(Date.now()/1000)+300}),
    extractProductContext() { return { title: 'Test product', description: 'Known facts' }; },
    window: { ClarityCartConfig: { use_emojis: true, ...options.config } },
    localStorage: { getItem() { return null; } },
    sessionStorage: { getItem(k) { return storage.get(k) || null; }, setItem(k,v) { storage.set(k,v); }, removeItem(k) { storage.delete(k); } },
    console: { log() {}, warn() {}, error() {} }, crypto: webcrypto,
    resolveStoreDomain() { return 'example.com'; }, API_URL: 'https://mock.test/api/chat',
    SUPABASE_ANON_KEY: 'test', SUPABASE_URL: 'https://db.test',
    fetch: async (...args) => { calls.push(args); return fetchImpl(...args); },
    BroadcastChannel: class { postMessage(e) { events.push(e); } close() {} },
    AbortController, setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end) + ';globalThis.ask = handleAsk;', ctx);
  return { ctx, ask: ctx.ask, messages, events, calls, storage };
}
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('successful reply finishes without a scope error', async () => {
  const h = widgetHarness(async (url, init) => reply({ answer: 'Known facts', usageRecorded: true, requestId: JSON.parse(init.body).request_id }));
  await h.ask('Tell me more');
  assert.equal(h.messages.at(-1).text, 'Known facts');
  assert.equal(h.ctx.input.disabled, false);
  assert.equal(h.ctx.isRequestPending, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.length, 1);
  assert.ok(h.calls.every(([url]) => url.endsWith('/api/chat')));
});

module.exports = { widgetHarness, reply };

for (const flag of ['blocked', 'limitReached']) test(flag + ' disables input and chips without recording', async () => {
  const h = widgetHarness(async () => reply({ answer: 'Unavailable', [flag]: true, usageRecorded: false }));
  await h.ask('Question'); await h.ask('Another question');
  assert.equal(h.ctx.input.disabled, true); assert.equal(h.ctx.sendBtn.disabled, true);
  assert.equal(h.ctx.isRequestPending, false); assert.equal(h.calls.length, 1); assert.equal(h.events.length, 0);
});
test('double submit sends only one request', async () => {
  let release; const wait = new Promise(r => { release = r; });
  const h = widgetHarness(async (url, init) => { await wait; return reply({ answer: 'OK', requestId: JSON.parse(init.body).request_id, usageRecorded: true }); });
  const first = h.ask('Question'); await h.ask('Question'); release(); await first;
  assert.equal(h.calls.length, 1); assert.equal(h.events.length, 1);
});
test('AI failure unlocks UI, does not notify usage, and allows a new request', async () => {
  const h = widgetHarness(async () => reply({ answer: 'AI failed', error: 'AI_UNAVAILABLE', usageRecorded: false }, 502));
  await h.ask('Question'); await h.ask('Question');
  assert.equal(h.ctx.input.disabled, false); assert.equal(h.events.length, 0);
  assert.notEqual(JSON.parse(h.calls[0][1].body).request_id, JSON.parse(h.calls[1][1].body).request_id);
});
test('lost response retries the exact ID and payload, even after refresh', async () => {
  const h = widgetHarness(async () => { throw new Error('Lost response'); });
  await h.ask('Question');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0][1].body, h.calls[1][1].body);
  assert.equal(h.ctx.input.disabled, false); assert.equal(h.events.length, 0);
  const refreshed = widgetHarness(async (url, init) => reply({ answer: 'Recovered', requestId: JSON.parse(init.body).request_id, usageRecorded: true }), { storage: h.storage });
  await refreshed.ask('Question');
  assert.equal(refreshed.calls[0][1].body, h.calls[0][1].body);
  assert.equal(refreshed.storage.size, 0); assert.equal(refreshed.events.length, 1);
});
test('mock stays functional and never calls API or records usage', async () => {
  const h = widgetHarness(async () => { throw new Error('Must not call'); }, { config: { mockMode: true } });
  await h.ask('Question'); assert.equal(h.calls.length, 0); assert.equal(h.events.length, 0);
  assert.match(h.messages.at(-1).text, /Demo Mode/); assert.equal(h.ctx.input.disabled, false);
});
test('answer containing Google or error is not mistaken for a transport error', async () => {
  const h = widgetHarness(async (url, init) => reply({ answer: 'Google device error codes are in the manual.', requestId: JSON.parse(init.body).request_id, usageRecorded: true }));
  await h.ask('Question'); assert.equal(h.calls.length, 1); assert.equal(h.events.length, 1);
});
test('context extraction failure always unlocks UI', async () => {
  const h = widgetHarness(async () => { throw new Error('Must not call'); });
  h.ctx.extractProductContext = () => { throw new Error('Bad page'); };
  await h.ask('Question'); assert.equal(h.ctx.input.disabled, false); assert.equal(h.ctx.isRequestPending, false);
});

test('browser timeout aborts requests, reuses ID and unlocks the UI',async()=>{
  const h=widgetHarness(async(url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('timeout')))));
  h.ctx.setTimeout=(fn,ms)=>setTimeout(fn,ms===40000?5:0);
  await h.ask('Question');assert.equal(h.calls.length,2);assert.equal(h.calls[0][1].body,h.calls[1][1].body);
  assert.equal(h.ctx.input.disabled,false);assert.equal(h.ctx.isRequestPending,false);assert.equal(h.events.length,0);
  assert.equal(h.storage.size,1);
});

test('ordinary visitor cannot enable mock mode through local config',async()=>{
 const h=widgetHarness(async(url,init)=>reply({answer:'Real server path',requestId:JSON.parse(init.body).request_id,usageRecorded:true}),{config:{mockMode:true}});
 h.ctx.developerAuthorized=false;await h.ask('Question');assert.equal(h.calls.length,1);assert.equal(h.messages.at(-1).text,'Real server path');assert.equal(h.calls[0][1].headers.Authorization,'Widget test-session');
});
