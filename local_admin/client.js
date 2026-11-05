(() => {
  const nativeFetch = window.fetch.bind(window);
  const writes = new Set(['/admin/update-county', '/admin/update-state', '/admin/site-config',
    '/admin/upload', '/admin/upload-desc-doc', '/admin/upload-descriptions']);
  let banner;
  const show = (message, failed = false) => {
    if (!banner) return;
    banner.textContent = message;
    banner.style.background = failed ? '#8f2020' : '#1a2b45';
  };
  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input, location.href) : null;
    const write = url?.origin === location.origin && writes.has(url.pathname) && options.method === 'POST';
    const headers = new Headers(options.headers);
    if (url?.origin === location.origin && url.searchParams.has('password')) {
      headers.set('X-Victig-Password', url.searchParams.get('password'));
      url.searchParams.delete('password');
    }
    if (write) show('Processing on this Mac… Public map updates after verification.');
    try {
      if (url?.origin === location.origin && url.pathname === '/api/analytics/backfill-geo' && options.method === 'POST') {
        let enriched = 0, total = 0;
        while (true) {
          const part = await nativeFetch(url, { ...options, headers });
          if (!part.ok) return part;
          const result = await part.json();
          enriched += result.enriched || 0;
          total += result.total || 0;
          if (!result.has_more) return Response.json({ enriched, total });
          url.searchParams.set('after_id', result.next_after_id);
        }
      }
      const response = await nativeFetch(url || input, { ...options, headers });
      if (write) {
        const data = await response.clone().json();
        show(response.ok && data.publish?.verified
          ? `Mac mini admin · Public map verified at ${new Date().toLocaleTimeString()}`
          : `Update not verified: ${data.detail || 'reload before retrying'}`, !response.ok);
      }
      return response;
    } catch (error) {
      if (write) show('Connection lost. Publication is unverified; reload before retrying.', true);
      throw error;
    }
  };
  addEventListener('DOMContentLoaded', () => {
    if (window.top !== window || !['/admin', '/admin.html', '/analytics'].includes(location.pathname)) return;
    banner = document.createElement('div');
    banner.id = 'local-publish-status';
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;bottom:10px;left:10px;max-width:calc(100vw - 20px);padding:9px 14px;color:white;border-radius:7px;font:12px/1.4 system-ui;z-index:9999;box-shadow:0 2px 8px #0003';
    document.body.append(banner);
    show('Mac mini admin · Saves publish to the live Hub map.');
  });
})();
