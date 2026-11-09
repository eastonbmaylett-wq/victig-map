import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const testPassword = 'local-test-password';
const hash = value => createHash('sha256').update(value).digest('hex');
const context = { ip: '127.0.0.1', geo: { city: 'Test City', subdivision: { name: 'Test State' } },
  deploy: { context: 'deploy-preview', id: 'test-preview' } };
let root, api;

class MemoryStore {
  data = new Map();
  revision = 0;
  async getWithMetadata(key, options = {}) {
    const entry = this.data.get(key);
    if (!entry) return null;
    return { etag: entry.etag, metadata: entry.metadata,
      data: options.type === 'json' ? JSON.parse(entry.bytes.toString())
        : options.type === 'arrayBuffer' ? Buffer.from(entry.bytes) : entry.bytes.toString() };
  }
  async get(key, options) { return (await this.getWithMetadata(key, options))?.data ?? null; }
  async set(key, value, options = {}) {
    const current = this.data.get(key);
    if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = `"${++this.revision}"`;
    this.data.set(key, { bytes: Buffer.from(value), metadata: options.metadata || {}, etag });
    return { modified: true, etag };
  }
  setJSON(key, value, options) { return this.set(key, JSON.stringify(value), options); }
  async delete(key) { this.data.delete(key); }
}

function request(route, options = {}) {
  return new Request(`https://map.example${route}`, options);
}
const auth = { 'X-Victig-Password': testPassword };

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'victig-netlify-tests-'));
  await cp('.netlify-runtime/app', path.join(root, 'app'), { recursive: true });
  await cp('.netlify-runtime/manifest.json', path.join(root, 'manifest.json'));
  const main = path.join(root, 'app/main.py');
  await writeFile(main, (await readFile(main, 'utf8')).replace(/PW_HASH\s*=\s*"[a-f0-9]{64}"/,
    `PW_HASH = "${hash(testPassword)}"`));
  process.env.VICTIG_RUNTIME_DIR = root;
  process.env.VICTIG_PYTHON = 'python3';
  process.env.VICTIG_MAP_INGEST_TOKEN = 'local-test-ingest-token';
  api = await import('../netlify/server/app.mjs');
});
after(async () => { await rm(root, { recursive: true, force: true }); });

test('public assets exclude source, saved state, reports, and databases', async () => {
  const publicFiles = await readdir('dist');
  for (const name of ['main.py', 'county-data.json', 'site-config.json', 'analytics.db', 'requirements.txt', 'simplemaps-base.json', '.git']) {
    assert.ok(!publicFiles.includes(name), name);
  }
});

test('preview deployments cannot use production storage', () => {
  assert.equal(api.storeName(context), 'victig-map-v1-preview-test-preview');
  assert.equal(api.storeName({ deploy: { context: 'production' } }), 'victig-map-v1-production');
  assert.notEqual(api.storeName({}), 'victig-map-v1-production');
});

test('public map retains all eight Connecticut county records and has no private report fields', async () => {
  const store = new MemoryStore();
  const response = await api.handle(request('/county-data.json'), context, store);
  assert.equal(response.status, 200);
  const data = await response.json();
  api.assertPublic(data);
  assert.equal(Object.values(data.counties).filter(c => c.state === 'CT').length, 8);
  assert.ok(Object.values(data.counties).filter(c => c.state === 'CT').every(c => c.periods?.['90d']?.count > 0));
  assert.equal(Object.values(data.counties).filter(c => c._desc_doc).length, 718);
});

test('unauthorized requests cannot edit map, read analytics, or ingest reports', async () => {
  const store = new MemoryStore();
  for (const route of ['/admin/update-county', '/api/analytics/summary', '/automation/refresh']) {
    const response = await api.handle(request(route, { method: route === '/api/analytics/summary' ? 'GET' : 'POST' }), context, store);
    assert.equal(response.status, 401, route);
  }
  assert.equal(store.data.size, 0);
});

