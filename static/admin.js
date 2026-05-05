
const PW_HASH = 'b3121997c76507dc7adcf3ca13ee60d519cbc3c72a176527e8ba575fc13f3406';
const STATUS_FILL  = {ok:'#55ae5c', delay:'#dea922', high_tat:'#de7612', significant:'#cf4027', no_data:'#d4d8dd'};
const STATUS_BADGE = {
  ok:          {bg:'#d4edda',fg:'#155724',label:'No Delay'},
  delay:       {bg:'#fff3cd',fg:'#856404',label:'Delay'},
  high_tat:    {bg:'#ffe5cc',fg:'#7a3600',label:'TAT >14d'},
  significant: {bg:'#f8d7da',fg:'#721c24',label:'Significant'},
  closed:      {bg:'#f3d9f8',fg:'#5a1a6b',label:'Closed'},
};

let token = sessionStorage.getItem('victig_admin_token') || '';
let counties = {}, allFlagged = [], allCountiesList = [], selectedFips = null, pendingFile = null;
let svgSel, countyPaths = {}, topoData;
let listMode = 'flagged'; // 'flagged' | 'all' | 'state'
const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'D.C.'
};

// ── Auth ──────────────────────────────────────────────────────────────────
async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function doLogin(){
  const pw = document.getElementById('pw-input').value;
  if((await sha256(pw)) === PW_HASH){
    token = pw;
    sessionStorage.setItem('victig_admin_token', pw);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('admin-ui').style.display = 'flex';
    loadAll();
  } else {
    document.getElementById('login-error').textContent = 'Incorrect password.';
    document.getElementById('pw-input').value = '';
  }
}
function doLogout(){ sessionStorage.removeItem('victig_admin_token'); location.reload(); }

// ── Load data + map ───────────────────────────────────────────────────────
async function loadAll(){
  const [topo, data] = await Promise.all([
    fetch('/counties-10m.json').then(r=>r.json()),
    fetch('/county-data.json').then(r=>r.json())
  ]);
  topoData = topo;
  counties = data.counties;

  // Date range in header
  if(data.maxDate){
    const max = new Date(data.maxDate);
    const min = new Date(max); min.setMonth(min.getMonth()-6);
    const fmt = d => d.toLocaleDateString('en-US',{month:'short',year:'numeric'});
    document.getElementById('data-date').textContent =
      `Data: ${fmt(min)} – ${fmt(max)} · Upload new CSV to refresh`;
  }

  buildLists();
  drawMap(topo);
}

// ── Map ───────────────────────────────────────────────────────────────────
function getFill(fips){ return STATUS_FILL[counties[fips]?.status] || STATUS_FILL.no_data; }

function drawMap(topo){
  const area = document.getElementById('map-area');
  const W = area.clientWidth, H = area.clientHeight;
  svgSel = d3.select('#admin-map-svg').attr('width',W).attr('height',H);

  const allCounties = topojson.feature(topo, topo.objects.counties);
  const stateMesh   = topojson.mesh(topo, topo.objects.states, (a,b)=>a!==b);
  const proj = d3.geoAlbersUsa().fitSize([W,H], allCounties);
  const path = d3.geoPath().projection(proj);

  const gSel = svgSel.append('g');

  gSel.append('g').selectAll('path')
    .data(allCounties.features).join('path')
    .attr('class','county')
    .attr('d', path)
    .attr('fill', d => getFill(d.id))
    .on('mouseover', function(){ d3.select(this).raise(); })
    .on('click', (event, d) => { event.stopPropagation(); selectCounty(d.id); })
    .each(function(d){ countyPaths[d.id] = this; });

  gSel.append('path').datum(stateMesh)
    .attr('fill','none').attr('stroke','white').attr('stroke-width',1.5).attr('pointer-events','none');

  // Pan/zoom
  const zoom = d3.zoom().scaleExtent([1,12]).on('zoom', e => {
    gSel.attr('transform', e.transform);
    gSel.selectAll('.county').attr('stroke-width', 0.3/e.transform.k);
    gSel.selectAll('path[stroke="white"]').attr('stroke-width', 1.5/e.transform.k);
  });
  svgSel.call(zoom);
  svgSel.on('dblclick.zoom', null);
}

function refreshMapColors(){
  Object.entries(countyPaths).forEach(([fips, el]) => {
    d3.select(el).attr('fill', getFill(fips));
  });
}

