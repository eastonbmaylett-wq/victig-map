
const STATUS = {
  ok:          {fill:'#55ae5c',label:'No Delay',        badge:'#d4edda',text:'#155724'},
  delay:       {fill:'#dea922',label:'Delay',            badge:'#fff3cd',text:'#856404'},
  high_tat:    {fill:'#de7612',label:'Avg TAT >14 Days', badge:'#ffe5cc',text:'#7a3600'},
  significant: {fill:'#cf4027',label:'Significant Delay',badge:'#f8d7da',text:'#721c24'},
  no_data:     {fill:'#55ae5c',label:'No Data',          badge:'#f0f0f0',text:'#888'},
};
let counties={}, svgSel, svgZoom, pathFn, topoData;

function getFill(fips){ return STATUS[counties[fips]?.status]?.fill || STATUS.no_data.fill; }

function fmtTAT(d){
  if(d==null) return '—';
  if(d===0) return 'Same day';
  const totalSec = Math.round(d*86400);
  const s = totalSec%60;
  const totalMin = Math.floor(totalSec/60);
  const m = totalMin%60;
  const h = Math.floor(totalMin/60);
  if(h===0&&m===0) return s+'s';
  if(h===0) return s>0?m+'m '+s+'s':m+'m';
  if(h<24) return m>0?h+'h '+m+'m':h+'h';
  const days=Math.floor(h/24), remH=h%24;
  return remH>0?days+'d '+remH+'h':days+'d';
}

async function init(){
  const [topo,data] = await Promise.all([
    fetch('counties-10m.json').then(r=>r.json()),
    fetch('county-data.json').then(r=>r.json())
  ]);
  topoData=topo; counties=data.counties;
  // Enrich with state avg — top-level stateAvg preferred, else compute client-side
  const saMap=data.stateAvg||{};
  if(!Object.keys(saMap).length){
    const bkts={};
    for(const c of Object.values(counties)){
      const st=c.state; if(!st) continue;
      const p=c.periods?.['90d']||c.periods?.['180d']||c.periods?.['60d']||c.periods?.['30d'];
      if(!p) continue;
      if(!bkts[st]) bkts[st]={sum:0,count:0};
      bkts[st].sum+=p.avg*p.count; bkts[st].count+=p.count;
    }
    for(const [st,b] of Object.entries(bkts)) saMap[st]={avg:b.sum/b.count,count:b.count};
  }
  for(const [fips,c] of Object.entries(counties)){
    if(!c.state_avg&&c.state&&saMap[c.state]) c.state_avg=saMap[c.state];
  }
  if(data.maxDate) document.getElementById('data-info').textContent='Data through '+data.maxDate;
  drawMap(topo);
}

function drawMap(topo){
  const wrap=document.getElementById('wrap');
  const W=wrap.clientWidth||window.innerWidth, H=wrap.clientHeight||window.innerHeight;
  svgSel=d3.select('#map-svg').attr('width',W).attr('height',H);
  const allC=topojson.feature(topo,topo.objects.counties);
  const allS=topojson.feature(topo,topo.objects.states);
  const sM=topojson.mesh(topo,topo.objects.states,(a,b)=>a!==b);
  const proj=d3.geoAlbersUsa().fitSize([W,H],allC);
  const path=d3.geoPath().projection(proj);
  pathFn=path;
  const g=svgSel.append('g');
  g.append('g').selectAll('path').data(allC.features).join('path')
    .attr('class','county').attr('d',path).attr('fill',d=>getFill(d.id))
    .on('mousemove',(ev,d)=>{
      const c=counties[d.id]; if(!c) return;
      const tt=document.getElementById('tooltip');
      tt.textContent=`${c.name}, ${c.state} — ${STATUS[c.status]?.label||'No Data'}`;
      tt.style.display='block';
      tt.style.left=(ev.offsetX+12)+'px'; tt.style.top=(ev.offsetY-8)+'px';
    })
    .on('mouseleave',()=>document.getElementById('tooltip').style.display='none')
    .on('click',(ev,d)=>showPopup(ev,d));
  g.append('path').datum(sM).attr('class','state-border').attr('d',path);
  svgZoom=d3.zoom().scaleExtent([1,12]).on('zoom',e=>{
    g.attr('transform',e.transform);
    g.selectAll('.county').attr('stroke-width',.3/e.transform.k);
    g.selectAll('.state-border').attr('stroke-width',1.8/e.transform.k);
    closePopup();
  });
  svgSel.call(svgZoom);
  svgSel.on('dblclick.zoom',null);
  document.getElementById('z-in').onclick=()=>svgSel.transition().call(svgZoom.scaleBy,1.6);
  document.getElementById('z-out').onclick=()=>svgSel.transition().call(svgZoom.scaleBy,.625);
  document.getElementById('z-reset').onclick=()=>svgSel.transition().call(svgZoom.transform,d3.zoomIdentity);
}