test('authenticated county edit survives a new invocation and backs up its exact previous state', async () => {
  const store = new MemoryStore();
  await api.handle(request('/county-data.json'), context, store);
  const before = await store.get('state', { type: 'json' });
  const response = await api.handle(request('/admin/update-county', { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fips: '09001', status: 'delay', description: 'Synthetic migration test', overrides: {} }),
  }), context, store);
  assert.equal(response.status, 200, await response.clone().text());
  const readback = await (await api.handle(request('/county-data.json'), context, store)).json();
  assert.equal(readback.counties['09001'].description, 'Synthetic migration test');
  assert.equal(readback.counties['09001']._admin_override, true);
  const backupKey = [...store.data.keys()].find(k => k.startsWith('backups/'));
  assert.deepEqual(await store.get(backupKey, { type: 'json' }), before);
});

test('concurrent stale writes fail instead of overwriting another edit', async () => {
  const store = new MemoryStore();
  await api.handle(request('/county-data.json'), context, store);
  const first = await store.getWithMetadata('state', { type: 'json' });
  const stale = await store.getWithMetadata('state', { type: 'json' });
  first.data.config.title = 'First edit';
  await api.saveState(store, first, first.data);
  stale.data.config.title = 'Stale edit';
  await assert.rejects(api.saveState(store, stale, stale.data), error => error.status === 409);
  assert.equal((await store.get('state', { type: 'json' })).config.title, 'First edit');
});

test('visit and county analytics persist and retain the existing summary response', async () => {
  const store = new MemoryStore();
  for (const [route, body] of [['/api/log/visit', { event: 'visit' }],
    ['/api/log/click', { fips: '09001', county: 'Fairfield', state: 'CT' }]]) {
    const response = await api.handle(request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), context, store);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const response = await api.handle(request('/api/analytics/summary', { headers: auth }), context, store);
  assert.equal(response.status, 200, await response.clone().text());
  const summary = await response.json();
  assert.equal(summary.total_visits, 1);
  assert.equal(summary.top_counties[0].county, 'Fairfield');
  assert.equal(summary.top_counties[0].clicks, 1);
});

test('failed report processing leaves the durable map unchanged', async () => {
  const store = new MemoryStore();
  await api.handle(request('/county-data.json'), context, store);
  const before = await store.get('state');
  const form = new FormData();
  form.set('tat_file', new File(['not a report'], 'bad.csv', { type: 'text/csv' }));
  const response = await api.handle(request('/automation/refresh', { method: 'POST',
    headers: { Authorization: 'Bearer local-test-ingest-token' }, body: form }), context, store);
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await store.get('state'), before);
});

test('Fly analytics migration preserves new visits and is idempotent', async () => {
  const legacy = new MemoryStore();
  const target = new MemoryStore();
  const visit = store => api.handle(request('/api/log/visit', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{"event":"visit"}' }), context, store);
  await visit(legacy);
  await visit(legacy);
  await visit(target);
  const body = await legacy.get('analytics', { type: 'arrayBuffer' });
  const migrate = () => api.handle(request('/api/migration/analytics', { method: 'POST',
    headers: { Authorization: 'Bearer local-test-ingest-token' }, body }), context, target);
  const first = await migrate();
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).inserted, 2);
  const second = await migrate();
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal((await second.json()).inserted, 0);
  const summary = await (await api.handle(request('/api/analytics/summary', { headers: auth }), context, target)).json();
  assert.equal(summary.total_visits, 3);
});

