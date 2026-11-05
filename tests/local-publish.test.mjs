import test from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../local_admin/store.mjs';

function fixture() {
  const before = { etag: 'v1', data: { data: { counties: { '49001': { name: 'Beaver' } } }, config: { title: 'Map' }, operations: [{ id: 'prior' }] } };
  let current = structuredClone(before);
  const backups = [];
  const store = {
    getWithMetadata: async () => structuredClone(current),
    setJSON: async (key, value, options) => {
      if (key.startsWith('backups/')) { backups.push(structuredClone(value)); return { modified: true }; }
      if (options.onlyIfMatch !== current.etag) return { modified: false };
      current = { etag: 'v2', data: structuredClone(value) };
      return { modified: true, etag: 'v2' };
    },
  };
  return { before, store, backups, readback: async () => current.data };
}

test('published data preserves prior operation records and backs up the exact old state', async () => {
  const f = fixture();
  const candidate = structuredClone(f.before.data);
  candidate.data.counties['49001'].description = 'Updated notice';
  const result = await publish(f.store, f.before, candidate, f.readback);
  assert.equal(result.verified, true);
  assert.equal(result.unchanged, false);
  assert.deepEqual(f.backups[0], f.before.data);
  assert.deepEqual((await f.readback()).operations, [{ id: 'prior' }]);
});

test('unchanged uploads verify the live map without writing', async () => {
  const f = fixture();
  const result = await publish(f.store, f.before, f.before.data, f.readback);
  assert.equal(result.unchanged, true);
  assert.equal(f.backups.length, 0);
});

test('a stale snapshot cannot overwrite a newer edit, even for an apparent no-op', async () => {
  const f = fixture();
  const stale = { ...f.before, etag: 'old' };
  await assert.rejects(publish(f.store, stale, f.before.data, f.readback), e => e.status === 409);
  assert.equal(f.backups.length, 0);
});

test('private fields are rejected before writing', async () => {
  const f = fixture();
  const candidate = structuredClone(f.before.data);
  candidate.data.counties['49001'].latest = { candidate: 'private fixture' };
  await assert.rejects(publish(f.store, f.before, candidate, f.readback), /Private report fields/);
  assert.equal(f.backups.length, 0);
});

test('failed public readback is never reported as a verified publication', async () => {
  const f = fixture();
  await assert.rejects(publish(f.store, f.before, f.before.data, async () => ({ data: {}, config: {} })), e => e.status === 502);
});
