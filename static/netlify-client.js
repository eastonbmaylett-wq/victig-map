/* Keep existing admin workflows while sending large files in bounded chunks. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  const reportPaths = new Set(['/admin/upload', '/admin/preview-columns']);
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const progress = (target, phase, percent) => dispatchEvent(new CustomEvent('victig-upload-progress', {
    detail: { target, phase, percent },
  }));
  async function retryFetch(url, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await nativeFetch(url, options);
        if (attempt >= 3 || ![408, 429, 502, 503, 504].includes(response.status)) return response;
      } catch (error) {
        if (attempt >= 3 || options.signal?.aborted) throw error;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  async function uploadReport(url, options, headers) {
    let uploadId, phase = 'starting';
    const failure = async response => {
      let body;
      try { body = await response.json(); } catch { body = {}; }
      const message = typeof body.detail === 'string' ? body.detail : `Upload failed during ${phase} (HTTP ${response.status}).`;
      const requestId = response.headers.get('x-nf-request-id');
      const reference = uploadId ? `Upload ID: ${uploadId}` : requestId ? `Request ID: ${requestId}` : '';
      return Response.json({ ...body, uploadId, stage: phase,
        detail: reference && !message.includes(reference) ? `${message} ${reference}` : message,
      }, { status: response.status });
    };
    try {
      const file = options.body.get('file');
      if (!(file instanceof Blob)) return Response.json({ detail: 'Choose a report file first.' }, { status: 400 });
      if (file.size > 400 * 1024 * 1024) return Response.json({
        detail: 'This Netlify site supports reports up to 400 MiB. Larger reports need local processing.',
      }, { status: 413 });
      const jsonHeaders = new Headers(headers);
      jsonHeaders.set('Content-Type', 'application/json');
      const started = await nativeFetch('/api/uploads', { method: 'POST', headers: jsonHeaders, signal: options.signal,
        body: JSON.stringify({ protocol: 2, target: url.pathname, filename: file.name || 'report.csv', bytes: file.size }),
      });
      if (!started.ok) return failure(started);
      const upload = await started.json();
      uploadId = upload.id;
      phase = 'uploading';
      const digests = [];
      for (let index = 0; index < upload.chunks; index++) {
        const bytes = await file.slice(index * upload.chunkBytes, (index + 1) * upload.chunkBytes).arrayBuffer();
        const hash = await digest(bytes);
        const partHeaders = new Headers(headers);
        partHeaders.set('X-Victig-Chunk-SHA256', hash);
        const part = await retryFetch(`/api/uploads/${upload.id}/${index}`, {
          method: 'PUT', headers: partHeaders, body: bytes, signal: options.signal,
        });
        if (!part.ok) return failure(part);
        digests.push(hash);
        progress(url.pathname, 'uploading', Math.round((index + 1) / upload.chunks * 100));
      }
      phase = 'queueing';
      const complete = await retryFetch(`/api/uploads/${upload.id}/complete`, {
        method: 'POST', headers: jsonHeaders, signal: options.signal,
        body: JSON.stringify({ sha256: await digest(new TextEncoder().encode(digests.join(''))) }),
      });
      if (complete.status !== 202) return complete.ok ? complete : failure(complete);
      phase = 'starting processor';
      const triggered = await retryFetch('/.netlify/functions/process-upload-background', {
        method: 'POST', headers: jsonHeaders, signal: options.signal, body: JSON.stringify({ id: upload.id }),
      });
      if (!triggered.ok) return failure(triggered);
      const startedAt = Date.now();
      phase = 'processing';
      progress(url.pathname, 'processing', 100);
      while (Date.now() - startedAt < 16 * 60 * 1000) {
        await sleep(2000);
        const response = await retryFetch(`/api/uploads/${upload.id}/status`, { headers, signal: options.signal });
        if (response.status !== 202) return response.ok ? response : failure(response);
        const status = await response.json();
        if (status.phase === 'queued' && Date.now() - startedAt > 2 * 60 * 1000) {
          return failure(Response.json({ detail: 'Background processing did not start. Please retry the upload.' }, { status: 503 }));
        }
      }
      return failure(Response.json({ detail: 'The server has not returned a result. Reload the map to check its current data before retrying.' }, { status: 504 }));
    } catch (error) {
      const errorCode = error.name === 'SyntaxError' ? 'INVALID_SERVER_RESPONSE'
        : error.name === 'AbortError' ? 'UPLOAD_CANCELLED' : 'CONNECTION_FAILED';
      return failure(Response.json({ errorCode,
        detail: `${errorCode} during ${phase}. Reload the map to check whether the import finished before retrying.`,
      }, { status: 502 }));
    }
  }
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
    if (reportPaths.has(url.pathname)) return uploadReport(url, options, headers);
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
