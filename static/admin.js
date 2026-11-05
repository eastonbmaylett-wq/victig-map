
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
function initPreviewIframe(){
  // Only load once the panel is actually visible — D3 needs real dimensions
  const iframe = document.getElementById('preview-iframe');
  if(iframe && !iframe.src.includes('edit_token')){
    // Small delay ensures the panel is fully visible before the map renders
    setTimeout(() => {
      iframe.src = `/#edit_token=${encodeURIComponent(token)}`;
    }, 50);
  }
}

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

  // Restore last active tab AFTER data + map are ready
  const savedTab = sessionStorage.getItem('victig_admin_tab');
  if(savedTab && savedTab !== 'map') switchTab(savedTab);
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
        loadAll().then(() => setImportStatus('✓ ' + (data.message || 'Map updated!'), 'ok'))
          .catch(() => setImportStatus('✓ Saved. Reload this page to refresh the admin view.', 'ok'));
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

// ── Tab switching ────────────────────────────────────────────────
let activeTab = 'map';
function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  // Hide all panels — use visibility trick for preview so iframe stays loaded
  document.querySelectorAll('.tab-panel').forEach(p => {
    if(p.id === 'tab-preview'){
      p.style.visibility = 'hidden';
      p.style.position = 'absolute';
      p.style.pointerEvents = 'none';
      p.style.display = 'flex';
    } else {
      p.style.display = 'none';
      p.style.visibility = '';
      p.style.position = '';
      p.style.pointerEvents = '';
    }
  });
  // Show selected
  const panel = document.getElementById('tab-' + tab);
  panel.style.display = 'flex';
  panel.style.visibility = 'visible';
  panel.style.position = '';
  panel.style.pointerEvents = '';
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  activeTab = tab;
  sessionStorage.setItem('victig_admin_tab', tab);
  if(tab === 'analytics') loadAnalyticsPanel();
  if(tab === 'embed') updateIframe();
  if(tab === 'preview') initPreviewIframe();
  if(tab === 'medals') initMedalsTab();
}

// Legacy stubs (keep in case anything references them)
function toggleEmbedPanel(){ switchTab('embed'); }
function toggleAnalyticsPanel(){ switchTab('analytics'); }

let _analyticsData = null;
let _analyticsMyIp = '';
let _analyticsRange = 'today';
let _analyticsExcludeSlc = true;

async function loadAnalyticsPanel(forceRefresh = true){
  const panel = document.getElementById('tab-analytics');

  // Fetch my IP once
  if(!_analyticsMyIp){
    try { const r = await fetch('/api/my-ip'); const d = await r.json(); _analyticsMyIp = d.ip || ''; } catch(e){}
  }

  if(forceRefresh || !_analyticsData){
    panel.innerHTML = '<div style="padding:40px;text-align:center;color:#888">Loading analytics...</div>';
    let url = `/api/analytics/summary?password=${encodeURIComponent(token)}&range=${_analyticsRange}&exclude_slc=${_analyticsExcludeSlc}`;
    if(_analyticsMyIp) url += `&exclude_ip=${encodeURIComponent(_analyticsMyIp)}`;
    try {
      const res = await fetch(url);
      if(!res.ok){ panel.innerHTML = '<div style="padding:40px;color:#c0392b">Failed to load analytics.</div>'; return; }
      _analyticsData = await res.json();
    } catch(e){ panel.innerHTML = '<div style="padding:40px;color:#c0392b">Error loading analytics.</div>'; return; }
  }

  panel.innerHTML = renderAnalyticsHTML(_analyticsData, _analyticsMyIp);
  renderAnalyticsChart(_analyticsData.by_day);
  // Highlight active range button
  document.querySelectorAll('.a-range-btn').forEach(b => {
    b.style.background = b.dataset.range === _analyticsRange ? '#1a4a8a' : 'transparent';
    b.style.color = b.dataset.range === _analyticsRange ? '#fff' : '#555';
    b.style.fontWeight = b.dataset.range === _analyticsRange ? '600' : '500';
  });
}

function setAnalyticsRange(r){
  _analyticsRange = r;
  _analyticsData = null;
  loadAnalyticsPanel();
}