// ── County selection ──────────────────────────────────────────────────────
function selectCounty(fips){
  // Deselect old
  if(selectedFips && countyPaths[selectedFips])
    d3.select(countyPaths[selectedFips]).classed('selected-county', false);

  selectedFips = fips;
  const c = counties[fips] || {};

  // Highlight on map
  if(countyPaths[fips]){
    const el = d3.select(countyPaths[fips]);
    el.classed('selected-county', true).raise();
  }

  // Open edit panel
  document.getElementById('edit-title').textContent = `${c.name || fips} County`;
  document.getElementById('edit-sub').textContent = `${c.state || ''} · FIPS ${fips}`;
  document.getElementById('edit-status').value = c.status || 'ok';
  document.getElementById('edit-desc').value = c.description || '';
  document.getElementById('save-status').textContent = '';
  // Populate override fields with existing overrides (if any)
  const ov = c._overrides || {};
  document.getElementById('ov-avg').value         = ov.avg || '';
  document.getElementById('ov-max').value         = ov.max || '';
  document.getElementById('ov-min').value         = ov.min || '';
  document.getElementById('ov-latest-tat').value  = ov.latest_tat || '';
  document.getElementById('ov-latest-date').value = ov.latest_date || '';
  document.getElementById('edit-panel').classList.add('open');
  document.getElementById('map-hint').style.display = 'none';

  // Highlight in flagged list
  document.querySelectorAll('.flag-row').forEach(r => r.classList.remove('selected'));
  const row = document.querySelector(`.flag-row[data-fips="${fips}"]`);
  if(row){ row.classList.add('selected'); row.scrollIntoView({block:'nearest'}); }
}

function closeEdit(){
  if(selectedFips && countyPaths[selectedFips])
    d3.select(countyPaths[selectedFips]).classed('selected-county', false);
  selectedFips = null;
  document.getElementById('edit-panel').classList.remove('open');
  document.getElementById('map-hint').style.display = '';
  document.querySelectorAll('.flag-row').forEach(r => r.classList.remove('selected'));
}

// ── Save ──────────────────────────────────────────────────────────────────
async function saveCounty(){
  if(!selectedFips) return;
  const isState = selectedFips.startsWith('state:');
  const status = document.getElementById('edit-status').value;
  const description = document.getElementById('edit-desc').value.trim();
  const saveEl = document.getElementById('save-status');
  saveEl.textContent = isState ? 'Saving all counties…' : 'Saving…';
  saveEl.className = 'status-loading';

  try {
    let res, data;
    if(isState){
      const abbrev = selectedFips.slice(6);
      res = await fetch('/admin/update-state', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({password:token, state:abbrev, status, description})
      });
      data = await res.json();
      if(res.ok){
        // Update local counties
        Object.keys(counties).forEach(fips => {
          if(counties[fips].state === abbrev){
            counties[fips].status = status;
            counties[fips].description = description;
            if(countyPaths[fips]) d3.select(countyPaths[fips]).attr('fill', getFill(fips));
          }
        });
        saveEl.textContent = `✓ Updated ${data.updated} counties — live on public map`;
        saveEl.className = 'save-ok';
        buildLists();
        setTimeout(() => saveEl.textContent = '', 4000);
      } else {
        saveEl.textContent = data.detail || 'Error'; saveEl.className = 'save-err';
      }
    } else {
      res = await fetch('/admin/update-county', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({password:token, fips:selectedFips, status, description,
          overrides: {
            avg:         document.getElementById('ov-avg').value.trim(),
            max:         document.getElementById('ov-max').value.trim(),
            min:         document.getElementById('ov-min').value.trim(),
            latest_tat:  document.getElementById('ov-latest-tat').value.trim(),
            latest_date: document.getElementById('ov-latest-date').value.trim(),
          }})
      });
      data = await res.json();
      if(res.ok){
        counties[selectedFips].status = status;
        counties[selectedFips].description = description;
        saveEl.textContent = '✓ Saved — live on public map'; saveEl.className = 'save-ok';
        if(countyPaths[selectedFips])
          d3.select(countyPaths[selectedFips]).attr('fill', getFill(selectedFips));
        buildLists();
        setTimeout(() => saveEl.textContent = '', 3500);
      } else {
        saveEl.textContent = data.detail || 'Error'; saveEl.className = 'save-err';
      }
    }
  } catch(e){
    saveEl.textContent = 'Network error'; saveEl.className = 'save-err';
  }
}

