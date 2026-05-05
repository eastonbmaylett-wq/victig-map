
const STATUS = {
  ok:          {fill:'#55ae5c',label:'No Delay',        badge:'#d4edda',text:'#155724'},
  delay:       {fill:'#dea922',label:'Delay',            badge:'#fff3cd',text:'#856404'},
  high_tat:    {fill:'#de7612',label:'Avg TAT >14 Days', badge:'#ffe5cc',text:'#7a3600'},
  significant: {fill:'#cf4027',label:'Significant Delay',badge:'#f8d7da',text:'#721c24'},
  closed:      {fill:'#7b2d8b',label:'Closed / No Access',badge:'#f3d9f8',text:'#5a1a6b'},
  no_data:     {fill:'#55ae5c',label:'No Data',          badge:'#f0f0f0',text:'#888'},
};

// Gradient: green→yellow→orange→red
const gradScale = d3.scaleSequential()
  .domain([0, 14])
  .clamp(true)
  .interpolator(d3.interpolateRgbBasis(['#55ae5c','#dea922','#de7612','#cf4027']));

let counties = {};
let localOverrides = JSON.parse(localStorage.getItem('victig_overrides')||'{}');
let editingFips = null;
let countyPaths = {};
const activePeriod = '90d';
const activeType   = 'all';
let svgZoom, svgSel, gSel;
let topoData;
let stateFeatures = [];
let pathFn;

function getC(fips){ return counties[fips]; }

function getStats(fips){
  const c = getC(fips); if(!c) return null;
  if(activeType !== 'all'){
    return c.types?.[activeType] || null;
  }
  return c.periods?.[activePeriod] || null;
}