function toggleExcludeSlc(){
  _analyticsExcludeSlc = !_analyticsExcludeSlc;
  _analyticsData = null;
  loadAnalyticsPanel();
}

function buildCountyRows(rows){
  return rows.map((r,i)=>`<tr><td style="color:#888">${i+1}</td><td>${r.county||'—'}</td><td>${r.state||'—'}</td><td><b>${r.clicks}</b></td></tr>`).join('')
    || '<tr><td colspan="4" style="color:#aaa;padding:16px">No county clicks yet</td></tr>';
}

async function adminBackfillGeo(){
  const btn = document.getElementById('admin-enrich-btn');
  const status = document.getElementById('admin-enrich-status');
  if(btn){ btn.disabled=true; btn.textContent='Running...'; }
  if(status) status.textContent = 'This may take a minute...';
  try {
    const r = await fetch(`/api/analytics/backfill-geo?password=${encodeURIComponent(token)}`, {method:'POST'});
    const d = await r.json();
    if(status) status.textContent = d.enriched > 0 ? `✓ Enriched ${d.enriched} rows` : 'All rows already enriched';
    if(d.enriched > 0){ _analyticsData=null; loadAnalyticsPanel(); }
  } catch(e){
    if(status) status.textContent = 'Error';
  }
  if(btn){ btn.disabled=false; btn.textContent='📍 Enrich Locations'; }
}

function renderAdminCounties(){
  if(!_analyticsData) return;
  const includeMe = document.getElementById('admin-include-me-counties')?.checked;
  const rows = includeMe ? (_analyticsData.top_counties||[]) : (_analyticsData.top_counties_excl||[]);
  const tbody = document.getElementById('admin-county-tbody');
  if(tbody) tbody.innerHTML = buildCountyRows(rows);
}

function refreshAdminRecent(){
  // Re-render only the recent tbody without a full reload
  const hideMe = document.getElementById('admin-hide-me')?.checked;
  if(!_analyticsData) return;
  const myIp = _analyticsMyIp;
  const rows = hideMe && myIp
    ? (_analyticsData.recent||[]).filter(r => r.ip !== myIp)
    : (_analyticsData.recent||[]);
  const tbody = document.getElementById('admin-recent-tbody');
  if(!tbody) return;
  tbody.innerHTML = rows.map(r => {
    const isMe = myIp && r.ip === myIp;
    const t = (r.ts||'').replace('T',' ').slice(0,19)||'—';
    const badge = r.event==='visit' ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;background:#e8f0fe;color:#1a4a8a">Visit</span>'
      : r.event==='embed' ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;background:#f3e8ff;color:#6b21a8">Embed</span>'
      : '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;background:#e6f4ea;color:#1e7e34">Click</span>';
    const location = (r.event==='visit'||r.event==='embed') ? (r.state || '—') : '—';
    const county = r.event==='click' ? (r.county ? `${r.county}${r.state ? ', '+r.state : ''}` : '—') : '—';
    return `<tr style="${isMe?'background:#fffbeb;':''}"><td style="white-space:nowrap;color:#555;font-size:11px">${t}${isMe?' <span style="font-size:10px;color:#b45309">your IP</span>':''}</td><td>${badge}</td><td style="font-family:monospace;font-size:11px">${r.ip||'—'}</td><td style="font-size:12px">${location}</td><td style="font-size:12px">${county}</td></tr>`;
  }).join('') || '<tr><td colspan="5" style="color:#aaa;padding:16px">No activity yet</td></tr>';
}