// ── Lists ─────────────────────────────────────────────────────────────────
function buildLists(){
  const order = {significant:0,high_tat:1,delay:2};
  allFlagged = Object.entries(counties)
    .filter(([,c]) => c.status && c.status !== 'ok')
    .sort((a,b) => (order[a[1].status]||9)-(order[b[1].status]||9));
  allCountiesList = Object.entries(counties)
    .sort((a,b) => (a[1].state||'').localeCompare(b[1].state||'') || (a[1].name||'').localeCompare(b[1].name||''));
  document.getElementById('flagged-count').textContent = allFlagged.length;
  renderList();
}

function setMode(mode){
  listMode = mode;
  document.getElementById('tab-flagged').classList.toggle('active', mode==='flagged');
  document.getElementById('tab-all').classList.toggle('active', mode==='all');
  document.getElementById('tab-state').classList.toggle('active', mode==='state');
  document.getElementById('list-search').placeholder = mode==='state' ? 'Search states…' : 'Search counties…';
  document.getElementById('list-search').value = '';
  renderList();
}

function filterList(){ renderList(); }

function renderList(){
  if(listMode === 'state'){ renderStateList(); return; }
  const q = document.getElementById('list-search').value.toLowerCase();
  const src = listMode === 'flagged' ? allFlagged : allCountiesList;
  const filtered = q ? src.filter(([,c]) => c.name?.toLowerCase().includes(q) || c.state?.toLowerCase().includes(q)) : src;
  const meta = document.getElementById('list-meta');
  meta.textContent = listMode === 'flagged'
    ? `${filtered.length} flagged counties`
    : `${filtered.length.toLocaleString()} of ${allCountiesList.length.toLocaleString()} counties${q ? ' matched' : ''}`;
  document.getElementById('county-list').innerHTML = filtered.slice(0,200).map(([fips,c]) => {
    const b = STATUS_BADGE[c.status] || {};
    const badge = c.status && c.status !== 'ok'
      ? `<span class="flag-badge" style="background:${b.bg};color:${b.fg}">${b.label||c.status}</span>` : '';
    return `<div class="flag-row${fips===selectedFips?' selected':''}" data-fips="${fips}" onclick="selectCounty('${fips}')">
      <div><span class="flag-name">${c.name}, ${c.state}</span>${badge}</div>
      <div class="flag-desc">${c.description||''}</div>
    </div>`;
  }).join('');
  if(filtered.length > 200) document.getElementById('county-list').innerHTML +=
    `<div style="padding:8px;font-size:11px;color:#aaa;text-align:center">Showing first 200 — type to narrow down</div>`;
}

function renderStateList(){
  const q = document.getElementById('list-search').value.toLowerCase();
  // Build state summary
  const stateSummary = {};
  Object.values(counties).forEach(c => {
    const s = c.state;
    if(!s) return;
    if(!stateSummary[s]) stateSummary[s] = {total:0, flagged:0, worstStatus:'ok'};
    stateSummary[s].total++;
    if(c.status && c.status !== 'ok'){
      stateSummary[s].flagged++;
      const order = {significant:0,high_tat:1,delay:2,ok:3};
      if((order[c.status]||9) < (order[stateSummary[s].worstStatus]||9))
        stateSummary[s].worstStatus = c.status;
    }
  });
  const states = Object.entries(STATE_NAMES)
    .filter(([ab,name]) => !q || ab.toLowerCase().includes(q) || name.toLowerCase().includes(q))
    .sort((a,b) => a[1].localeCompare(b[1]));
  document.getElementById('list-meta').textContent = `${states.length} states`;
  document.getElementById('county-list').innerHTML = states.map(([ab,name]) => {
    const s = stateSummary[ab] || {total:0,flagged:0,worstStatus:'ok'};
    const b = STATUS_BADGE[s.worstStatus] || {};
    const badge = s.flagged > 0
      ? `<span class="flag-badge" style="background:${b.bg};color:${b.fg}">${s.flagged} flagged</span>` : '';
    return `<div class="flag-row${selectedFips==='state:'+ab?' selected':''}" data-fips="state:${ab}" onclick="selectState('${ab}')">
      <div><span class="flag-name">${name} (${ab})</span>${badge}</div>
      <div class="flag-desc">${s.total} counties total</div>
    </div>`;
  }).join('');
}

