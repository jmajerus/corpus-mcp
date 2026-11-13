import { page } from "./layout.js";
export const DUPLICATES_HTML = page({
  title: "Duplicates", nav: "duplicates",
  css: `.pair{margin:16px 0}.compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.cover{float:right;width:70px;max-height:110px;object-fit:contain}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.warning{color:var(--warn)}.member{border-left:3px solid transparent;padding-left:10px}.member.keep{border-left-color:var(--ok)}.member.trash{border-left-color:var(--danger);opacity:.85}.choice{display:flex;gap:16px;flex-wrap:wrap}.matches li{margin:4px 0}.batch{position:sticky;top:0;z-index:2;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin:12px 0}`,
  body: `<h1>Review duplicate books</h1>
<p class="sub">Each group links records that match by file, identifier, or title and authors. Choose the keeper; the records marked Trash are merged into it (unique formats, tags, missing metadata and cover) and moved to Calibre’s trash, after a backup. Select several groups to preview and apply them as one batch; groups with blockers are skipped. You can also delete an unwanted record directly in Calibre-Web, which removes its shelf memberships too.</p>
<div class="actions"><button id="refresh-source" disabled>Refresh from Calibre</button><span id="freshness" class="note"></span></div>
<p id="refresh-status" role="status" aria-live="polite"></p>
<div class="filters"><input type="search" id="search" placeholder="Search title, author, or book ID" aria-label="Search duplicate groups"><label><input type="checkbox" id="dismissed"> Include reviewed keep-both pairs</label></div>
<div class="batch actions"><button id="select-identical">Select identical-file groups</button><button id="select-all">Select all shown</button><button id="select-none">Clear</button><button id="preview-batch" class="primary" disabled>Preview selected</button><span id="count" class="note"></span></div>
<div id="groups">Loading…</div>`,
  script: `
let groups = [], state = {}, canWrite = false, calibreWebUrl = null, writableLibrary = null, refreshRunning = false;
const pairKey = (a,b) => [a,b].sort().join('|');
function direct(g){const m=new Map();for(const p of g.pairs)if(!p.dismissed)m.set(pairKey(p.books[0].id,p.books[1].id),p);return m;}
const referenced = b => Object.values(b.references||{}).some(v=>v>0);
/** The records that may be trashed into keeper: paired with it directly, unreferenced, and that pair writable. */
function trashable(g,keep,b){const p=direct(g).get(pairKey(keep,b.id));return b.id!==keep&&!!p&&p.writable&&!referenced(b);}
function init(g){
 const old=state[g.key];
 const keep=old&&g.books.some(b=>b.id===old.keep)?old.keep:g.suggested_keep;
 const trash=old?old.trash.filter(id=>trashable(g,keep,g.books.find(b=>b.id===id))):g.books.filter(b=>trashable(g,keep,b)).map(b=>b.id);
 state[g.key]={keep,trash,picked:old?.picked??false,conflicts:old?.conflicts??false};
}
function selection(g){const s=state[g.key];const ids=[s.keep,...s.trash];return {keep:s.keep,remove:s.trash,discard_conflicts:s.conflicts,fingerprints:Object.fromEntries(g.books.filter(b=>ids.includes(b.id)).map(b=>[b.id,b.fingerprint]))};}
function ready(g){return canWrite&&state[g.key].trash.length>0;}
function shown(){const q=document.getElementById('search').value.toLowerCase();return groups.filter(g=>g.books.some(b=>(b.id+' '+b.title+' '+b.authors.join(' ')).toLowerCase().includes(q)));}
function updateBatch(){
 const picked=groups.filter(g=>state[g.key].picked&&ready(g)),records=picked.reduce((n,g)=>n+state[g.key].trash.length,0);
 const button=document.getElementById('preview-batch');button.disabled=!picked.length;
 button.textContent=picked.length?'Preview '+picked.length+' group'+(picked.length===1?'':'s')+' ('+records+' to trash)':'Preview selected';
 document.getElementById('count').textContent=shown().length+' groups shown, '+groups.length+' in all.';
}
function render() {
 document.getElementById('groups').innerHTML=shown().map(g=>{
  const n=groups.indexOf(g),s=state[g.key];
  const evidence=[...new Set(g.pairs.flatMap(p=>p.evidence))];
  const warnings=[...new Set(g.pairs.map(p=>p.edition_warning).filter(Boolean))];
  return '<section class="card pair"><h2><label><input type="checkbox" data-pick="'+n+'" '+(s.picked?'checked ':'')+(ready(g)?'':'disabled')+'> '+g.books.length+' records</label> · '+evidence.map(esc).join(' · ')+'</h2>'+warnings.map(w=>'<p class="warning">'+esc(w)+'</p>').join('')+'<div class="compare">'+g.books.map(b=>{
   const keep=b.id===s.keep,trash=s.trash.includes(b.id),canTrash=trashable(g,s.keep,b);
   const calibreLink=calibreWebUrl && b.library===writableLibrary ? '<p><a href="'+esc((calibreWebUrl.endsWith('/') ? calibreWebUrl.slice(0,-1) : calibreWebUrl)+'/book/'+b.calibre_id)+'" target="_blank" rel="noopener">Open this record in Calibre-Web</a></p>' : '';
   const refs=Object.entries(b.references).filter(([k,v])=>v).map(([k,v])=>k+': '+v).join(', ');
   const p=direct(g).get(pairKey(s.keep,b.id));
   const why=keep?'':!canTrash?(referenced(b)?'Has saved references; it can only be the keeper.':!p?'Does not match the keeper directly; choose another keeper or resolve it separately.':'Not in the writable library with the keeper.'):'';
   return '<div class="member'+(keep?' keep':trash?' trash':'')+'"><img class="cover" src="/api/books/'+encodeURIComponent(b.id)+'/cover" alt="" loading="lazy" onerror="this.remove()"><h3>'+bookLink(b.id,b.title)+'</h3><p>'+esc(b.id)+' · '+esc(b.authors.join('; '))+' · '+esc(b.year??'Year unknown')+'</p><p>Formats: '+esc(b.formats.join(', ')||'none')+' · '+esc(b.status)+(b.file_size?' · '+esc((b.file_size/1048576).toFixed(1))+' MiB':'')+'</p>'+(b.error?'<p class="warning">'+esc(b.error)+'</p>':'')+'<p>'+Object.entries(b.identifiers).map(([k,v])=>esc(k+': '+v)).join(' · ')+'</p><p>Saved references: '+esc(refs||'none')+'</p>'+calibreLink
    +'<p class="choice"><label><input type="radio" name="keep-'+n+'" data-keep="'+n+'" value="'+esc(b.id)+'" '+(keep?'checked':'')+'> Keep</label><label><input type="checkbox" data-trash="'+n+'" value="'+esc(b.id)+'" '+(trash?'checked ':'')+(canTrash?'':'disabled')+'> Trash</label></p>'+(why?'<p class="note">'+esc(why)+'</p>':'')+'</div>';
  }).join('')+'</div><details><summary>'+g.pairs.length+' match'+(g.pairs.length===1?'':'es')+'</summary><ul class="matches">'+g.pairs.map((p,i)=>'<li>'+esc(p.books[0].id)+' ↔ '+esc(p.books[1].id)+': '+p.evidence.map(esc).join(', ')+(p.dismissed?' · <em>reviewed: keep both</em>':'')+' <button data-dismiss="'+n+':'+i+'" '+(!canWrite?'disabled':'')+'>'+(p.dismissed?'Reopen':'Keep both')+'</button></li>').join('')+'</ul></details>'
   +'<p><label><input type="checkbox" data-conflicts="'+n+'" '+(s.conflicts?'checked':'')+'> Retain the keeper’s versions when records have different files in the same format</label></p><div class="actions"><button data-preview="'+n+'" '+(ready(g)?'':'disabled')+'>Preview this group</button>'+(!g.writable?'<span class="note">Only records in the writable library can be resolved.</span>':'')+'</div></section>';
 }).join('') || '<p>No duplicate candidates match. Previously reviewed pairs reappear if their metadata, file hash, or references change.</p>';
 updateBatch();
}
async function load(){try{const data=await api('/api/duplicates?dismissed='+(document.getElementById('dismissed').checked?'1':'0'));groups=data.groups;calibreWebUrl=data.calibre_web_url;writableLibrary=data.writable_library;
 groups.forEach(init);
 document.getElementById('freshness').textContent=(data.last_scan?'Catalogue refreshed '+when(data.last_scan)+'. ':'No completed catalogue refresh yet. ')+'Reloading this page does not pull changes from Calibre.';render();}catch(e){document.getElementById('groups').textContent=e.message;}}
async function preview(list){
 const out=await post('/api/duplicates/preview',{groups:list.map(selection)});location.href='/admin/jobs/'+out.id;
}
document.getElementById('refresh-source').addEventListener('click',async()=>{
 if(refreshRunning)return;refreshRunning=true;
 const button=document.getElementById('refresh-source'),status=document.getElementById('refresh-status');button.disabled=true;
 try{
  const out=await post('/api/admin/jobs',{kind:'refresh',mode:'apply'});
  const link='<a href="/admin/jobs/'+out.id+'">Refresh job #'+out.id+'</a>';
  status.innerHTML='Pulling changes from Calibre and updating the catalogue… '+link;
  let job;
  do{await new Promise(resolve=>setTimeout(resolve,1000));job=await api('/api/admin/jobs/'+out.id);}while(job.status==='running');
  await load();
  status.innerHTML=job.status==='succeeded'?'Catalogue updated. '+link:'Refresh did not complete. '+link;
 }catch(e){status.textContent=e.message;}finally{refreshRunning=false;button.disabled=!canWrite;}
});
window.addEventListener('pageshow',e=>{if(e.persisted)load();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!refreshRunning)load();});
document.getElementById('search').addEventListener('input',render);
document.getElementById('dismissed').addEventListener('change',load);
const pick=filter=>{for(const g of shown())state[g.key].picked=filter(g)&&ready(g);render();};
document.getElementById('select-identical').addEventListener('click',()=>pick(g=>g.identical));
document.getElementById('select-all').addEventListener('click',()=>pick(()=>true));
document.getElementById('select-none').addEventListener('click',()=>{for(const g of groups)state[g.key].picked=false;render();});
document.getElementById('preview-batch').addEventListener('click',async e=>{
 const list=groups.filter(g=>state[g.key].picked&&ready(g));e.target.disabled=true;
 try{await preview(list);}catch(err){toast(err.message);e.target.disabled=false;}
});
document.getElementById('groups').addEventListener('change',e=>{
 const t=e.target,d=t.dataset;
 if(d.keep!==undefined){const g=groups[Number(d.keep)];state[g.key].keep=t.value;state[g.key].trash=g.books.filter(b=>trashable(g,t.value,b)).map(b=>b.id);}
 else if(d.trash!==undefined){const s=state[groups[Number(d.trash)].key];s.trash=t.checked?[...s.trash,t.value]:s.trash.filter(id=>id!==t.value);}
 else if(d.pick!==undefined)state[groups[Number(d.pick)].key].picked=t.checked;
 else if(d.conflicts!==undefined)state[groups[Number(d.conflicts)].key].conflicts=t.checked;
 else return;
 render();
});
document.getElementById('groups').addEventListener('click',async e=>{
 const btn=e.target.closest('button');if(!btn)return;btn.disabled=true;
 try{
  if(btn.dataset.dismiss!==undefined){const [n,i]=btn.dataset.dismiss.split(':').map(Number),p=groups[n].pairs[i];await post('/api/duplicates/review',{ids:p.books.map(b=>b.id),fingerprint:p.fingerprint,reopen:p.dismissed});await load();}
  else if(btn.dataset.preview!==undefined)await preview([groups[Number(btn.dataset.preview)]]);
 }catch(err){toast(err.message);btn.disabled=false;}
});
ME.then(me=>{canWrite=me.can_write;document.getElementById('refresh-source').disabled=!canWrite;load();});`,
});