function renderAnalyticsHTML(d, myIp){
  const statsCards = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px">
      <div style="background:#fff;border-radius:10px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,.07)">
        <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Total Visits</div>
        <div style="font-size:32px;font-weight:700;color:#1a4a8a">${d.total_visits.toLocaleString()}</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,.07)">
        <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Unique Visitors</div>
        <div style="font-size:32px;font-weight:700;color:#1a4a8a">${d.unique_ips.toLocaleString()}</div>
      </div>
      <div style="background:#fff;border-radius:10px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,.07)">
        <div style="font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Visits Today</div>
        <div style="font-size:32px;font-weight:700;color:#1a4a8a">${d.today_visits.toLocaleString()}</div>
      </div>
    </div>`;

  const visitorRows = (d.visitors||[]).map(v => {
    const first = (v.first_seen||'').replace('T',' ').slice(0,16)||'—';
    const last  = (v.last_seen ||'').replace('T',' ').slice(0,16)||'—';
    const counties = v.counties ? v.counties.split(',').filter(Boolean).slice(0,3).join(', ')+(v.counties.split(',').length>3?` +${v.counties.split(',').length-3}`:'') : '—';
    return `<tr><td style="font-size:11px;color:#555;white-space:nowrap">${first}</td><td style="font-size:11px;color:#555;white-space:nowrap">${last}</td><td style="font-family:monospace;font-size:11px">${v.ip}</td><td>${v.location||'<span style="color:#ccc">Unknown</span>'}</td><td style="font-weight:600;color:#1a4a8a">${v.visits}</td><td style="font-size:11px;color:#555">${counties}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="color:#aaa;padding:16px">No outside visitors yet</td></tr>';

  const countyRows = buildCountyRows(d.top_counties||[]);

  const recentRows = (d.recent||[]).map(r=>{
    const isMe = myIp && r.ip===myIp;
    const t = (r.ts||'').replace('T',' ').slice(0,19)||'—';
    const badge = r.event==='visit' ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;background:#e8f0fe;color:#1a4a8a">Visit</span>'
      : r.event==='embed' ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;background:#f3e8ff;color:#6b21a8">Embed</span>'
      : '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;background:#e6f4ea;color:#1e7e34">Click</span>';
    const location = (r.event==='visit'||r.event==='embed') ? (r.state || '—') : '—';
    const county = r.event==='click' ? (r.county ? `${r.county}${r.state ? ', '+r.state : ''}` : '—') : '—';
    return `<tr style="${isMe?'background:#fffbeb;':''}"><td style="white-space:nowrap;color:#555;font-size:11px">${t}${isMe?' <span style="font-size:10px;color:#b45309">your IP</span>':''}</td><td>${badge}</td><td style="font-family:monospace;font-size:11px">${r.ip||'—'}</td><td style="font-size:12px">${location}</td><td style="font-size:12px">${county}</td></tr>`;
  }).join('') || '<tr><td colspan="5" style="color:#aaa;padding:16px">No activity yet</td></tr>';

  const rangeLabel = {today:'Today',week:'Last 7 Days',month:'Last 30 Days',all:'All Time'}[d.range||'all'];
  const rangeBtns = ['today','week','month','all'].map(r => {
    const label = {today:'Today',week:'Last 7 Days',month:'Last 30 Days',all:'All Time'}[r];
    const active = r === _analyticsRange;
    return `<button class="a-range-btn" data-range="${r}" onclick="setAnalyticsRange('${r}')" style="background:${active?'#1a4a8a':'transparent'};color:${active?'#fff':'#555'};border:none;border-radius:6px;padding:5px 13px;font-size:12px;font-weight:${active?'600':'500'};cursor:pointer">${label}</button>`;
  }).join('');

  return `
    <div style="padding:24px 28px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        <h2 style="font-size:18px;font-weight:700;color:#1a2b45">📊 Analytics <span style="font-size:12px;font-weight:400;color:#aaa;margin-left:8px">(excluding you)</span></h2>
        <div style="display:flex;gap:4px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:3px;margin-left:8px">${rangeBtns}</div>
        <button onclick="toggleExcludeSlc()" style="background:${_analyticsExcludeSlc?'#e8f0fe':'#f0f2f5'};color:${_analyticsExcludeSlc?'#1a4a8a':'#888'};border:1px solid ${_analyticsExcludeSlc?'#c5d8f8':'#ddd'};border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer">${_analyticsExcludeSlc?'✅ Non-SLC Visitors':'All Visitors'}</button>
        <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
          <button onclick="_analyticsData=null;loadAnalyticsPanel()" style="background:#1a4a8a;color:#fff;border:none;border-radius:8px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer">↻ Refresh</button>
          <button id="admin-enrich-btn" onclick="adminBackfillGeo()" style="background:#f0f2f5;color:#333;border:1px solid #ddd;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer">📍 Enrich Locations</button>
          <span id="admin-enrich-status" style="font-size:12px;color:#888"></span>
        </div>
      </div>
      ${statsCards.replace('Total Visits', `Visits — ${rangeLabel}`).replace('Unique Visitors', `Unique — ${rangeLabel}`)}
      <div style="background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:20px;overflow:hidden">
        <div style="padding:14px 20px;border-bottom:1px solid #eee;font-weight:600;font-size:14px">👥 Visitors <span style="font-size:11px;color:#aaa;font-weight:400;margin-left:6px">${(d.visitors||[]).length} unique</span></div>
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="background:#fafafa">${['First Seen','Last Seen','IP','Location','Visits','Counties'].map(h=>`<th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #eee">${h}</th>`).join('')}</tr></thead>
          <tbody>${visitorRows}</tbody>
        </table></div>
      </div>
      <div style="background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:20px;overflow:hidden">
        <div style="padding:14px 20px;border-bottom:1px solid #eee;font-weight:600;font-size:14px">📅 Visits by Day <span style="font-size:11px;color:#aaa;font-weight:400;margin-left:auto;float:right">last 30 days</span></div>
        <div style="padding:16px 20px 12px;overflow-x:auto"><svg id="admin-day-chart" style="display:block;min-width:400px"></svg></div>
      </div>
      <div style="background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:20px;overflow:hidden">
        <div style="padding:14px 20px;border-bottom:1px solid #eee;font-weight:600;font-size:14px">🗺️ Most Clicked Counties
          <label style="margin-left:auto;float:right;font-size:12px;font-weight:400;color:#555;display:inline-flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="admin-include-me-counties" checked onchange="renderAdminCounties()" style="cursor:pointer"> Include my clicks
          </label>
        </div>
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="background:#fafafa">${['#','County','State','Clicks'].map(h=>`<th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #eee">${h}</th>`).join('')}</tr></thead>
          <tbody id="admin-county-tbody">${countyRows}</tbody>
        </table></div>
      </div>
      <div style="background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:20px;overflow:hidden">
        <div style="padding:14px 20px;border-bottom:1px solid #eee;font-weight:600;font-size:14px">🕐 Recent Activity
          <label style="margin-left:auto;float:right;font-size:12px;font-weight:400;color:#555;display:inline-flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="admin-hide-me" onchange="refreshAdminRecent()" style="cursor:pointer"> Hide my visits
          </label>
        </div>
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="background:#fafafa">${['Time','Event','IP','Location','County'].map(h=>`<th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #eee">${h}</th>`).join('')}</tr></thead>
          <tbody id="admin-recent-tbody">${recentRows}</tbody>
        </table></div>
      </div>
    </div>`;
}

function renderAnalyticsChart(byDay){
  const svg = document.getElementById('admin-day-chart');
  if(!svg || !byDay || !byDay.length) return;
  const days = [...byDay].reverse();
  const PAD={top:16,right:16,bottom:48,left:36}, BAR_W=28, GAP=6;
  const totalW = days.length*(BAR_W+GAP)+PAD.left+PAD.right;
  const H=180, chartH=H-PAD.top-PAD.bottom;
  const maxV=Math.max(...days.map(r=>r.visits),1);
  svg.setAttribute('viewBox',`0 0 ${totalW} ${H}`);
  svg.setAttribute('height',H);
  svg.style.minWidth=`${totalW}px`;
  let bars='';
  days.forEach((r,i)=>{
    const x=PAD.left+i*(BAR_W+GAP);
    const barH=Math.max(2,Math.round(r.visits/maxV*chartH));
    const y=PAD.top+chartH-barH;
    const label=r.day.slice(5);
    bars+=`<rect x="${x}" y="${y}" width="${BAR_W}" height="${barH}" rx="3" fill="#1a4a8a" opacity="0.85"><title>${r.day}: ${r.visits} visit${r.visits!==1?'s':''}</title></rect>`;
    bars+=`<text x="${x+BAR_W/2}" y="${y-4}" text-anchor="middle" font-size="9.5" fill="#1a4a8a" font-weight="600">${r.visits>0?r.visits:''}</text>`;
    bars+=`<text x="${x+BAR_W/2}" y="${H-6}" text-anchor="middle" font-size="9" fill="#888" transform="rotate(-45 ${x+BAR_W/2} ${H-6})">${label}</text>`;
  });
  bars+=`<line x1="${PAD.left-4}" y1="${PAD.top}" x2="${PAD.left-4}" y2="${PAD.top+chartH}" stroke="#e0e0e0" stroke-width="1"/>`;
  bars+=`<text x="${PAD.left-8}" y="${PAD.top+4}" text-anchor="end" font-size="9" fill="#aaa">${maxV}</text>`;
  bars+=`<line x1="${PAD.left-4}" y1="${PAD.top+chartH}" x2="${totalW-PAD.right}" y2="${PAD.top+chartH}" stroke="#e0e0e0" stroke-width="1"/>`;
  svg.innerHTML=bars;
}
function updateIframe(){
  const h = document.getElementById('iframe-height').value;
  const base = window.VICTIG_PUBLIC_MAP_ORIGIN || window.location.origin;
  document.getElementById('link-url').textContent = `${base}/`;
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
  // Switch to Import tab so user can see the result
  switchTab('import');
  if(type === 'doc'){
    handleDocFile(file);
    setTimeout(()=>document.getElementById('doc-drop-zone')?.scrollIntoView({behavior:'smooth',block:'nearest'}), 100);
  } else {
    handleFile(file);
    setTimeout(()=>document.getElementById('drop-zone')?.scrollIntoView({behavior:'smooth',block:'nearest'}), 100);
  }
});

// ── Rankings Override Tab ───────────────────────────────────────────────
const MEDAL_EMOJI  = ['🥇','🥈','🥉'];
const SLOW_EMOJI   = ['🔴','🟠','🟡'];
let _fastestOverrides = Array(10).fill(null).map(() => []);
let _slowestOverrides = Array(10).fill(null).map(() => []);
let _medalInited = false;

// Slot state: array of fips per slot, keyed by "which-i"
// e.g. { 'fastest-0': ['49035','49049'], 'slowest-2': [] }
const _slotFips = {};

// ── County dropdown ────────────────────────────────────────────────────
let _ddWhich = null, _ddIdx = null, _ddFocusIdx = -1;
let _ddCountyList = null; // sorted [{fips, label, avg}]
let _ddOpen = false;

function _buildCountyList() {
  if (_ddCountyList) return;
  _ddCountyList = Object.entries(counties)
    .map(([fips, c]) => ({ fips, label: `${c.name}, ${c.state}`, avg: _countyAvg(c), state: c.state }))
    .filter(x => x.avg !== null && counties[x.fips]?.name)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function _ddFilter(query) {
  const q = query.trim().toLowerCase();
  if (!q) return _ddCountyList.slice(0, 80);
  return _ddCountyList.filter(x =>
    x.label.toLowerCase().includes(q) ||
    x.state.toLowerCase() === q
  ).slice(0, 80);
}

function _ddRenderList(items) {
  const listEl = document.getElementById('cd-list');
  if (!items.length) {
    listEl.innerHTML = '<div class="cd-empty">No counties found</div>';
    return;
  }
  listEl.innerHTML = items.map((x, i) => {
    const tatStr = _avgToReadable(x.avg);
    return `<div class="cd-item" data-fips="${x.fips}" data-idx="${i}"
      onmousedown="_ddSelect('${x.fips}','${x.label.replace(/'/g,"&apos;")}')">
      <span class="cd-name">${x.label}</span>
      <span class="cd-tat">${tatStr}</span>
    </div>`;
  }).join('');
}

function _openDropdown(which, i, anchorEl) {
  _buildCountyList();
  _ddWhich = which;
  _ddIdx = i;
  _ddFocusIdx = -1;

  // Use passed anchor element, or fall back to the pill container
  const anchor = (anchorEl instanceof Element ? anchorEl : null)
    || document.getElementById(`slot-pills-${which}-${i}`);
  const dd = document.getElementById('county-dropdown');
  const rect = anchor ? anchor.getBoundingClientRect() : {bottom: 100, left: 100, width: 240};

  // Position below trigger
  const spaceBelow = window.innerHeight - rect.bottom;
  const height = Math.min(220, spaceBelow > 180 ? spaceBelow - 12 : 180);
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.left = rect.left + 'px';
  dd.style.width = Math.max(rect.width, 240) + 'px';
  dd.style.maxHeight = height + 'px';

  // Prefill search with current selection
  const searchInp = document.getElementById('cd-search-input');
  searchInp.value = '';
  _ddRenderList(_ddFilter(''));
  dd.classList.add('open');
  _ddOpen = true;
  setTimeout(() => searchInp.focus(), 10);
}

function _closeDropdown() {
  document.getElementById('county-dropdown').classList.remove('open');
  _ddOpen = false;
  _ddWhich = null;
  _ddIdx = null;
}

function _ddSelect(fips, label) {
  if (_ddWhich === null) return;
  const key = `${_ddWhich}-${_ddIdx}`;
  if (!_slotFips[key]) _slotFips[key] = [];
  // Avoid duplicates in same slot
  if (!_slotFips[key].includes(fips)) {
    _slotFips[key].push(fips);
  }
  _closeDropdown();
  _renderRankingTables(); // re-render entire table so effective autos update
}

function _renderSlotPills(which, i) {
  const key = `${which}-${i}`;
  const arr = _slotFips[key] || [];
  const container = document.getElementById(`slot-pills-${which}-${i}`);
  const row = document.getElementById(`mrow-${which}-${i}`);
  if (!container) return;
  const pillsHTML = arr.map(f => {
    const lbl = _fipsToLabel(f);
    return `<span class="slot-pill" title="${lbl}">
      <span>${lbl}</span>
      <span class="slot-pill-x" onclick="_removePill('${which}',${i},'${f}')">✕</span>
    </span>`;
  }).join('');
  container.innerHTML = pillsHTML +
    `<button class="slot-add-btn" onclick="_openDropdown('${which}',${i},this)">+ Add</button>`;
  if (row) row.classList.toggle('mrow-overridden', arr.length > 0);
}

function _removePill(which, i, fips) {
  const key = `${which}-${i}`;
  _slotFips[key] = (_slotFips[key] || []).filter(f => f !== fips);
  _renderRankingTables();
}

// Keyboard nav in dropdown
document.addEventListener('keydown', e => {
  if (!_ddOpen) return;
  const items = document.querySelectorAll('#cd-list .cd-item');
  if (e.key === 'Escape') { _closeDropdown(); }
  else if (e.key === 'ArrowDown') {
    e.preventDefault();
    _ddFocusIdx = Math.min(_ddFocusIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('focused', i === _ddFocusIdx));
    items[_ddFocusIdx]?.scrollIntoView({block:'nearest'});
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _ddFocusIdx = Math.max(_ddFocusIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle('focused', i === _ddFocusIdx));
    items[_ddFocusIdx]?.scrollIntoView({block:'nearest'});
  } else if (e.key === 'Enter' && _ddFocusIdx >= 0) {
    e.preventDefault();
    const el = items[_ddFocusIdx];
    if (el) _ddSelect(el.dataset.fips, el.querySelector('.cd-name').textContent);
  }
});

// Close on outside click
document.addEventListener('mousedown', e => {
  if (!_ddOpen) return;
  const dd = document.getElementById('county-dropdown');
  if (!dd.contains(e.target) && !e.target.closest('[id^="cd-trigger-"]')) {
    _closeDropdown();
  }
});

// Filter as you type in the dropdown search
document.addEventListener('DOMContentLoaded', () => {
  const si = document.getElementById('cd-search-input');
  if (si) si.addEventListener('input', () => {
    _ddFocusIdx = -1;
    _ddRenderList(_ddFilter(si.value));
  });
});

// ── Tab logic ─────────────────────────────────────────────────────
function _fipsToLabel(fips) {
  if (!fips || !counties[fips]) return '';
  const c = counties[fips];
  return `${c.name}, ${c.state}`;
}

function _countyAvg(c) {
  // Mirror map.js getStats: prefer 90d, then 180d, 60d, 30d
  const p = c.periods;
  if (!p) return null;
  const s = p['90d'] || p['180d'] || p['60d'] || p['30d'];
  return (s && s.count >= 1) ? s.avg : null;
}

function _avgToReadable(avg) {
  if (avg == null) return '—';
  if (avg === 0) return 'Same day';
  const totalSec = Math.round(avg * 86400);
  const s   = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m   = totalMin % 60;
  const h   = Math.floor(totalMin / 60);
  if (h === 0 && m === 0) return `${s}s avg`;
  if (h === 0) return s > 0 ? `${m}m ${s}s avg` : `${m}m avg`;
  if (h < 24)  return m > 0 ? `${h}h ${m}m avg` : `${h}h avg`;
  const d  = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h avg` : `${d}d avg`;
}