test('the real report matches direct Python processing through the adapter', {
  skip: !process.env.VICTIG_TEST_REPORT,
}, async () => {
  const store = new MemoryStore();
  const before = await (await api.handle(request('/county-data.json'), context, store)).json();
  const expectedDirectory = await mkdtemp(path.join(tmpdir(), 'victig-python-parity-'));
  await writeFile(path.join(expectedDirectory, 'county-data.json'), JSON.stringify(before));
  // The existing matcher iterates a Python set for ambiguous county/city names.
  // Hold that legacy ordering equal while testing hosting-adapter equivalence.
  const oldSeed = process.env.PYTHONHASHSEED;
  process.env.PYTHONHASHSEED = '0';
  execFileSync('python3', [path.join(root, 'app/process.py'), process.env.VICTIG_TEST_REPORT], {
    env: { ...process.env, DATA_DIR: expectedDirectory }, stdio: 'pipe',
  });
  const expected = JSON.parse(await readFile(path.join(expectedDirectory, 'county-data.json'), 'utf8'));
  const form = new FormData();
  form.set('tat_file', new File([await readFile(process.env.VICTIG_TEST_REPORT)], 'report.csv', { type: 'text/csv' }));
  const result = await api.handle(request('/automation/refresh', { method: 'POST',
    headers: { Authorization: 'Bearer local-test-ingest-token' }, body: form }), context, store);
  assert.equal(result.status, 200, await result.clone().text());
  const after = await (await api.handle(request('/county-data.json'), context, store)).json();
  if (oldSeed === undefined) delete process.env.PYTHONHASHSEED;
  else process.env.PYTHONHASHSEED = oldSeed;
  const differences = Object.keys(expected.counties).filter(key => !isDeepStrictEqual(expected.counties[key], after.counties[key]));
  assert.deepEqual(differences, []);
  assert.deepEqual(after.stateAvg, expected.stateAvg);
  assert.equal(after.maxDate, expected.maxDate);
  assert.equal(after.closureSourceDate, expected.closureSourceDate);
  await rm(expectedDirectory, { recursive: true, force: true });
});

test('large multipart uploads use complete verified chunks and replay a completed result', async () => {
  const store = new MemoryStore();
  const form = new FormData();
  form.set('file', new File(['Jurisdiction,Search TAT,Start Date/Time\n' + 'CT-Fairfield County,1,2026-11-04 10:00:00\n'.repeat(120000)], 'large.csv'));
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  assert.ok(body.length > 4.5 * 1024 * 1024);
  const start = await api.handle(request('/api/uploads', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: '/admin/preview-columns', bytes: body.length, sha256: hash(body), contentType: encoded.headers.get('content-type') }),
  }), context, store);
  assert.equal(start.status, 200, await start.clone().text());
  const upload = await start.json();
  for (let i = 0; i < upload.chunks; i++) {
    const chunk = body.subarray(i * upload.chunkBytes, (i + 1) * upload.chunkBytes);
    const response = await api.handle(request(`/api/uploads/${upload.id}/${i}`, { method: 'PUT', headers: auth, body: chunk }), context, store);
    assert.equal(response.status, 200);
  }
  const complete = () => api.handle(request(`/api/uploads/${upload.id}/complete`, { method: 'POST', headers: auth }), context, store);
  const first = await complete();
  assert.equal(first.status, 200, await first.clone().text());
  const second = await complete();
  assert.equal(second.status, 200);
  assert.equal(await second.text(), await first.text());
  assert.ok(![...store.data.keys()].some(key => key.includes('/part-')));
});

async function startReport(store, bytes, target = '/admin/upload', filename = 'report.csv') {
  const result = await api.handle(request('/api/uploads', { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 2, target, filename, bytes }),
  }), context, store);
  assert.equal(result.status, 200, await result.clone().text());
  return result.json();
}

async function putReportPart(store, upload, index, bytes) {
  const digest = hash(bytes);
  const response = await api.handle(request(`/api/uploads/${upload.id}/${index}`, {
    method: 'PUT', headers: { ...auth, 'X-Victig-Chunk-SHA256': digest }, body: bytes,
  }), context, store);
  assert.equal(response.status, 200, await response.clone().text());
  return digest;
}

const completeReport = (store, upload, digests) => api.handle(request(`/api/uploads/${upload.id}/complete`, {
  method: 'POST', headers: auth, body: JSON.stringify({ sha256: hash(digests.join('')) }),
}), context, store);
const statusReport = (store, upload) => api.handle(request(`/api/uploads/${upload.id}/status`, { headers: auth }), context, store);
const runReport = (store, upload, headers = auth) => api.processUpload(request('/.netlify/functions/process-upload-background', {
  method: 'POST', headers, body: JSON.stringify({ id: upload.id }),
}), context, store);
const csvReport = Buffer.from('Jurisdiction,Search TAT,Start Date/Time,Search Name\nCT-Fairfield County,2,2026-11-09 10:00:00,County Criminal Records Search\n');