function selectState(abbrev){
  // Deselect old county
  if(selectedFips && countyPaths[selectedFips])
    d3.select(countyPaths[selectedFips]).classed('selected-county', false);
  selectedFips = 'state:' + abbrev;

  // Count counties
  const stateCounties = Object.entries(counties).filter(([,c]) => c.state === abbrev);
  const flagged = stateCounties.filter(([,c]) => c.status && c.status !== 'ok');

  document.getElementById('edit-title').textContent = `${STATE_NAMES[abbrev] || abbrev} — All Counties`;
  document.getElementById('edit-sub').textContent =
    `${stateCounties.length} counties · ${flagged.length} currently flagged · changes apply to ALL counties in this state`;
  document.getElementById('edit-status').value = flagged.length > 0 ? (flagged[0][1].status || 'delay') : 'ok';
  document.getElementById('edit-desc').value = flagged.length > 0 ? (flagged[0][1].description || '') : '';
  document.getElementById('save-status').textContent = '';
  document.getElementById('edit-panel').classList.add('open');
  document.getElementById('map-hint').style.display = 'none';

  document.querySelectorAll('.flag-row').forEach(r => r.classList.remove('selected'));
  document.querySelector(`.flag-row[data-fips="state:${abbrev}"]`)?.classList.add('selected');
}