function _getAutoRanked(which) {
  return Object.entries(counties)
    .map(([fips, c]) => ({ fips, c, avg: _countyAvg(c) }))
    .filter(x => x.avg !== null && x.c.status !== 'closed')
    .sort((a, b) => which === 'fastest' ? a.avg - b.avg : b.avg - a.avg)
    .slice(0, 10);
}

// Returns array of 10 entries: the effective auto county for each slot,
// accounting for all current _slotFips overrides above each position.
// Returns null for slots that have a manual override (auto doesn't apply).
function _getEffectiveAutos(which) {
  const fullList = Object.entries(counties)
    .map(([fips, c]) => ({ fips, c, avg: _countyAvg(c) }))
    .filter(x => x.avg !== null && x.c.status !== 'closed')
    .sort((a, b) => which === 'fastest' ? a.avg - b.avg : b.avg - a.avg);

  const usedFips = new Set();
  const result = [];

  for (let i = 0; i < 10; i++) {
    const slot = _slotFips[`${which}-${i}`] || [];
    const validSlot = slot.filter(f => fullList.find(e => e.fips === f) && !usedFips.has(f));

    if (validSlot.length > 0) {
      // Pinned: mark all as used, effective auto = null (slot is manual)
      for (const f of validSlot) usedFips.add(f);
      result.push(null);
    } else {
      // Auto: pick next unused county
      const next = fullList.find(e => !usedFips.has(e.fips));
      if (next) usedFips.add(next.fips);
      result.push(next || null);
    }
  }

  return result;
}