test('background upload returns before processing, rechecks auth, and publishes once across duplicate invocations', async () => {
  const store = new MemoryStore();
  await api.handle(request('/county-data.json'), context, store);
  const before = await store.get('state');
  const upload = await startReport(store, csvReport.length);
  const digests = [await putReportPart(store, upload, 0, csvReport)];
  const queued = await completeReport(store, upload, digests);
  assert.equal(queued.status, 202);
  assert.equal(await store.get('state'), before);
  assert.equal((await (await statusReport(store, upload)).json()).phase, 'queued');
  assert.equal((await api.handle(request(`/api/uploads/${upload.id}/status`), context, store)).status, 401);
  await assert.rejects(runReport(store, upload, {}), error => error.status === 401);
  await Promise.all([runReport(store, upload), runReport(store, upload)]);
  const result = await statusReport(store, upload);
  assert.equal(result.status, 200, await result.clone().text());
  const after = await store.get('state', { type: 'json' });
  assert.equal(after.data.reportRowCount, 1);
  assert.equal(after.data.counties['09001'].periods['90d'].avg, 2);
  assert.equal(after.operations.filter(op => op.id === upload.id).length, 1);
  assert.equal([...store.data.keys()].filter(k => k.startsWith('backups/')).length, 1);
  assert.ok(![...store.data.keys()].some(key => key.includes('/part-')));
  await runReport(store, upload);
  assert.equal(await (await completeReport(store, upload, digests)).text(), await result.text());
  assert.ok(![...store.data.values()].some(entry => entry.bytes.includes(testPassword)));
});

test('incomplete and corrupted background uploads leave published state unchanged', async () => {
  for (const fault of ['missing', 'chunk', 'manifest', 'invalid-report']) {
    const store = new MemoryStore();
    await api.handle(request('/county-data.json'), context, store);
    const before = await store.get('state');
    const bytes = fault === 'invalid-report' ? Buffer.from('invalid csv') : csvReport;
    const upload = await startReport(store, bytes.length);
    let digest = hash(bytes);
    if (fault !== 'missing') digest = await putReportPart(store, upload, 0, bytes);
    if (fault === 'chunk') store.data.get(`uploads/${upload.id}/part-0`).bytes[0] ^= 1;
    await completeReport(store, upload, [fault === 'manifest' ? '0'.repeat(64) : digest]);
    await runReport(store, upload);
    const result = await statusReport(store, upload);
    assert.ok(result.status >= 400, fault);
    assert.equal(await store.get('state'), before, fault);
    assert.ok(![...store.data.keys()].some(key => key.startsWith('backups/')), fault);
    assert.ok(![...store.data.keys()].some(key => key.includes('/part-')), fault);
  }
});

test('background upload limits, owner checks, expiry, and per-chunk digest fail closed', async () => {
  const store = new MemoryStore();
  const tooLarge = await api.handle(request('/api/uploads', { method: 'POST', headers: auth,
    body: JSON.stringify({ protocol: 2, target: '/admin/upload', filename: 'report.csv', bytes: api.MAX_REPORT_BYTES + 1 }),
  }), context, store);
  assert.equal(tooLarge.status, 413);
  const upload = await startReport(store, csvReport.length);
  const invalid = await api.handle(request(`/api/uploads/${upload.id}/0`, {
    method: 'PUT', headers: { ...auth, 'X-Victig-Chunk-SHA256': '0'.repeat(64) }, body: csvReport,
  }), context, store);
  assert.equal(invalid.status, 400);
  const key = `uploads/${upload.id}/metadata`;
  const spec = await store.get(key, { type: 'json' });
  await store.setJSON(key, { ...spec, owner: 'another-session' });
  assert.equal((await statusReport(store, upload)).status, 403);
  await assert.rejects(runReport(store, upload), error => error.status === 403);
  await store.setJSON(key, { ...spec, expires: Date.now() - 1 });
  assert.equal((await statusReport(store, upload)).status, 410);
});

