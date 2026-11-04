import { getStore } from '@netlify/blobs';

export default async () => {
  const store = getStore({ name: 'victig-map-v1-production', consistency: 'strong' });
  const backups = [];
  let expired = 0;
  for await (const page of store.list({ prefix: 'uploads/', paginate: true })) {
    for (const { key } of page.blobs) {
      if (!key.endsWith('/metadata')) continue;
      const record = await store.get(key, { type: 'json' });
      if (!record || record.expires >= Date.now()) continue;
      await Promise.all(Array.from({ length: record.chunks }, (_, index) =>
        store.delete(`uploads/${record.id}/part-${index}`)));
      await store.delete(key);
      if (++expired >= 20) break;
    }
    if (expired >= 20) break;
  }
  for await (const page of store.list({ prefix: 'backups/', paginate: true })) {
    for (const { key } of page.blobs) {
      const entry = await store.getMetadata(key);
      backups.push({ key, savedAt: entry?.metadata?.savedAt || '' });
    }
  }
  backups.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  await Promise.all(backups.slice(14).map(({ key }) => store.delete(key)));
  return Response.json({ expiredUploads: expired, backupsRetained: Math.min(14, backups.length) });
};

export const config = { schedule: '0 9 * * *' };