async function initMedalsTab() {
  if (_medalInited && Object.keys(counties).length > 0) { _renderRankingTables(); return; }
  document.getElementById('medals-loading').style.display = 'block';
  document.getElementById('medals-form').style.display = 'none';

  try {
    const cfg = await fetch('/site-config.json').then(r => r.json());
    const fo = cfg.fastest_overrides;
    const so = cfg.slowest_overrides;
    if (Array.isArray(fo) && fo.length === 10) _fastestOverrides = fo;
    else if (Array.isArray(cfg.medal_overrides))
      _fastestOverrides = cfg.medal_overrides.map(f => f ? [f] : []).concat(Array(7).fill(null).map(()=>[]));
    if (Array.isArray(so) && so.length === 10) _slowestOverrides = so;
  } catch(e) {}

  // Seed slot state: normalise each slot to an array
  function _toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter(Boolean);
    return [v]; // backward compat: single string
  }
  for (let i = 0; i < 10; i++) {
    _slotFips[`fastest-${i}`] = _toArr(_fastestOverrides[i]);
    _slotFips[`slowest-${i}`] = _toArr(_slowestOverrides[i]);
  }

  _medalInited = true;
  document.getElementById('medals-loading').style.display = 'none';
  document.getElementById('medals-form').style.display = 'block';
  _renderRankingTables();
}