test('400 MiB CSV completes through disk-backed staging and the actual Python processor', {
  skip: process.env.VICTIG_STRESS_TEST !== '1', timeout: 180000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'victig-stress-'));
  class DiskStore extends MemoryStore {
    async set(key, value, options = {}) {
      if (!key.includes('/part-')) return super.set(key, value, options);
      const result = await super.set(key, '', options);
      if (result.modified) await writeFile(path.join(directory, key.replaceAll('/', '_')), value);
      return result;
    }
    async getWithMetadata(key, options) {
      const entry = await super.getWithMetadata(key, options);
      if (entry && key.includes('/part-')) entry.data = await readFile(path.join(directory, key.replaceAll('/', '_')));
      return entry;
    }
    async delete(key) {
      await super.delete(key);
      if (key.includes('/part-')) await rm(path.join(directory, key.replaceAll('/', '_')), { force: true });
    }
  }
  try {
    const store = new DiskStore();
    const header = Buffer.from('Jurisdiction,Search TAT,Start Date/Time,Search Name,Unused\n');
    const row = Buffer.from('CT-Fairfield County,2,2026-11-09 10:00:00,County Criminal Records Search,' + 'x'.repeat(930) + '\n');
    const rows = Math.floor((api.MAX_REPORT_BYTES - header.length) / row.length);
    const bytes = header.length + rows * row.length;
    const upload = await startReport(store, bytes);
    const digests = [];
    for (let index = 0; index < upload.chunks; index++) {
      const offset = index * upload.chunkBytes;
      const chunk = Buffer.alloc(Math.min(upload.chunkBytes, bytes - offset));
      for (let start = 0; start < chunk.length;) {
        const position = offset + start;
        const source = position < header.length ? header : row;
        const sourceOffset = position < header.length ? position : (position - header.length) % row.length;
        start += source.copy(chunk, start, sourceOffset, sourceOffset + chunk.length - start);
      }
      digests.push(await putReportPart(store, upload, index, chunk));
    }
    assert.equal((await completeReport(store, upload, digests)).status, 202);
    await runReport(store, upload);
    const result = await statusReport(store, upload);
    assert.equal(result.status, 200, await result.clone().text());
    const state = await store.get('state', { type: 'json' });
    assert.equal(state.data.reportRowCount, rows);
    assert.equal(state.data.stateAvg.CT.count, rows);
    assert.equal(state.data.counties['09001'].periods['180d'].avg, 2);
    assert.ok(bytes > 399 * 1024 * 1024);
    console.log(JSON.stringify({ stressBytes: bytes, verifiedRows: rows, state: 'passed' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a background processor can finish after the old 48-second cutoff', {
  skip: process.env.VICTIG_SLOW_BACKGROUND_TEST !== '1', timeout: 70000,
}, async () => {
  const bridge = path.join(root, 'app/bridge.py');
  const original = await readFile(bridge);
  try {
    await writeFile(bridge, `import base64, json, sys, time\nfrom pathlib import Path\ntime.sleep(49)\nPath(sys.argv[2]).write_text(json.dumps({'status':200,'headers':[['content-type','application/json']],'body':base64.b64encode(b'{"rows":[["Slow fixture completed"]]}').decode()}))\n`);
    const store = new MemoryStore();
    const upload = await startReport(store, csvReport.length, '/admin/preview-columns');
    await completeReport(store, upload, [await putReportPart(store, upload, 0, csvReport)]);
    const started = Date.now();
    await runReport(store, upload);
    const response = await statusReport(store, upload);
    assert.ok(Date.now() - started > 48000);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).rows, [['Slow fixture completed']]);
  } finally { await writeFile(bridge, original); }
});
