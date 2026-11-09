import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

const source = await readFile('static/netlify-client.js', 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');

test('browser uploads bounded file slices, retries a transient chunk failure, and polls for the final result', async () => {
  const chunks = [], events = [], hashes = [];
  let polls = 0, retried = false, complete = false, triggered = false;
  const nativeFetch = async (input, options = {}) => {
    const url = new URL(input, 'https://map.example');
    const headers = new Headers(options.headers);
    assert.equal(url.searchParams.has('password'), false);
    assert.equal(headers.get('X-Victig-Password'), 'test-password');
    if (url.pathname === '/api/uploads') {
      const spec = JSON.parse(options.body);
      assert.equal(spec.protocol, 2);
      assert.equal(spec.bytes, 5 * 1024 * 1024);
      return Response.json({ id: 'test-upload', chunks: 3, chunkBytes: 2 * 1024 * 1024 });
    }
    if (/\/\d+$/.test(url.pathname)) {
      if (!retried) { retried = true; return new Response('', { status: 503 }); }
      assert.ok(options.body.byteLength <= 2 * 1024 * 1024);
      const hash = sha(new Uint8Array(options.body));
      assert.equal(hash, headers.get('X-Victig-Chunk-SHA256'));
      hashes.push(hash);
      chunks.push(options.body.byteLength);
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/complete')) {
      assert.equal(JSON.parse(options.body).sha256, sha(hashes.join('')));
      complete = true;
      return Response.json({ phase: 'queued' }, { status: 202 });
    }
    if (url.pathname.endsWith('/process-upload-background')) {
      assert.ok(complete);
      assert.deepEqual(JSON.parse(options.body), { id: 'test-upload' });
      triggered = true;
      return new Response('', { status: 202 });
    }
    assert.ok(triggered);
    assert.ok(url.pathname.endsWith('/status'));
    return ++polls === 1 ? Response.json({ phase: 'processing' }, { status: 202 })
      : Response.json({ ok: true, message: 'Saved exactly once' });
  };
  const window = { fetch: nativeFetch };
  runInNewContext(source, { window, URL, Headers, FormData, Blob, Response, TextEncoder, crypto: webcrypto,
    location: { href: 'https://map.example/admin', origin: 'https://map.example', pathname: '/admin' },
    addEventListener() {}, dispatchEvent(event) { events.push(event.detail); },
    CustomEvent: class { constructor(name, options) { this.detail = options.detail; } },
    setTimeout(callback) { queueMicrotask(callback); },
  });
  const file = new File([new Uint8Array(5 * 1024 * 1024)], 'report.csv');
  file.arrayBuffer = () => { throw new Error('Whole-file reads are forbidden'); };
  const form = new FormData();
  form.set('file', file);
  const result = await window.fetch('/admin/upload?password=test-password', { method: 'POST', body: form });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).message, 'Saved exactly once');
  assert.deepEqual(chunks, [2 * 1024 * 1024, 2 * 1024 * 1024, 1024 * 1024]);
  assert.equal(polls, 2);
  assert.equal(events.at(-1).phase, 'processing');
  assert.equal(events.at(-2).percent, 100);
});