function _rankRow(which, i, autoEntry) {
  const posLabel = i < 3 ? (which === 'fastest' ? MEDAL_EMOJI[i] : SLOW_EMOJI[i]) : `#${i+1}`;
  const arr = _slotFips[`${which}-${i}`] || [];
  const hasOverride = arr.length > 0;
  let autoCell;
  if (hasOverride) {
    autoCell = '<span style="color:#bbb;font-style:italic;font-size:11px">manual</span>';
  } else if (autoEntry) {
    const autoLabel = `${autoEntry.c.name}, ${autoEntry.c.state} · ${_avgToReadable(autoEntry.avg)}`;
    autoCell = `<span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${autoLabel}">${autoLabel}</span>`;
  } else {
    autoCell = '<span style="color:#bbb">—</span>';
  }
  return `<tr id="mrow-${which}-${i}"${hasOverride ? ' class="mrow-overridden"' : ''}>
    <td style="padding:6px 8px;font-size:13px;font-weight:700;color:#1a2b45;white-space:nowrap;width:36px">${posLabel}</td>
    <td style="padding:6px 8px;font-size:12px;color:#555;max-width:130px">
      ${autoCell}
    </td>
    <td style="padding:6px 6px;min-width:180px">
      <div id="slot-pills-${which}-${i}" class="slot-pills">
        ${arr.map(f => {
          const lbl = _fipsToLabel(f);
          return `<span class="slot-pill" title="${lbl}"><span>${lbl}</span><span class="slot-pill-x" onclick="_removePill('${which}',${i},'${f}')">\u2715</span></span>`;
        }).join('')}
        <button class="slot-add-btn" onclick="_openDropdown('${which}',${i},this)">+ Add</button>
      </div>
    </td>
    <td style="padding:4px 6px;width:32px">
      <button onclick="_clearRankSlot('${which}',${i})" title="Clear all"
        style="padding:4px 8px;background:#f3f4f6;border:1px solid #ddd;border-radius:5px;cursor:pointer;font-size:12px">✕</button>
    </td>
  </tr>`;
}

