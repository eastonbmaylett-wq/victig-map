// Run through the browser's developer protocol after the public map loads.
// Restores fetch after testing so automated checks cannot pollute analytics.
(() => {
  const originalFetch = window.fetch;
  const proof = { url: location.href, dataDate: document.querySelector('#data-date').textContent,
    records: Object.keys(counties).length, paths: document.querySelectorAll('path.county').length,
    tested: 0, withRecentData: 0, withoutRecentData: 0, searches: 0, suppressedAnalytics: 0, failures: [] };
  window.fetch = (url, ...args) => {
    if (String(url).includes('/api/log/')) {
      proof.suppressedAnalytics++;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return originalFetch(url, ...args);
  };
  const check = (condition, fips, message) => {
    if (!condition) proof.failures.push({ fips, message });
  };
  try {
    for (const [fips, county] of Object.entries(counties)) {
      const path = countyPaths[fips];
      check(Boolean(path), fips, 'Missing path');
      if (!path) continue;
      check(document.querySelectorAll(`path.county[data-fips="${fips}"]`).length === 1, fips, 'Duplicate path');
      const shape = path.getAttribute('d');
      const box = path.getBBox();
      check(Boolean(shape) && !/NaN|Infinity/.test(shape) && box.width > 0 && box.height > 0, fips, 'Empty geometry');
      path.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 350, clientY: 320 }));
      const popup = document.querySelector('#popup');
      const body = document.querySelector('#popup-body');
      check(getComputedStyle(popup).display !== 'none', fips, 'Popup hidden');
      check(body.querySelector('h3')?.textContent === countyLabel(county), fips, 'Wrong county title');
      check(!/NaN|undefined|Infinity/.test(body.textContent), fips, 'Invalid displayed value');
      const stats = county.periods?.['90d'];
      if (stats) {
        proof.withRecentData++;
        const values = [...body.querySelectorAll('.p-grid .p-val')].map(x => x.textContent);
        for (const [index, key] of ['avg', 'max', 'min'].entries())
          check(values[index] === (county._overrides?.[key] || daysToReadable(stats[key])), fips, `Wrong ${key} TAT`);
      } else {
        proof.withoutRecentData++;
        check(body.textContent.includes('No county-level searches in the last 90 days.'), fips, 'Missing no-data explanation');
        check(path.getAttribute('fill') === STATUS.no_data.fill, fips, 'Missing no-data fill');
      }
      if (county.latest) {
        check(body.querySelector('.p-latest')?.textContent.includes(county.latest.date), fips, 'Wrong most recent search');
      }
      searchEl.value = countyLabel(county);
      searchEl.dispatchEvent(new Event('input', { bubbles: true }));
      const hits = [...searchRes.querySelectorAll('.search-item')];
      check(hits.some(x => x.getAttribute('onclick') === `flyTo('${fips}')`), fips, 'County missing from search results');
      proof.searches++;
      proof.tested++;
    }
    check(proof.paths === proof.records, '', 'Boundary count differs from record count');
    return proof;
  } finally {
    window.fetch = originalFetch;
    closePopup();
    searchEl.value = '';
    searchRes.style.display = 'none';
  }
})()
