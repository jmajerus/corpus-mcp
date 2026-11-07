import { page } from "./layout.js";
export const DUPLICATES_HTML = page({
  title: "Duplicates", nav: "duplicates",
  css: `.pair{margin:16px 0}.compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.cover{float:right;width:70px;max-height:110px;object-fit:contain}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.warning{color:var(--warn)}`,
  body: `<h1>Review duplicate books</h1>
<p class="sub">Compare candidates before deleting. You can delete an unwanted record directly in Calibre-Web, which removes its shelf memberships too. Preserve any unique formats or saved data first. Use corpus’s preview to merge unique content into a keeper before trashing an unreferenced duplicate.</p>
<div class="actions"><button id="refresh-source" disabled>Refresh from Calibre</button><span id="freshness" class="note"></span></div>
<p id="refresh-status" role="status" aria-live="polite"></p>
<div class="filters"><input type="search" id="search" placeholder="Search title, author, or book ID" aria-label="Search duplicate pairs"><label><input type="checkbox" id="dismissed"> Include reviewed keep-both pairs</label></div>
<p id="count" class="note"></p><div id="pairs">Loading…</div>`,
  script: `
let pairs = [], canWrite = false, calibreWebUrl = null, writableLibrary = null, refreshRunning = false;
function render() {
 const query=document.getElementById('search').value.toLowerCase();
 const shown=pairs.filter(p=>p.books.some(b=>(b.id+' '+b.title+' '+b.authors.join(' ')).toLowerCase().includes(query)));
 document.getElementById('count').textContent=shown.length+' candidate pairs. Matching metadata may describe different editions. Identical-file evidence covers the indexed format; preview checks every source file.';
 document.getElementById('pairs').innerHTML=shown.map(p=>{
  const n=pairs.indexOf(p);
  return '<section class="card pair"><h2>'+p.evidence.map(esc).join(' · ')+(p.dismissed?' · Reviewed: keep both':'')+'</h2>'+(p.edition_warning?'<p class="warning">'+esc(p.edition_warning)+'</p>':'')+'<div class="compare">'+p.books.map((b,i)=>{
   const calibreLink=calibreWebUrl && b.library===writableLibrary ? '<p><a href="'+esc((calibreWebUrl.endsWith('/') ? calibreWebUrl.slice(0,-1) : calibreWebUrl)+'/book/'+b.calibre_id)+'" target="_blank" rel="noopener">Open this record in Calibre-Web</a></p>' : '';
   const refs=Object.entries(b.references).filter(([k,v])=>v).map(([k,v])=>k+': '+v).join(', ');
   return '<div><img class="cover" src="/api/books/'+encodeURIComponent(b.id)+'/cover" alt="" loading="lazy" onerror="this.remove()"><h3>'+bookLink(b.id,b.title)+'</h3><p>'+esc(b.id)+' · '+esc(b.authors.join('; '))+' · '+esc(b.year??'Year unknown')+'</p><p>Formats: '+esc(b.formats.join(', ')||'none')+' · '+esc(b.status)+(b.file_size?' · '+esc((b.file_size/1048576).toFixed(1))+' MiB':'')+'</p>'+(b.error?'<p class="warning">'+esc(b.error)+'</p>':'')+'<p>'+Object.entries(b.identifiers).map(([k,v])=>esc(k+': '+v)).join(' · ')+'</p><p>Saved references: '+esc(refs||'none')+'</p>'+calibreLink+'<label><input type="radio" name="keep-'+n+'" value="'+i+'" '+(i===0?'checked':'')+'> Keep this record</label></div>';
  }).join('')+'</div><p><label><input type="checkbox" id="conflicts-'+n+'"> Retain the keeper’s versions when both records have different files in the same format</label></p><div class="actions"><button data-preview="'+n+'" '+(!canWrite||!p.writable||p.dismissed?'disabled':'')+'>Preview resolution</button><button data-dismiss="'+n+'" '+(!canWrite?'disabled':'')+'>'+(p.dismissed?'Reopen review':'Keep both / different editions')+'</button>'+(!p.writable?'<span class="note">Resolution requires two records in the writable library.</span>':'')+'</div></section>';
 }).join('') || '<p>No duplicate candidates match. Previously reviewed pairs reappear if their metadata, file hash, or references change.</p>';
}
async function load(){try{const data=await api('/api/duplicates?dismissed='+(document.getElementById('dismissed').checked?'1':'0'));pairs=data.pairs;calibreWebUrl=data.calibre_web_url;writableLibrary=data.writable_library;
 document.getElementById('freshness').textContent=(data.last_scan?'Catalogue refreshed '+when(data.last_scan)+'. ':'No completed catalogue refresh yet. ')+'Reloading this page does not pull changes from Calibre.';render();}catch(e){document.getElementById('pairs').textContent=e.message;}}
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
document.getElementById('pairs').addEventListener('click',async e=>{
 const btn=e.target.closest('button');if(!btn)return;
 const n=Number(btn.dataset.preview??btn.dataset.dismiss),p=pairs[n];btn.disabled=true;
 try{
  if(btn.dataset.dismiss!==undefined){await post('/api/duplicates/review',{ids:p.books.map(b=>b.id),fingerprint:p.fingerprint,reopen:p.dismissed});await load();}
  else {const keeper=Number(document.querySelector('input[name="keep-'+n+'"]:checked').value);const out=await post('/api/duplicates/preview',{keep:p.books[keeper].id,remove:p.books[1-keeper].id,fingerprint:p.fingerprint,discard_conflicts:document.getElementById('conflicts-'+n).checked});location.href='/admin/jobs/'+out.id;}
 }catch(err){toast(err.message);btn.disabled=false;}
});
ME.then(me=>{canWrite=me.can_write;document.getElementById('refresh-source').disabled=!canWrite;load();});`,
});