function showPopup(ev,d){
  const c=counties[d.id]||{}; const sc=STATUS[c.status]||STATUS.no_data;
  const p90=c.periods?.['90d']||c.periods?.['180d']||c.periods?.['60d']||c.periods?.['30d'];
  const lat=c.latest;
  document.getElementById('tooltip').style.display='none';
  document.getElementById('popup-name').textContent=`${c.name||d.id} County, ${c.state||''}`;

  const statsHtml = p90 ? `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:10px 0;text-align:center">
      <div style="background:#f8f9fb;border-radius:6px;padding:7px 4px">
        <div style="font-size:9px;color:#aaa;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Avg TAT</div>
        <div style="font-size:14px;font-weight:700;color:#1a2b45">${fmtTAT(p90.avg)}</div>
      </div>
      <div style="background:#f8f9fb;border-radius:6px;padding:7px 4px">
        <div style="font-size:9px;color:#aaa;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Max TAT</div>
        <div style="font-size:14px;font-weight:700;color:#1a2b45">${fmtTAT(p90.max)}</div>
      </div>
      <div style="background:#f8f9fb;border-radius:6px;padding:7px 4px">
        <div style="font-size:9px;color:#aaa;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Min TAT</div>
        <div style="font-size:14px;font-weight:700;color:#1a2b45">${fmtTAT(p90.min)}</div>
      </div>
    </div>` : '';

  const latestHtml = lat ? `
    <div style="border-top:1px solid #f0f0f0;margin-top:8px;padding-top:8px;font-size:11px">
      <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Most Recent Search</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:#aaa">Started</span><span>${lat.date}</span></div>
      ${lat.completion?`<div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:#aaa">Completed</span><span>${lat.completion}</span></div>`:''}
      <div style="display:flex;justify-content:space-between"><span style="color:#aaa">TAT</span><span><b>${fmtTAT(lat.tat)}</b></span></div>
    </div>` : '';

  const rawDesc = c.description ? c.description.trimEnd() : '';
  const descText = rawDesc && !/[.!?]$/.test(rawDesc) ? rawDesc + '.' : rawDesc;
  const descHtml = descText
    ? `<div class="p-desc" style="margin-top:8px">${descText}</div>`
    : (c.status==='ok'||!c.status) ? `<div style="font-size:11px;color:#55ae5c;margin-top:8px;border-left:3px solid #55ae5c;padding-left:7px;background:#f0faf2;border-radius:0 4px 4px 0;padding:5px 7px">✓ No active court delays reported.</div>` : '';

  document.getElementById('popup-body').innerHTML = `
    <span class="p-badge" style="background:${sc.badge};color:${sc.text}">${sc.label}</span>
    ${statsHtml}${latestHtml}${descHtml}
  `;

  const popup=document.getElementById('popup');
  popup.style.display='block';
  const wrap=document.getElementById('wrap');
  const pw=popup.offsetWidth||280, ph=popup.offsetHeight||200;
  const pad=10;
  let x=ev.offsetX+16, y=ev.offsetY-20;
  if(x+pw+pad>wrap.clientWidth) x=ev.offsetX-pw-8;
  if(y+ph+pad>wrap.clientHeight) y=wrap.clientHeight-ph-pad;
  if(y<pad) y=pad;
  if(x<pad) x=pad;
  popup.style.left=x+'px'; popup.style.top=y+'px';
}
function closePopup(){ document.getElementById('popup').style.display='none'; }
document.addEventListener('click',e=>{ if(!e.target.closest('#popup')&&!e.target.closest('.county')) closePopup(); });
init().catch(e=>console.error(e));
