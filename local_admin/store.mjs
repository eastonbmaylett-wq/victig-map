// This module runs only on the Mac. Credentials never enter browser responses.
import { getStore } from '@netlify/blobs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertPublic, saveState, HttpError } from '../netlify/server/app.mjs';

const siteID = process.env.VICTIG_LOCAL_SITE_ID || 'aa3c8c95-afc1-4d66-a96d-98827dac978d';
const storeName = process.env.VICTIG_LOCAL_STORE || 'victig-map-v1-production';
const publicURL = process.env.VICTIG_LOCAL_PUBLIC_URL || 'https://precious-dolphin-3f8f85.netlify.app';

async function connect() {
  let token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    const filename = process.env.VICTIG_NETLIFY_CONFIG || path.join(homedir(), 'Library/Preferences/netlify/config.json');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    token = config.users?.[config.userId]?.auth?.token;
  }
  if (!token) throw new HttpError(503, 'Sign in to Netlify CLI on this Mac before publishing.');
  return getStore({ name: storeName, siteID, token, consistency: 'strong' });
}

export async function publish(store, before, candidate, readback) {
  assertPublic(candidate.data);
  const current = await store.getWithMetadata('state', { type: 'json' });
  if (!current || current.etag !== before.etag)
    throw new HttpError(409, 'The live map changed during processing. Reload the admin page and retry.');
  const unchanged = isDeepStrictEqual(before.data.data, candidate.data)
    && isDeepStrictEqual(before.data.config, candidate.config);
  let etag = before.etag;
  if (!unchanged) {
    etag = await saveState(store, before, { ...before.data, data: candidate.data, config: candidate.config });
  }
  // A successful write is not reported as success until public visitors see it.
  const live = await readback();
  if (!isDeepStrictEqual(live.data, candidate.data) || !isDeepStrictEqual(live.config, candidate.config))
    throw new HttpError(502, 'Publication could not be verified. Reload the live map before retrying; it may already be saved.');
  return { ok: true, verified: true, unchanged, etag, maxDate: candidate.data.maxDate,
    countyCount: Object.keys(candidate.data.counties).length };
}

async function publicReadback() {
  const results = await Promise.all(['county-data.json', 'site-config.json'].map(async name => {
    const response = await fetch(`${publicURL}/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new HttpError(502, 'Publication may have completed, but public readback failed. Reload before retrying.');
    return response.json();
  }));
  return { data: results[0], config: results[1] };
}

async function main() {
  const [command, beforePath, candidatePath] = process.argv.slice(2);
  const store = await connect();
  if (command === 'snapshot') {
    const snapshot = await store.getWithMetadata('state', { type: 'json' });
    if (!snapshot) throw new HttpError(503, 'The existing live map state is unavailable.');
    await writeFile(beforePath, JSON.stringify(snapshot), { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, etag: snapshot.etag, maxDate: snapshot.data.data.maxDate }));
  } else if (command === 'publish') {
    const before = JSON.parse(await readFile(beforePath, 'utf8'));
    const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
    console.log(JSON.stringify(await publish(store, before, candidate, publicReadback)));
  } else throw new HttpError(400, 'Unknown local publishing command.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ status: error.status || 502,
      detail: error instanceof HttpError ? error.message : 'Publishing service unavailable. Check Netlify CLI sign-in and the network connection.' }));
    process.exitCode = 1;
  });
}