function daysToReadable(d){
  if(d == null) return '—';
  if(d === 0) return 'Same day';
  const totalSec = Math.round(d * 86400);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if(h === 0 && m === 0) return `${s}s`;
  if(h === 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  if(h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const days = Math.floor(h / 24);
  const remH = h % 24;
  if(remH === 0 && m === 0) return `${days}d`;
  if(remH === 0) return `${days}d ${m}m`;
  return `${days}d ${remH}h`;
}

function daysToHM(d){
  if(d == null) return '—';
  const totalSec = Math.round(d * 86400);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if(h === 0 && m === 0) return `${s}s`;
  if(h === 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getAvg(fips){
  const s = getStats(fips); return s?.avg ?? null;
}

function getStatus(fips){
  const c = getC(fips); if(!c) return 'no_data';
  return c.status || 'ok';
}

function getFill(fips){
  const avg = getAvg(fips);
  if(avg === null) return STATUS.no_data.fill;
  return gradScale(avg);
}

function dimmed(fips){ return false; }

// ── Init ─────────────────────────────────────────────────────────────────
function setStatus(msg){ document.getElementById('data-date').textContent = msg; }

async function init(){
  setStatus('Loading map data…');
  let topo, data;
  try {
    setStatus('Fetching boundaries…');
    const topoRes  = await fetch('counties-10m.json');
    if (!topoRes.ok) throw new Error('boundaries HTTP ' + topoRes.status);
    topo = await topoRes.json();
    setStatus('Fetching county stats…');
    const dataRes  = await fetch('county-data.json');
    if (!dataRes.ok) throw new Error('county-data HTTP ' + dataRes.status);
    data = await dataRes.json();
  } catch(e) {
    setStatus('Load error: ' + e.message);
    console.error(e);
    return;
  }
  setStatus('Rendering map…');
  topoData = topo;
  counties = data.counties;

  // Enrich counties with state avg — prefer top-level stateAvg (written by process.py),
  // fall back to computing it client-side from existing per-county period data.
  // Build stateAvg: prefer server-computed, else derive client-side from county period data
  const stateAvgMap = {};
  if (data.stateAvg && Object.keys(data.stateAvg).length) {
    Object.assign(stateAvgMap, data.stateAvg);
  } else {
    const buckets = {};
    for (const c of Object.values(counties)) {
      const st = c.state;
      if (!st || !c.periods) continue;
      const p = c.periods['90d'] || c.periods['180d'] || c.periods['60d'] || c.periods['30d'];
      if (!p || !p.avg || !p.count) continue;
      if (!buckets[st]) buckets[st] = { sum: 0, n: 0 };
      buckets[st].sum += p.avg * p.count;
      buckets[st].n   += p.count;
    }
    for (const [st, b] of Object.entries(buckets)) {
      stateAvgMap[st] = { avg: b.sum / b.n, count: b.n };
    }
  }
  // Always compute state rank (whether from server or client-side)
  const stateRanked = Object.entries(stateAvgMap).sort((a,b) => a[1].avg - b[1].avg);
  const stateTotal  = stateRanked.length;
  stateRanked.forEach(([st], i) => {
    stateAvgMap[st].rank  = i + 1;
    stateAvgMap[st].total = stateTotal;
  });
  // Attach to every county object so popup can reference it
  for (const c of Object.values(counties)) {
    if (c.state && stateAvgMap[c.state]) {
      c.state_avg = stateAvgMap[c.state];
    }
  }
  console.log('[stateAvg] computed for', Object.keys(stateAvgMap).length, 'states, sample:', Object.entries(stateAvgMap)[0]);

  // Apply local overrides
  for(const [fips,ov] of Object.entries(localOverrides)){
    if(counties[fips]){
      if(ov.status)       counties[fips].status = ov.status;
      if(ov.description !== undefined) counties[fips].description = ov.description;
    }
  }

  const dateStr = data.maxDate ? `Data through ${data.maxDate}` : '';
  document.getElementById('data-date').textContent = dateStr;

  drawMap(topo);
  updateBadge();
  buildPanels();
  buildSearchIndex();

}

// ── Map ───────────────────────────────────────────────────────────────────
function drawMap(topo){
  const wrap = document.getElementById('map-wrap');
  const W = wrap.clientWidth || window.innerWidth || 1200;
  const H = wrap.clientHeight || (window.innerHeight - 120) || 700;
  console.log('[MAP] drawMap W='+W+' H='+H+' counties='+Object.keys(counties).length);
  setStatus('Drawing ('+W+'x'+H+')…');
  svgSel = d3.select('#map-svg').attr('width',W).attr('height',H);

  const allCounties = topojson.feature(topo, topo.objects.counties);
  const allStates   = topojson.feature(topo, topo.objects.states);
  const stateMesh   = topojson.mesh(topo, topo.objects.states, (a,b)=>a!==b);

  // Exclude Pacific territories (GU/AS/MP) from fitSize — they break Albers USA projection
  const fitFeatures = {...allCounties, features: allCounties.features.filter(f=>!String(f.id).match(/^(60|66|69)/)) };
  const proj = d3.geoAlbersUsa().fitSize([W,H], fitFeatures);
  const path = d3.geoPath().projection(proj);
  pathFn = path;
  stateFeatures = allStates.features;

  gSel = svgSel.append('g');

  // Counties
  gSel.append('g').selectAll('path')
    .data(allCounties.features).join('path')
    .attr('class','county')
    .attr('d', path)
    .attr('fill', d => getFill(d.id))
    .attr('opacity', d => dimmed(d.id) ? 0.25 : 1)
    .on('mousemove', onHover)
    .on('mouseleave', ()=> document.getElementById('tooltip').style.display='none')
    .on('click', onCountyClick)
    .on('dblclick', (event, d) => {
      event.stopPropagation();
      const stateFips = d.id.slice(0,2);
      const stateFeature = allStates.features.find(s => s.id === stateFips);
      if(stateFeature) svgSel.transition().duration(600)
        .call(svgZoom.transform, zoomToBounds(path.bounds(stateFeature), W, H));
    })
    .each(function(d){ countyPaths[d.id]=this; });



  // State borders
  gSel.append('path').datum(stateMesh)
    .attr('class','state-border').attr('d',path);

  // Zoom
  svgZoom = d3.zoom().scaleExtent([0.5,12])
    .on('zoom',(event)=>{
      gSel.attr('transform',event.transform);
      const k = event.transform.k;
      gSel.selectAll('.county').attr('stroke-width', 0.3/k);
      gSel.selectAll('.state-border').attr('stroke-width', 2/k);
      placeMedalsOnMap(currentMedalData);
      closePopup();
    });
  svgSel.call(svgZoom);
  svgSel.on('dblclick.zoom', null); // handle dblclick ourselves

  document.getElementById('z-in').onclick    = ()=> svgSel.transition().call(svgZoom.scaleBy,1.6);
  document.getElementById('z-out').onclick   = ()=> svgSel.transition().call(svgZoom.scaleBy,0.625);
  document.getElementById('z-reset').onclick = ()=> svgSel.transition().call(svgZoom.transform,d3.zoomIdentity);

  // ── Puerto Rico inset — fixed HTML overlay, never moves with map ───────────────────
  buildPRInset(topo, W, H);
}

function buildPRInset(topo, W, H){
  const wrap = document.getElementById('map-wrap');
  document.getElementById('pr-inset-div')?.remove();

  const PW = Math.min(180, Math.round(W * 0.10));
  const PH = Math.round(PW * 0.52);
  const div = document.createElement('div');
  div.id = 'pr-inset-div';
  Object.assign(div.style, {
    position:'absolute', bottom:'12px', right:'200px',
    width: PW+'px', height: PH+'px',
    background:'white', border:'1px solid #bbb', borderRadius:'4px',
    boxShadow:'0 1px 6px rgba(0,0,0,.1)', overflow:'hidden', pointerEvents:'auto',
    zIndex:'60'
  });
  wrap.appendChild(div);

  const lbl = document.createElement('div');
  lbl.textContent = 'PUERTO RICO';
  Object.assign(lbl.style, {
    position:'absolute', top:'3px', left:'4px',
    fontSize:'7px', fontWeight:'700', color:'#999',
    fontFamily:'sans-serif', pointerEvents:'none', zIndex:'1'
  });
  div.appendChild(lbl);

  const prFeatures = topojson.feature(topo, {
    type:'GeometryCollection',
    geometries: topo.objects.counties.geometries.filter(g=>String(g.id).startsWith('72'))
  });
  const prSvg = d3.select(div).append('svg').attr('width',PW).attr('height',PH);
  const prProj = d3.geoAlbers().rotate([66,0]).parallels([8,18]).fitSize([PW,PH],prFeatures);
  const prPath = d3.geoPath().projection(prProj);

  prSvg.selectAll('path').data(prFeatures.features).join('path')
    .attr('class','county pr-county').attr('d',prPath)
    .attr('fill', d=>getFill(d.id)).attr('stroke','#e8e8e8').attr('stroke-width',0.4)
    .on('mousemove', onHover)
    .on('mouseleave', ()=>document.getElementById('tooltip').style.display='none')
    .on('click', onCountyClick)
    .each(function(d){ countyPaths[d.id]=this; });
  const prMesh = topojson.mesh(topo,{
    type:'GeometryCollection',
    geometries:topo.objects.counties.geometries.filter(g=>String(g.id).startsWith('72'))
  },(a,b)=>a!==b);
  prSvg.append('path').datum(prMesh).attr('fill','none').attr('stroke','white').attr('stroke-width',0.6);
}

function zoomToBounds(bounds, W, H){
  const [[x0,y0],[x1,y1]] = bounds;
  const scale = Math.min(8, 0.85/Math.max((x1-x0)/W,(y1-y0)/H));
  const tx = W/2 - scale*(x0+x1)/2;
  const ty = H/2 - scale*(y0+y1)/2;
  return d3.zoomIdentity.translate(tx,ty).scale(scale);
}

// ── Tooltip ───────────────────────────────────────────────────────────────
function onHover(event, d){
  const c = getC(d.id);
  const tt = document.getElementById('tooltip');
  if(!c){ tt.style.display='none'; return; }
  const avg = getAvg(d.id);
  const avgStr = avg !== null ? ` · ${avg}d avg` : '';
  tt.textContent = `${c.name}, ${c.state}${avgStr}`;
  tt.style.display='block';
  tt.style.left=(event.offsetX+14)+'px';
  tt.style.top=(event.offsetY-10)+'px';
}

// ── County Popup ──────────────────────────────────────────────────────────
function onCountyClick(event, d){
  const c = getC(d.id); if(!c) return;
  const s = getStats(d.id);
  const status = getStatus(d.id);
  const sc = STATUS[status];
  // Performance vs average based on rank percentile
  let perfHtml = '';
  if(s && s.rank && s.total){
    const pct = s.rank / s.total;
    const [label, color] = pct <= 0.33 ? ['Above Average','#155724']
                         : pct <= 0.66 ? ['Average','#856404']
                         :               ['Below Average','#721c24'];
    perfHtml = `<div style="font-size:11px;margin-bottom:8px;color:#555">Search Time: <strong style="color:${color}">${label}</strong></div>`;
  }

  let statsHtml = '';
  if(s){
    const rankPct = s.rank ? Math.round((1-s.rank/s.total)*100) : null;
    statsHtml = `
      <div class="p-grid">
        <div><div class="p-lbl">Avg TAT</div><div class="p-val">${c._overrides?.avg || daysToReadable(s.avg)}</div></div>
        <div><div class="p-lbl">Max TAT</div><div class="p-val">${c._overrides?.max || daysToReadable(s.max)}</div></div>
        <div><div class="p-lbl">Min TAT</div><div class="p-val">${c._overrides?.min || daysToReadable(s.min)}</div></div>
        ${c.state_avg ? `<div><div class="p-lbl">${c.state} Statewide Avg</div><div class="p-val">${daysToReadable(c.state_avg.avg)}</div></div>` : ''}
      </div>
      ${rankPct !== null ? `<div class="p-rank">Faster than <strong>${rankPct}%</strong> of all US counties (#${s.rank} of ${s.total.toLocaleString()})</div>` : ''}
      ${c.precomp?.gt2weeks ? `<div style="font-size:10px;color:#de7612;margin-top:4px">⚠ ${c.precomp.gt2weeks} search${c.precomp.gt2weeks!==1?'es':''} exceeded 2 weeks</div>` : ''}
      ${c.precomp?.lt10min ? `<div style="font-size:10px;color:#55ae5c;margin-top:2px">⚡ ${c.precomp.lt10min} search${c.precomp.lt10min!==1?'es':''} completed in under 10 min</div>` : ''}
      `;
  }

  let stateAvgHtml = '';
  if (!s && c.state_avg && c.state_avg.avg) {
    const sa = c.state_avg;
    const stateTotal = sa.total || 50;
    const stateRank  = sa.rank  || null;
    const statePct   = stateRank ? Math.round((1 - stateRank / stateTotal) * 100) : null;
    const [stLabel, stColor] = statePct === null ? ['','#555']
      : statePct <= 33  ? ['Above Average','#721c24']
      : statePct <= 66  ? ['Average','#856404']
      :                   ['Below Average','#155724'];
    stateAvgHtml = `<div style="text-align:center;padding:14px 8px 10px;background:#f7f8fa;border-radius:8px;margin-bottom:10px">
      <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">${c.state} Statewide Average TAT</div>
      <div style="font-size:32px;font-weight:700;color:#1a2b45;line-height:1">${daysToReadable(sa.avg)}</div>
      ${stLabel ? `<div style="margin-top:6px;font-size:12px;color:#555">Search Time: <strong style="color:${stColor}">${stLabel}</strong></div>` : ''}
      ${statePct !== null ? `<div style="font-size:11px;color:#888;margin-top:4px">Faster than <strong>${statePct}%</strong> of US states (#${stateRank} of ${stateTotal})</div>` : ''}
    </div>`;
  }

  const descHtml = c.description
    ? `<div class="p-desc">${c.description}</div>`
    : `<div class="p-desc" style="border-left-color:#55ae5c;color:#888">No active court delays reported for this county.</div>`;

  const latestHtml = c.latest ? `
    <div class="p-latest">
      <div class="p-latest-title">Most Recent Search</div>
      <div class="p-latest-row"><span class="p-latest-lbl">Started</span><span>${c.latest.date}</span></div>
      ${c.latest.completion ? `<div class="p-latest-row"><span class="p-latest-lbl">Completed</span><span>${c.latest.completion}</span></div>` : ''}
      <div class="p-latest-row"><span class="p-latest-lbl">TAT</span><span><b>${c._overrides?.latest_tat || daysToReadable(c.latest.tat)}</b></span></div>
      <div class="p-latest-row"><span class="p-latest-lbl">Type</span><span>${c.latest.search}</span></div>
    </div>` : '';

  const outHtml = (c.outliers && c.outliers.length) ? `
    <div class="p-latest" style="border-top:1px solid #f0f0f0;margin-top:8px;padding-top:8px">
      <div class="p-latest-title" style="color:#cf4027">⚠ Outlier Searches (${c.outliers.length})</div>
      ${c.outliers.slice(0,3).map(o=>`
        <div class="p-latest-row" style="margin-top:4px">
          <span class="p-latest-lbl">${o.tat ? Math.round(o.tat)+'d' : '?'}</span>
          <span style="font-size:10px">${o.reason}</span>
        </div>`).join('')}
    </div>` : '';

  // Log county click (fire-and-forget)
  fetch('/api/log/click', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({fips: d.id, county: c.name, state: c.state})}).catch(()=>{});

  document.getElementById('popup-body').innerHTML = `
    <h3>${c.name} County, ${c.state}</h3>
    <span class="p-badge" style="background:${sc.badge};color:${sc.text}">${sc.label}</span>
    ${perfHtml}
    ${statsHtml}${stateAvgHtml}${outHtml}${latestHtml}${descHtml}
`;

  const popup = document.getElementById('popup');
  const wrap  = document.getElementById('map-wrap');
  // Show offscreen first to measure real height
  popup.style.left = '-9999px'; popup.style.top = '-9999px'; popup.style.display = 'block';
  const pw = popup.offsetWidth, ph = popup.offsetHeight;
  const pad = 12;
  let x = event.offsetX + 16;
  let y = event.offsetY - 20;
  // Flip left if not enough room on right
  if (x + pw + pad > wrap.clientWidth)  x = event.offsetX - pw - 8;
  // Clamp top so bottom doesn't go off screen
  if (y + ph + pad > wrap.clientHeight) y = wrap.clientHeight - ph - pad;
  // Never go above top
  if (y < pad) y = pad;
  // Never go off left
  if (x < pad) x = pad;
  popup.style.left = x+'px'; popup.style.top = y+'px';
}
function closePopup(){ document.getElementById('popup').style.display='none'; }
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closePopup(); closeAdmin(); }});

// Toolbar removed — defaults: 90d, all searches, gradient color, no filter

function refreshColors(){
  d3.selectAll('.county')
    .attr('fill',    d=> getFill(d.id))
    .attr('opacity', d=> dimmed(d.id) ? 0.2 : 1);
  // Refresh PR inset colors too
  d3.selectAll('.pr-county')
    .attr('fill', d => getFill(d.id));
}

// ── Badge ─────────────────────────────────────────────────────────────────
function updateBadge(){
  const n = Object.values(counties).filter(c=>['delay','high_tat','significant'].includes(c.status)).length;
  document.getElementById('delayed-badge').textContent = `${n} delayed`;
}

// ── Side Panels ───────────────────────────────────────────────────────────
const MEDALS = ['🥇','🥈','🥉'];
function buildPanels(){
  // Update panel subtitles to reflect active filter
  document.querySelectorAll('.panel-header h4').forEach((el, i) => {
    const icons = ['🥇 Fastest','🐢 Slowest'];
    el.textContent = icons[i];
  });

  const eligible = Object.entries(counties)
    .map(([fips,c])=>({fips, c, s: getStats(fips)}))
    .filter(x=> x.s && x.s.count >= 1);

  const fastest = [...eligible].sort((a,b)=>a.s.avg-b.s.avg).slice(0,10);
  const slowest = [...eligible].sort((a,b)=>b.s.avg-a.s.avg).slice(0,10);

  document.getElementById('panel-fastest').innerHTML = fastest.map((x,i)=>`
    <div class="rank-row" onclick="flyTo('${x.fips}')">
      <span class="rank-medal">${i<3?MEDALS[i]:''}</span>
      <span class="rank-num">${i>=3?i+1:''}</span>
      <div><div class="rank-name">${x.c.name}, ${x.c.state}</div></div>
    </div>`).join('');

  document.getElementById('panel-slowest').innerHTML = slowest.map((x,i)=>`
    <div class="rank-row" onclick="flyTo('${x.fips}')">
      <span class="rank-medal">${i<3?['🔴','🟠','🟡'][i]:''}</span>
      <span class="rank-num">${i>=3?i+1:''}</span>
      <div><div class="rank-name">${x.c.name}, ${x.c.state}</div></div>
    </div>`).join('');

  // Draw medal labels on the map over top-3 fastest counties
  currentMedalData = fastest.slice(0,3);
  placeMedalsOnMap(currentMedalData);
}

let currentMedalData = [];

function placeMedalsOnMap(top3){
  if(!svgSel || !pathFn) return;
  // Medals live OUTSIDE the zoom group so they stay fixed size on screen
  svgSel.selectAll('.medal-layer').remove();
  if(!top3 || !top3.length) return;

  const transform = d3.zoomTransform(svgSel.node());
  const layer = svgSel.append('g').attr('class','medal-layer');

  top3.forEach((x, i) => {
    const el = countyPaths[x.fips];
    if(!el) return;
    // Get centroid in gSel coordinate space
    let gx, gy;
    try {
      const bb = el.getBBox();
      gx = bb.x + bb.width / 2;
      gy = bb.y + bb.height / 2;
    } catch(e) {
      const datum = d3.select(el).datum();
      if(!datum) return;
      [gx, gy] = pathFn.centroid(datum);
    }
    if(isNaN(gx) || isNaN(gy)) return;
    // Convert gSel coords -> screen coords using current zoom transform
    const [sx, sy] = transform.apply([gx, gy]);
    layer.append('text')
      .attr('class','county-medal')
      .attr('x', sx)
      .attr('y', sy + 2)
      .attr('text-anchor','middle')
      .attr('dominant-baseline','middle')
      .attr('font-size','28px')
      .attr('pointer-events','none')
      .style('user-select','none')
      .style('filter','drop-shadow(0 1px 2px rgba(0,0,0,.3))')
      .text(MEDALS[i]);
  });
}

function togglePanel(which){
  const body = document.getElementById(`panel-${which}`);
  const tog  = document.getElementById(`tog-${which}`);
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  tog.textContent    = open ? '▼' : '▲';
}

// Rebuild panels when period or type changes so lists stay in sync
function rebuildPanelsIfOpen(){
  ['fastest','slowest'].forEach(which => {
    if(document.getElementById(`panel-${which}`).style.display !== 'none') buildPanels();
    else buildPanels(); // always rebuild so data is fresh when opened
  });
}

// ── Search ────────────────────────────────────────────────────────────────
const STATE_NAMES = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
  'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
  'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri',
  'MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey',
  'NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio',
  'OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
  'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont',
  'VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming',
  'DC':'District of Columbia'
};
const STATE_FIPS_MAP = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE',
  '11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA',
  '20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN',
  '28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM',
  '36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
  '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA',
  '54':'WV','55':'WI','56':'WY'
};

let searchIndex = [];
function buildSearchIndex(){
  // Counties
  for(const [fips,c] of Object.entries(counties)){
    if(c.name) searchIndex.push({type:'county', fips, label:`${c.name} County`, sub:c.state});
  }
  // States
  for(const [abbrev, name] of Object.entries(STATE_NAMES)){
    searchIndex.push({type:'state', abbrev, label:name, sub:'State'});
  }
  searchIndex.sort((a,b)=>a.label.localeCompare(b.label));
}
const searchEl  = document.getElementById('search');
const searchRes = document.getElementById('search-results');
searchEl.addEventListener('input',()=>{
  const q = searchEl.value.trim().toLowerCase();
  if(q.length<2){searchRes.style.display='none';return;}
  const hits = searchIndex.filter(x=>x.label.toLowerCase().includes(q)||x.sub.toLowerCase().includes(q)).slice(0,10);
  if(!hits.length){searchRes.style.display='none';return;}
  searchRes.innerHTML = hits.map(h=> h.type==='state'
    ? `<div class="search-item" onclick="flyToState('${h.abbrev}')">${h.label}<span class="s-badge">State</span></div>`
    : `<div class="search-item" onclick="flyTo('${h.fips}')">${h.label}<span class="s-badge">${h.sub}</span></div>`
  ).join('');
  searchRes.style.display='block';
});
document.addEventListener('click',e=>{ if(!e.target.closest('#search-wrap')) searchRes.style.display='none'; });

function flyToState(abbrev){
  searchRes.style.display='none'; searchEl.value='';
  const W = +svgSel.attr('width'), H = +svgSel.attr('height');
  // Find state fips from abbrev
  const stateFips = Object.entries(STATE_FIPS_MAP).find(([,a])=>a===abbrev)?.[0];
  if(!stateFips) return;
  const feature = stateFeatures.find(f=> f.id === stateFips);
  if(!feature) return;
  svgSel.transition().duration(600).call(svgZoom.transform, zoomToBounds(pathFn.bounds(feature), W, H));
}

function flyTo(fips){
  searchRes.style.display='none'; searchEl.value='';
  const el = countyPaths[fips];
  if(!el) return;
  // Zoom to county
  const bounds = d3.geoPath().projection(
    d3.geoAlbersUsa().fitSize([svgSel.attr('width'), svgSel.attr('height')],
      topojson.feature(topoData, topoData.objects.counties))
  ).bounds(el.__data__);
  const W = +svgSel.attr('width'), H = +svgSel.attr('height');
  svgSel.transition().duration(600).call(svgZoom.transform, zoomToBounds(bounds,W,H));
  setTimeout(()=> el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:W/2,clientY:H/2})), 650);
}

// ── Password Gate ────────────────────────────────────────────────────────
// SHA-256 of the admin password — change this hash to change the password
// Current password: Victig2026!  (hash it at sha256.online or ask Alfred)
const PW_HASH = 'b3121997c76507dc7adcf3ca13ee60d519cbc3c72a176527e8ba575fc13f3406';
let adminUnlocked = !!sessionStorage.getItem('victig_admin');
let pendingAdminFips = null;

async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function showPwGate(fips){
  pendingAdminFips = fips;
  document.getElementById('pw-input').value = '';
  document.getElementById('pw-error').textContent = '';
  document.getElementById('pw-gate').style.display = 'block';
  document.getElementById('overlay').style.display = 'block';
  setTimeout(()=> document.getElementById('pw-input').focus(), 50);
}

async function submitPw(){
  const val = document.getElementById('pw-input').value;
  const hash = await sha256(val);
  if(hash === PW_HASH){
    sessionStorage.setItem('victig_admin','1');
    adminUnlocked = true;
    updateLockIcon();
    document.getElementById('pw-gate').style.display = 'none';
    document.getElementById('overlay').style.display = 'none';
    if(pendingAdminFips) openAdmin(pendingAdminFips);
  } else {
    document.getElementById('pw-error').textContent = 'Incorrect password.';
    document.getElementById('pw-input').value = '';
    document.getElementById('pw-input').focus();
  }
}

function cancelPw(){
  document.getElementById('pw-gate').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';
  pendingAdminFips = null;
}

function logoutAdmin(){
  sessionStorage.removeItem('victig_admin');
  adminUnlocked = false;
  updateLockIcon();
}

function updateLockIcon(){
  const el = document.getElementById('admin-lock');
  const icon = document.getElementById('lock-icon');
  if(!el || !icon) return; // elements removed from public view
  if(adminUnlocked){
    icon.textContent = '🔓';
    el.title = 'Admin signed in — click to sign out';
  } else {
    icon.textContent = '🔒';
    el.title = 'Admin login';
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────
function openAdmin(fips){
  closePopup(); editingFips=fips;
  const c=getC(fips);
  document.getElementById('admin-lbl').textContent=`${c.name} County, ${c.state}`;
  document.getElementById('admin-status').value=c.status||'ok';
  document.getElementById('admin-desc').value=c.description||'';
  document.getElementById('admin-panel').style.display='block';
  document.getElementById('overlay').style.display='block';
}
function closeAdmin(){
  document.getElementById('admin-panel').style.display='none';
  document.getElementById('overlay').style.display='none';
  editingFips=null;
}
function saveAdmin(){
  if(!editingFips) return;
  const status=document.getElementById('admin-status').value;
  const desc=document.getElementById('admin-desc').value.trim();
  counties[editingFips].status=status;
  counties[editingFips].description=desc;
  localOverrides[editingFips]={status,description:desc};
  localStorage.setItem('victig_overrides',JSON.stringify(localOverrides));
  const el=countyPaths[editingFips];
  if(el) d3.select(el).attr('fill',getFill(editingFips));
  updateBadge(); closeAdmin();
}

// ── Auto-update detector ─────────────────────────────────────────────────
(function(){
  let knownVersion = null;
  function checkVersion(){
    fetch('/api/version').then(r=>r.json()).then(d=>{
      if(!knownVersion){ knownVersion = d.version; return; }
      if(d.version !== knownVersion){
        const banner = document.getElementById('update-banner');
        if(banner) banner.style.display='flex';
      }
    }).catch(()=>{});
  }
  checkVersion();
  setInterval(checkVersion, 30000); // check every 30s
})();

updateLockIcon();
init().catch(err => {
  document.getElementById('data-date').textContent = 'Map error: ' + err.message;
  console.error('Map init failed:', err);
});