// ── CSV Import ────────────────────────────────────────────────────────────
async function previewColumns(file){
  const box = document.getElementById('col-preview');
  box.style.display = 'block';
  box.innerHTML = '<span style="color:#888">Reading columns…</span>';
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/admin/preview-columns?password=${encodeURIComponent(token)}`, {method:'POST',body:form});
    const data = await res.json();
    if(!res.ok){ box.innerHTML = '<span style="color:#cf4027">Preview error: '+(data.detail||'unknown')+'</span>'; return; }
    const rows = data.rows || [];
    if(!rows.length){ box.innerHTML = '<span style="color:#cf4027">No rows found</span>'; return; }
    // First non-empty row = headers
    const headers = rows[0] || [];
    const sample = rows.slice(1,3);
    box.innerHTML = '<b style="color:#1a2b45">Columns detected (' + headers.length + '):</b><br>' +
      '<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">' +
      headers.map((h,i) => `<span style="background:#1a2b45;color:white;border-radius:4px;padding:2px 7px;font-size:10px">${h||'(col '+(i+1)+')'}</span>`).join('') +
      '</div>' +
      (sample[0] ? '<div style="margin-top:6px;color:#888">Sample: ' + (sample[0].slice(0,4).join(' | ')) + '…</div>' : '');
  } catch(e) { box.innerHTML = '<span style="color:#cf4027">Preview failed: '+e.message+'</span>'; }
}

function handleDrop(e){
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0] || e.dataTransfer.items?.[0]?.getAsFile());
}
function handleFile(file){
  if(!file){ return; }
  if(file.name.endsWith('.xls')){
    setImportStatus('Old .xls not supported — open in Excel and Save As .xlsx first.','err');
    return;
  }
  pendingFile = file;
  document.getElementById('drop-zone').classList.remove('drag-over');
  document.getElementById('drop-zone').classList.add('has-file');
  const banner = document.getElementById('file-ready-banner');
  document.getElementById('file-ready-name').textContent = file.name;
  const mb = (file.size/1024/1024).toFixed(1);
  document.getElementById('file-ready-size').textContent = mb + ' MB';
  banner.style.display = 'flex';
  document.getElementById('import-btn').style.display = 'block';
  setImportStatus('','');
  previewColumns(file);
}
async function doImport(){
  if(!pendingFile) return;
  setImportStatus('Uploading… this may take ~30s','loading');
  document.getElementById('import-btn').disabled = true;
  const form = new FormData();
  form.append('file', pendingFile);
  try {
    const res = await fetch(`/admin/upload?password=${encodeURIComponent(token)}`, {method:'POST',body:form});
    const data = await res.json();
    if(res.ok){
      setImportStatus('✓ ' + (data.message || 'Map updated!') + ' Reloading…','ok');
      setTimeout(()=>{
        loadAll();
        document.getElementById('import-btn').disabled=false;
        document.getElementById('import-btn').style.display='none';
        document.getElementById('file-ready-banner').style.display='none';
        document.getElementById('drop-zone').classList.remove('has-file');
        pendingFile=null;
      },1500);
    } else {
      setImportStatus('Error: '+(data.detail||'Upload failed'),'err');
      document.getElementById('import-btn').disabled=false;
    }
  } catch(e){
    setImportStatus('Network error','err');
    document.getElementById('import-btn').disabled=false;
  }
}
function setImportStatus(msg,type){
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.className = type==='ok'?'status-ok':type==='err'?'status-err':'status-loading';
}

// ── Word Doc import (court delays doc) ──────────────────────────────────
let pendingDocFile = null;
function handleDocDrop(e){
  e.preventDefault();
  document.getElementById('doc-drop-zone').classList.remove('drag-over');
  handleDocFile(e.dataTransfer.files[0]);
}
function handleDocFile(file){
  if(!file) return;
  if(!file.name.endsWith('.docx')){ document.getElementById('doc-status').textContent='Please upload a .docx file'; return; }
  pendingDocFile = file;
  document.getElementById('doc-ready-banner').style.display='block';
  document.getElementById('doc-ready-banner').textContent='✅ ' + file.name + ' (' + (file.size/1024).toFixed(0) + ' KB)';
  document.getElementById('doc-import-btn').style.display='block';
  document.getElementById('doc-status').textContent='';
}
async function doDocImport(){
  if(!pendingDocFile) return;
  document.getElementById('doc-status').textContent='Parsing document…';
  document.getElementById('doc-status').style.color='#856404';
  document.getElementById('doc-import-btn').disabled=true;
  const form = new FormData(); form.append('file', pendingDocFile);
  try {
    const res = await fetch(`/admin/upload-desc-doc?password=${encodeURIComponent(token)}`,{method:'POST',body:form});
    const data = await res.json();
    if(res.ok){
      document.getElementById('doc-status').textContent='✓ ' + data.message;
      document.getElementById('doc-status').style.color='#155724';
      pendingDocFile=null;
      document.getElementById('doc-import-btn').style.display='none';
      document.getElementById('doc-ready-banner').style.display='none';
      loadAll();
    } else {
      document.getElementById('doc-status').textContent='Error: '+(data.detail||'Failed');
      document.getElementById('doc-status').style.color='#cf4027';
    }
  } catch(e){
    document.getElementById('doc-status').textContent='Network error';
    document.getElementById('doc-status').style.color='#cf4027';
  }
  document.getElementById('doc-import-btn').disabled=false;
}

// ── Descriptions import ─────────────────────────────────────────────
let pendingDescFile = null;

function handleDescDrop(e){
  e.preventDefault();
  document.getElementById('desc-drop-zone').classList.remove('drag-over');
  handleDescFile(e.dataTransfer.files[0]);
}

async function handleDescFile(file){
  if(!file) return;
  pendingDescFile = file;
  document.getElementById('desc-drop-zone').classList.add('has-file');
  document.getElementById('desc-ready-banner').style.display='block';
  document.getElementById('desc-ready-banner').textContent = '✅ ' + file.name + ' (' + (file.size/1024).toFixed(0) + ' KB)';
  document.getElementById('desc-import-btn').style.display='block';
  document.getElementById('desc-status').textContent='';
  // Preview columns
  const box = document.getElementById('desc-col-preview');
  box.style.display='block'; box.textContent='Reading columns…';
  try {
    const form = new FormData(); form.append('file', file);
    const res = await fetch(`/admin/preview-columns?password=${encodeURIComponent(token)}`,{method:'POST',body:form});
    const data = await res.json();
    const headers = (data.rows||[])[0]||[];
    box.innerHTML = '<b style="color:#1a2b45">Columns:</b> ' + headers.map(h=>`<span style="background:#1a2b45;color:white;border-radius:3px;padding:1px 6px;font-size:10px;margin:1px">${h||'?'}</span>`).join(' ');
  } catch(e){ box.textContent='Preview failed'; }
}

async function doDescImport(){
  if(!pendingDescFile) return;
  document.getElementById('desc-status').textContent='Uploading…';
  document.getElementById('desc-import-btn').disabled=true;
  const form = new FormData(); form.append('file', pendingDescFile);
  try {
    const res = await fetch(`/admin/upload-descriptions?password=${encodeURIComponent(token)}`,{method:'POST',body:form});
    const data = await res.json();
    if(res.ok){
      document.getElementById('desc-status').textContent='✓ ' + data.message;
      document.getElementById('desc-status').style.color='#155724';
      pendingDescFile=null;
      document.getElementById('desc-import-btn').style.display='none';
      document.getElementById('desc-ready-banner').style.display='none';
      document.getElementById('desc-drop-zone').classList.remove('has-file');
      loadData(); // reload county data
    } else {
      document.getElementById('desc-status').textContent='Error: '+(data.detail||'Upload failed');
      document.getElementById('desc-status').style.color='#cf4027';
    }
  } catch(e){
    document.getElementById('desc-status').textContent='Network error';
    document.getElementById('desc-status').style.color='#cf4027';
  }
  document.getElementById('desc-import-btn').disabled=false;
}

// ── Embed panel ────────────────────────────────────────────────
let embedOpen = false;
function toggleEmbedPanel(){
  embedOpen = !embedOpen;
  document.getElementById('embed-panel').style.display = embedOpen ? 'block' : 'none';
  document.getElementById('body').style.display = embedOpen ? 'none' : 'grid';
  document.getElementById('embed-nav-btn').style.background = embedOpen ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.12)';
  if(embedOpen) updateIframe();
}
function updateIframe(){
  const h = document.getElementById('iframe-height').value;
  const base = 'https://victig-map-production.up.railway.app';
  document.getElementById('iframe-code').value =
    `<iframe src="${base}/embed" width="100%" height="${h}" frameborder="0" style="border-radius:8px;border:1px solid #ddd"></iframe>`;
  document.getElementById('banner-code').value =
    `<a href="${base}/" target="_blank" style="display:inline-block;padding:10px 20px;background:#1a2b45;color:white;text-decoration:none;border-radius:6px;font-family:sans-serif;font-size:14px;font-weight:600">🗺️ View Court Search TAT Map</a>`;
}
function copyEl(id){
  const el = document.getElementById(id);
  const text = el.tagName === 'TEXTAREA' ? el.value : el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const c = document.getElementById('copy-confirm');
    if(c){ c.textContent = '✓ Copied!'; setTimeout(()=>c.textContent='',2000); }
  });
}

// ── Page-wide drag & drop ────────────────────────────────────────────────
let dragCounter = 0;

function getFileType(file){
  if(!file) return 'data';
  const n = file.name.toLowerCase();
  if(n.endsWith('.docx')) return 'doc';
  return 'data';
}

function updateOverlayForFile(file){
  const type = file ? getFileType(file) : 'data';
  const icon = document.getElementById('overlay-icon');
  const title = document.getElementById('overlay-title');
  const sub   = document.getElementById('overlay-sub');
  if(type === 'doc'){
    icon.textContent  = '\ud83d\udcc4';
    title.textContent = 'Drop Court Delays Doc';
    sub.textContent   = '.docx → update county descriptions';
  } else {
    icon.textContent  = '\ud83d\udcc2';
    title.textContent = 'Drop to Import Data';
    sub.textContent   = 'CSV / Excel / TSV → update map TAT data';
  }
}

document.addEventListener('dragenter', e => {
  // Only activate when admin UI is visible
  if(document.getElementById('admin-ui').style.display === 'none') return;
  dragCounter++;
  const file = e.dataTransfer?.items?.[0];
  updateOverlayForFile(file ? {name: file.type || ''} : null);
  document.getElementById('page-drag-overlay').classList.add('active');
});

document.addEventListener('dragleave', e => {
  dragCounter--;
  if(dragCounter <= 0){
    dragCounter = 0;
    document.getElementById('page-drag-overlay').classList.remove('active');
  }
});

document.addEventListener('dragover', e => { e.preventDefault(); });

document.addEventListener('drop', e => {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('page-drag-overlay').classList.remove('active');
  // Only handle when admin UI is visible
  if(document.getElementById('admin-ui').style.display === 'none') return;
  const file = e.dataTransfer?.files?.[0];
  if(!file) return;
  const type = getFileType(file);
  if(type === 'doc'){
    handleDocFile(file);
    // Scroll drop zone into view
    document.getElementById('doc-drop-zone').scrollIntoView({behavior:'smooth',block:'nearest'});
  } else {
    handleFile(file);
    document.getElementById('drop-zone').scrollIntoView({behavior:'smooth',block:'nearest'});
  }
});

// ── Auto-login ────────────────────────────────────────────────────────────
if(token){
  (async()=>{
    if((await sha256(token)) === PW_HASH){
      document.getElementById('login-screen').style.display='none';
      document.getElementById('admin-ui').style.display='flex';
      loadAll();
    } else { sessionStorage.removeItem('victig_admin_token'); token=''; }
  })();
}
