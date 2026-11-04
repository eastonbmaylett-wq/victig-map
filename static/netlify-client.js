/* Keep existing admin workflows while sending large files in bounded chunks. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) return nativeFetch(input, options);
    const url = new URL(input, location.href);
    if (url.origin !== location.origin) return nativeFetch(input, options);
    const headers = new Headers(options.headers);
    if (url.searchParams.has('password')) {
      headers.set('X-Victig-Password', url.searchParams.get('password'));
      url.searchParams.delete('password');
    }
    if (url.pathname === '/api/analytics/backfill-geo' && options.method === 'POST') {
      let enriched = 0, total = 0;
      while (true) {
        const response = await nativeFetch(url, { ...options, headers });
        if (!response.ok) return response;
        const result = await response.json();
        enriched += result.enriched || 0;
        total += result.total || 0;
        if (!result.has_more) return Response.json({ enriched, total });
        url.searchParams.set('after_id', result.next_after_id);
      }
    }
    if (!(options.body instanceof FormData)) return nativeFetch(url, { ...options, headers });
    const encoded = new Response(options.body);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    if (bytes.length <= 3 * 1024 * 1024) return nativeFetch(url, { ...options, headers });
    const contentType = encoded.headers.get('content-type');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const metadataHeaders = new Headers(headers);
    metadataHeaders.set('Content-Type', 'application/json');
    const started = await nativeFetch('/api/uploads', {
      method: 'POST', headers: metadataHeaders,
      body: JSON.stringify({ target: url.pathname + url.search, contentType,
        bytes: bytes.length, sha256: digest }),
    });
    if (!started.ok) return started;
    const upload = await started.json();
    for (let index = 0; index < upload.chunks; index++) {
      const part = await nativeFetch(`/api/uploads/${upload.id}/${index}`, {
        method: 'PUT', headers,
        body: bytes.slice(index * upload.chunkBytes, (index + 1) * upload.chunkBytes),
      });
      if (!part.ok) return part;
    }
    return nativeFetch(`/api/uploads/${upload.id}/complete`, { method: 'POST', headers });
  };
  addEventListener('DOMContentLoaded', () => {
    if (['/', '/index.html', '/embed', '/embed.html'].includes(location.pathname)) {
      nativeFetch('/api/log/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: location.pathname.startsWith('/embed') ? 'embed' : 'visit' }),
      }).catch(() => {});
    }
  });
})();
