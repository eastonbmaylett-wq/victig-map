// Run through the browser's developer protocol after the public map loads.
// Restores fetch after testing so automated checks cannot pollute analytics.
(() => {
  const originalFetch = window.fetch;
  const proof = { url: location.href, dataDate: document.querySelector('#data-date').textContent,
    records: Object.keys(counties).length, paths: document.querySelectorAll('path.county').length,
    tested: 0, withRecentData: 0, withoutRecentData: 0, statewideFallback: 0,
    noAvailableData: [], searches: 0, metricEdgeCases: 0, suppressedAnalytics: 0, failures: [] };
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
        check(path.getAttribute('fill') === gradScale(stats.avg), fips, 'County color differs from county average');
        const values = [...body.querySelectorAll('.p-grid .p-val')].map(x => x.textContent);
        for (const [index, key] of ['avg', 'max', 'min'].entries())
          check(values[index] === (county._overrides?.[key] || daysToReadable(stats[key])), fips, `Wrong ${key} TAT`);
      } else {
        proof.withoutRecentData++;
        check(body.textContent.includes('No county-level searches in the last 90 days.'), fips, 'Missing no-data explanation');
        check(getAvg(fips) === null, fips, 'Statewide fallback changed county statistics');
        check(!body.querySelector('.p-rank'), fips, 'Statewide fallback has a county rank');
        if (Number.isFinite(county.state_avg?.avg)) {
          proof.statewideFallback++;
          check(path.getAttribute('fill') === gradScale(county.state_avg.avg), fips, 'Missing statewide color');
          check(body.querySelector('.p-state-average')?.textContent.includes(daysToReadable(county.state_avg.avg)), fips, 'Wrong statewide average');
          check(body.querySelector('.p-map-source')?.textContent.includes('Full report period'), fips, 'Missing statewide period label');
          path.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 350, clientY: 320 }));
          check(document.querySelector('#tooltip').textContent.includes(`${county.state} statewide avg (full report)`), fips, 'Missing statewide tooltip label');
        } else {
          proof.noAvailableData.push({ fips, name: county.name, state: county.state });
          check(path.getAttribute('fill') === STATUS.no_data.fill, fips, 'Missing no-data fill');
          check(body.textContent.includes('No statewide average is available.'), fips, 'Missing statewide no-data explanation');
        }
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
    for (const row of document.querySelectorAll('.rank-row')) {
      const fips = row.getAttribute('onclick')?.match(/flyTo\('([^']+)'\)/)?.[1];
      check(Boolean(getStats(fips)), fips, 'Statewide fallback included in county ranking');
    }
    const testFips = '__map_metric_test__';
    check(!Object.hasOwn(counties, testFips), testFips, 'Fixture key already exists');
    if (!Object.hasOwn(counties, testFips)) {
      try {
        for (const fixture of [
          {county: 0, state: 7, source: 'county', avg: 0},
          {county: 4, state: 0, source: 'county', avg: 4},
          {state: 0, source: 'state', avg: 0},
          {county: NaN, state: 2, source: 'state', avg: 2},
          {state: null, source: 'none', avg: null},
          {state: '2', source: 'none', avg: null},
          {state: Infinity, source: 'none', avg: null},
        ]) {
          counties[testFips] = {periods: fixture.county === undefined ? {} : {'90d': {avg: fixture.county}}, state_avg: {avg: fixture.state}};
          const metric = getMapMetric(testFips);
          check(metric.source === fixture.source && metric.avg === fixture.avg, testFips, 'Incorrect metric precedence or empty-value handling');
          check(getFill(testFips) === (fixture.avg === null ? STATUS.no_data.fill : gradScale(fixture.avg)), testFips, 'Incorrect edge-case color');
          proof.metricEdgeCases++;
        }
      } finally {
        delete counties[testFips];
      }
    }
    return proof;
  } finally {
    window.fetch = originalFetch;
    closePopup();
    document.querySelector('#tooltip').style.display = 'none';
    searchEl.value = '';
    searchRes.style.display = 'none';
  }
})()