function _renderRankingTables() {
  const effectiveFastest = _getEffectiveAutos('fastest');
  const effectiveSlowest = _getEffectiveAutos('slowest');
  const slotsEl = document.getElementById('medal-slots');

  slotsEl.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div>
        <div style="font-size:13px;font-weight:700;color:#1a2b45;margin-bottom:10px">🥇 Fastest 10</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="border-bottom:2px solid #e8eaed">
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#888">#</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#888">Auto</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#888">Override</th>
            <th></th>
          </tr></thead>
          <tbody>${effectiveFastest.map((e,i) => _rankRow('fastest',i,e)).join('')}</tbody>
        </table>
      </div>
      <div>
        <div style="font-size:13px;font-weight:700;color:#1a2b45;margin-bottom:10px">🐢 Slowest 10</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="padding:4px 8px;text-align:left;font-size:11px;color:#888"><th style="padding:4px 8px;text-align:left;font-size:11px;color:#888">#</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#888">Auto</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#888">Override</th>
            <th></th>
          </tr></thead>
          <tbody>${effectiveSlowest.map((e,i) => _rankRow('slowest',i,e)).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

function _clearRankSlot(which, i) {
  const key = `${which}-${i}`;
  _slotFips[key] = [];
  _renderRankingTables();
}

async function saveMedalOverrides() {
  const fastestOv = Array.from({length:10}, (_,i) => _slotFips[`fastest-${i}`] || []);
  const slowestOv = Array.from({length:10}, (_,i) => _slotFips[`slowest-${i}`] || []);
  const statusEl = document.getElementById('medal-save-status');
  statusEl.textContent = 'Saving…';
  statusEl.style.color = '#555';

  let cfg = {};
  try { cfg = await fetch('/site-config.json').then(r => r.json()); } catch(e) {}
  cfg.fastest_overrides = fastestOv;
  cfg.slowest_overrides = slowestOv;
  cfg.medal_overrides = fastestOv.slice(0, 3).map(a => (a && a[0]) || null); // backward compat

  try {
    const res = await fetch('/admin/site-config', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ password: token, config: cfg })
    });
    if (res.ok) {
      _fastestOverrides = fastestOv;
      _slowestOverrides = slowestOv;
      statusEl.textContent = '✓ Saved!';
      statusEl.style.color = '#155724';
      setTimeout(() => statusEl.textContent = '', 3000);
    } else {
      statusEl.textContent = 'Error saving';
      statusEl.style.color = '#cf4027';
    }
  } catch(e) {
    statusEl.textContent = 'Network error';
    statusEl.style.color = '#cf4027';
  }
}

async function resetMedalOverrides() {
  for (let i = 0; i < 10; i++) { _clearRankSlot('fastest', i); _clearRankSlot('slowest', i); }
  _fastestOverrides = Array(10).fill(null).map(() => []);
  _slowestOverrides = Array(10).fill(null).map(() => []);
  await saveMedalOverrides();
}

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
