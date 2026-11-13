import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as mupdf from "mupdf";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { openDataStore } from "../src/data.js";
import { scanLibraries } from "../src/indexer.js";
import { zoteroMatch } from "../src/zotero.js";
import { type Corpus, getBook } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { coverColour, GREYSCALE_COVER, sizeWarnings, duplicatePairs, duplicateGroups, duplicateBatchPlan, dismissDuplicate, duplicateCandidates, duplicateReferences } from "../src/duplicates.js";
import { JobRunner, type JobCommands } from "../src/jobs.js";
import { DUPLICATES_HTML } from "../src/web/duplicates.js";
import { JOB_HTML } from "../src/web/jobs.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";

let root:string,c:Corpus,config:Config;
beforeEach(()=>{
 root=tempDir();
 const pdf=makePdf({pages:[["A synthetic book for duplicate review"]]});
 makeLibrary(root,"main",[
  {id:1,title:"The Same Book",authors:["Ann Author"],pubdate:"2020-01-01",files:{pdf}},
  {id:2,title:"The Same Book",authors:["Ann Author"],pubdate:"2021-01-01",files:{pdf}},
  {id:3,title:"Unrelated",authors:["Other Writer"],files:{pdf:Buffer.from("broken")}},
 ]);
 config=loadConfig({CORPUS_BOOKS_ROOT:root,CORPUS_LIBRARIES:"main",CORPUS_DB:path.join(root,"corpus.db"),CORPUS_DATA_DB:path.join(root,"data.db")});
 c={db:openDatabase(config.dbPath),data:openDataStore(config.dataDbPath),booksRoot:root,vocabulary:new Vocabulary(JSON.parse(fs.readFileSync(path.join(import.meta.dirname,"vocabulary.json"),"utf8")))};
 scanLibraries(config,c.db);
});
afterEach(()=>{vi.restoreAllMocks();c.db.close();c.data.close();fs.rmSync(root,{recursive:true,force:true});});
function pair(){return duplicatePairs(c,"main").pairs.find(p=>p.books[0].id==="main:1"&&p.books[1].id==="main:2")!;}
function select(keep="main:1",remove=["main:2"]){const books=duplicatePairs(c,"main").pairs.flatMap(p=>p.books);return {keep,remove,fingerprints:Object.fromEntries(books.map(b=>[b.id,b.fingerprint]))};}
const plan=(s=select())=>duplicateBatchPlan(c,"main",[s]);
it("reports exact selected files, metadata evidence, edition warnings and all available formats",()=>{
 const p=pair();expect(p.evidence).toEqual(["Identical selected file","Matching title and authors"]);
 expect(p.edition_warning).toContain("years differ");expect(p.books[0].formats).toEqual(["PDF"]);expect(p.writable).toBe(true);
});
it("finds matching ASINs despite different titles and damaged, non-identical bytes",()=>{
 const db=new Database(path.join(root,"main/metadata.db"));
 db.prepare("INSERT INTO identifiers(book,type,val) VALUES(?,?,?)").run(1,"mobi-asin","B000XYZ");
 db.prepare("INSERT INTO identifiers(book,type,val) VALUES(?,?,?)").run(3,"asin","B000XYZ");db.close();
 const p=duplicatePairs(c,"main").pairs.find(p=>p.books.some(b=>b.id==="main:3"))!;
 expect(p.evidence).toEqual(["Matching identifier"]);expect(p.books[1].status).toBe("failed");
});
it("persists keep-both decisions, supports reopening, and invalidates them when a record changes",()=>{
 const before=select();let p=pair();dismissDuplicate(c,"main",p.books.map(b=>b.id),p.fingerprint,false,"reviewer");
 expect(duplicatePairs(c,"main").total).toBe(0);expect(duplicatePairs(c,"main",true).pairs[0].dismissed).toBe(true);
 dismissDuplicate(c,"main",p.books.map(b=>b.id),p.fingerprint,true);expect(duplicatePairs(c,"main").total).toBe(1);
 dismissDuplicate(c,"main",p.books.map(b=>b.id),p.fingerprint,false);
 c.db.prepare("UPDATE books SET year=2022 WHERE id='main:2'").run();expect(duplicatePairs(c,"main").total).toBe(1);
 expect(()=>duplicateBatchPlan(c,"main",[before])).toThrow(/changed/);
});
it("blocks referenced records and cross-library resolution without moving any links",()=>{
 const p=pair();c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','saved2021book','main:2','The Same Book','now')").run();
 expect(()=>plan()).toThrow(/saved references/);
 expect(()=>duplicateBatchPlan(c,"other",[select()])).toThrow(/writable/);
 expect(c.data.prepare("SELECT count(*) FROM citekeys").pluck().get()).toBe(1);
 expect(()=>dismissDuplicate(c,"main",["main:1","main:3"],p.fingerprint,false)).toThrow(/changed/);
});
async function wait(r:JobRunner,id:number){for(let i=0;i<100;i++){if(r.get(id).status!=="running"){await new Promise(done=>setTimeout(done,0));return r.get(id);}await new Promise(done=>setTimeout(done,5));}throw new Error("Job did not finish");}
it("applies the source-reviewed plan, audits resolution, refreshes and releases the write pause",async()=>{
 let refreshes=0;const calls:any[]=[];
 const commands:JobCommands={refresh:async()=>{refreshes++;},calibre:async(command,stdin,log)=>{
  const plan=JSON.parse(stdin!);calls.push({command,plan});
  if(command==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"The Same Book",duplicate_review:{plan:{...plan.groups[0],reviewed:"source-hash"},blockers:[]}})+'\n');
  else {expect(c.writesPaused).toBeTruthy();log('@@change '+JSON.stringify({calibre_id:1,title:"The Same Book",duplicate_resolved:{removed_id:2,removed_uuid:"uuid-2",trash:true,backup:"saved.db"}})+'\n');}
 }};
 const r=new JobRunner(c,config,commands);
 expect(()=>r.start("duplicates","apply")).toThrow(/Preview first/);
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 const result=await wait(r,r.start("duplicates","apply",{previewOf:preview.id}));
 expect(result.status).toBe("succeeded");expect(calls[1].plan.groups[0].reviewed).toBe("source-hash");expect(refreshes).toBe(1);expect(c.writesPaused).toBeUndefined();
 expect(c.data.prepare("SELECT count(*) FROM changes WHERE kind='duplicate_resolved'").pluck().get()).toBe(1);
});
it("refuses newly referenced duplicates after preview and previews with source blockers",async()=>{
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{log('@@change '+JSON.stringify({calibre_id:1,title:"Book",duplicate_review:{plan:{...JSON.parse(stdin!).groups[0],reviewed:"source"},blockers:[]}})+'\n');}});
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','newkey','main:2','Book','now')").run();
 expect(()=>r.start("duplicates","apply",{previewOf:preview.id})).toThrow(/saved references/);
});
it("refreshes after a failed source write and keeps the job failed",async()=>{
 let refreshed=0;
 const r=new JobRunner(c,config,{refresh:async()=>{refreshed++;},calibre:async(cmd,stdin,log)=>{
  if(cmd==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"Book",duplicate_review:{plan:{...JSON.parse(stdin!).groups[0],reviewed:"source"},blockers:[]}})+'\n');
  else {log('@@change '+JSON.stringify({calibre_id:1,title:"Book",added_format:"EPUB",source_format:"duplicate"})+'\n');throw new Error("Injected write failure");}
 }});
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 const result=await wait(r,r.start("duplicates","apply",{previewOf:preview.id}));
 expect(result.status).toBe("failed");expect(refreshed).toBe(1);expect(c.writesPaused).toBeUndefined();expect(result.items[0].added_format).toBe("EPUB");
});
it("renders syntactically valid review and job scripts",()=>{
 for(const html of [DUPLICATES_HTML,JOB_HTML])for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))expect(()=>new Function(match[1])).not.toThrow();
});

it("holds resolution when quote-mcp reports an unanchored quote or cannot verify references",async()=>{
 const {assertNoBookQuotes}=await import('../src/quoteMcp.js');
 const http=await import('node:http');
 let status=200,body:any={quotes:[{id:90,anchor:null}]};
 const server=http.createServer((req,res)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body)));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  await expect(assertNoBookQuotes(base,'uuid-2')).rejects.toThrow(/quotes in quote-mcp/);
  status=503;await expect(assertNoBookQuotes(base,'uuid-2')).rejects.toThrow(/Could not verify/);
  status=200;body={quotes:[]};await expect(assertNoBookQuotes(base,'uuid-2')).resolves.toBeUndefined();
 }finally{await new Promise<void>(done=>server.close(()=>done()));}
});


it.each([false,true])("blocks a Zotero UUID without an explicit link, including a merged survivor (%s)",merged=>{
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,calibre_uuid,trashed,replaces,synced_at) VALUES('FILED',1,'book','Filed duplicate','uuid-2',?,'[]','now')").run(merged?1:0);
 if(merged)c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,trashed,replaces,synced_at) VALUES('SURVIVOR',2,'book','Merged book',0,'[\"FILED\"]','now')").run();
 expect(c.data.prepare("SELECT count(*) FROM zotero_links").pluck().get()).toBe(0);
 expect(zoteroMatch(c,getBook(c,'main:2')).match).toMatchObject({key:merged?'SURVIVOR':'FILED',matched_by:'calibre_uuid'});
 expect(duplicateReferences(c,'uuid-2').zotero_items).toBe(1);
 expect(pair().books[1].references.zotero_items).toBe(1);
 expect(()=>plan()).toThrow(/saved references/);
});

it("rechecks Zotero UUID references added after a successful source preview",async()=>{
 const calls:string[]=[];
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  calls.push(command);log('@@change '+JSON.stringify({calibre_id:1,title:'Book',duplicate_review:{plan:{...JSON.parse(stdin!).groups[0],reviewed:'source'},blockers:[]}})+'\n');
 }});
 const preview=await wait(r,r.start('duplicates','preview',{duplicates:[select()]}));
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,calibre_uuid,synced_at) VALUES('NEW',1,'book','uuid-2','now')").run();
 expect(()=>r.start('duplicates','apply',{previewOf:preview.id})).toThrow(/saved references/);
 expect(calls).toEqual(['duplicates-preview']);
});

it("normalizes candidate keys once and coalesces overlapping evidence without transitive matches",()=>{
 const candidates=[
  {title:'Café: Theory',authors:['Ann Author','Bo Writer'],format:'pdf',sha256:'same',identifiers:{'mobi-asin':'B-0123',asin:'b0123'}},
  {title:'Cafe Theory',authors:['Bo Writer','Ann Author'],format:'pdf',sha256:'same',identifiers:{asin:'B0123'}},
  {title:'Other',authors:['Unknown'],format:'epub',sha256:'same',identifiers:{asin:'b0123'}},
  {title:'Unrelated',authors:['Different'],format:'pdf',sha256:'other',identifiers:{citekey:'b0123'}},
 ];
 expect(duplicateCandidates(candidates)).toEqual([
  {i:0,j:1,evidence:['Identical selected file','Matching identifier','Matching title and authors']},
  {i:0,j:2,evidence:['Matching identifier']},{i:1,j:2,evidence:['Matching identifier']},
 ]);
});

it("matches one ASIN or ISBN across the Calibre fields that hold it",()=>{
 const book=(identifiers:Record<string,string>)=>({title:'T'+Math.random(),authors:['Unknown'],format:'epub',sha256:null,identifiers});
 expect(duplicateCandidates([
  book({'mobi-asin':'B009U9S6EO'}),book({bookid:'urn:asin:B009U9S6EO'}),
  book({isbn:'0-306-40615-2'}),book({EbookISBN:'9780306406157'}),book({bookid:'urn:isbn:978-0-306-40615-7'}),
  book({bookid:'urn:uuid:B009U9S6EO'}),book({citekey:'B009U9S6EO'}),
 ])).toEqual([
  {i:0,j:1,evidence:['Matching identifier']},
  {i:2,j:3,evidence:['Matching identifier']},{i:2,j:4,evidence:['Matching identifier']},{i:3,j:4,evidence:['Matching identifier']},
 ]);
});

it("normalizes a large unrelated catalogue linearly rather than comparing every pair",()=>{
 let titleReads=0;
 const books=Array.from({length:10000},(_,i)=>({get title(){titleReads++;return 'Title '+i;},authors:['Author '+i],format:'pdf',sha256:'hash-'+i,identifiers:{asin:'ASIN'+i}}));
 expect(duplicateCandidates(books)).toEqual([]);
 expect(titleReads).toBe(books.length);
});

it("reuses unchanged catalogue scans, invalidates on WAL updates and atomic replacement, and keeps references fresh",()=>{
 const spy=vi.spyOn(Database.prototype,'prepare');
 const scans=()=>spy.mock.calls.filter(([sql])=>sql==='SELECT book,type,val FROM identifiers ORDER BY type,val').length;
 const initial=pair().fingerprint;
 expect(scans()).toBe(1);
 duplicatePairs(c,'main');expect(scans()).toBe(1);
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,calibre_uuid,synced_at) VALUES('NEW',1,'book','uuid-2','now')").run();
 expect(pair().fingerprint).not.toBe(initial);expect(pair().books[1].references.zotero_items).toBe(1);expect(scans()).toBe(1);
 const file=path.join(root,'main/metadata.db');
 const writer=new Database(file);writer.pragma('journal_mode=WAL');
 try{
  writer.prepare("INSERT INTO identifiers(book,type,val) VALUES(3,'asin','CACHED-ASIN')").run();
  expect(duplicatePairs(c,'main').pairs.length).toBe(1);expect(scans()).toBe(2);
  writer.prepare("INSERT INTO identifiers(book,type,val) VALUES(1,'asin','CACHED-ASIN')").run();
  expect(duplicatePairs(c,'main').pairs.length).toBe(2);expect(scans()).toBe(3);
 }finally{writer.close();}
 const replacement=file+'.replacement';fs.copyFileSync(file,replacement);
 const edited=new Database(replacement);edited.prepare("DELETE FROM identifiers WHERE type='asin'").run();edited.close();
 fs.renameSync(replacement,file);
 expect(duplicatePairs(c,'main').pairs.length).toBe(1);expect(scans()).toBe(4);
});

it("keeps a blocked source preview reviewable and refuses to apply it",async()=>{
 const calls:string[]=[];
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  calls.push(command);log('@@change '+JSON.stringify({calibre_id:1,title:'Book',duplicate_review:{plan:{...JSON.parse(stdin!).groups[0],reviewed:'source'},blockers:['Calibre-Web shelf Main contains the duplicate. Remove its membership first.','Retain the keeper format.']}})+'\n');
 }});
 const preview=await wait(r,r.start('duplicates','preview',{duplicates:[select()]}));
 expect(preview.status).toBe('succeeded');expect(preview.items[0].duplicate_review?.blockers).toHaveLength(2);
 expect(()=>r.start('duplicates','apply',{previewOf:preview.id})).toThrow(/Every group in that preview has blockers/);
 expect(calls).toEqual(['duplicates-preview']);
});

it("drops deleted catalogue records after indexing even when metadata remains cached",()=>{
 expect(pair()).toBeDefined();
 const catalogue=new Database(path.join(root,'main/metadata.db'));
 catalogue.prepare('DELETE FROM books WHERE id=2').run();catalogue.close();
 scanLibraries(config,c.db);
 expect(c.db.prepare("SELECT id FROM books WHERE id='main:2'").get()).toBeUndefined();
 expect(duplicatePairs(c,'main').pairs.some(p=>p.books.some(b=>b.id==='main:2'))).toBe(false);
});

it.each(['succeeded','failed'])("the source refresh action waits for %s and reloads candidates",async terminal=>{
 const elements=new Map<string,any>();
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,disabled:true,innerHTML:'',textContent:'',listeners:{},addEventListener(name:string,fn:any){this.listeners[name]=fn;}});return elements.get(id);};
 const document={getElementById:element,addEventListener(){},hidden:false};
 let completed=false,polls=0,loads=0;const posts:any[]=[];
 const api=async(url:string)=>{
  if(url.startsWith('/api/duplicates')){loads++;return {groups:completed?[]:duplicateGroups(c,'main').groups,last_scan:'2026-11-07T20:00:00Z',calibre_web_url:'http://calibre.test/',writable_library:'main'};}
  polls++;if(polls===1)return {status:'running'};completed=terminal==='succeeded';return {status:terminal};
 };
 const post=async(url:string,body:any)=>{posts.push({url,body});return {id:42};};
 const script=[...DUPLICATES_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1];
 new Function('document','window','ME','api','post','esc','bookLink','when','setTimeout','toast',script)(document,{addEventListener(){}},Promise.resolve({can_write:true}),api,post,String,(_id:string,title:string)=>title,String,(fn:()=>void)=>fn(),()=>{});
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(element('groups').innerHTML).toContain('http://calibre.test/book/1');
 expect(element('freshness').textContent).toContain('Reloading this page does not pull');
 await element('refresh-source').listeners.click();
 expect(posts).toEqual([{url:'/api/admin/jobs',body:{kind:'refresh',mode:'apply'}}]);
 expect(polls).toBe(2);expect(loads).toBe(2);expect(element('refresh-source').disabled).toBe(false);
 expect(element('refresh-status').innerHTML).toContain(terminal==='succeeded'?'Catalogue updated':'Refresh did not complete');
 expect(element('groups').innerHTML.includes('The Same Book')).toBe(terminal!=='succeeded');
});

it("groups linked records, suggests a keeper, and plans a batch of disjoint groups",()=>{
 const db=new Database(path.join(root,"main/metadata.db"));
 db.prepare("INSERT INTO identifiers(book,type,val) VALUES(?,?,?)").run(2,"mobi-asin","B000XYZ");
 db.prepare("INSERT INTO identifiers(book,type,val) VALUES(?,?,?)").run(3,"bookid","urn:asin:B000XYZ");db.close();
 const {groups}=duplicateGroups(c,"main");
 expect(groups).toHaveLength(1);expect(groups[0].books.map(b=>b.id)).toEqual(["main:1","main:2","main:3"]);
 expect(groups[0].suggested_keep).toBe("main:1");expect(groups[0].identical).toBe(false);
 // main:3 matches main:2 only, so it cannot merge into main:1.
 expect(()=>plan(select("main:1",["main:2","main:3"]))).toThrow(/not a duplicate candidate of keeper main:1/);
 expect(plan(select("main:2",["main:1","main:3"]))).toMatchObject({library:"main",groups:[{keep:{id:2},remove:[{id:1},{id:3}],discard_conflicts:false}]});
 expect(()=>duplicateBatchPlan(c,"main",[select("main:2",["main:3"]),select("main:1",["main:2"])])).toThrow(/more than one group/);
 expect(()=>plan(select("main:2",[]))).toThrow(/at least one record/);
 expect(()=>duplicateBatchPlan(c,"main",[])).toThrow(/at least one duplicate group/);
});
it("prefers a referenced keeper and refuses to trash it",()=>{
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','saved2021book','main:2','The Same Book','now')").run();
 expect(duplicateGroups(c,"main").groups[0].suggested_keep).toBe("main:2");
 expect(()=>plan()).toThrow(/main:2 has saved references/);
 expect(plan(select("main:2",["main:1"])).groups[0].remove).toEqual([{id:1,uuid:"uuid-1"}]);
});
it("applies only the groups the source reviewed without blockers",async()=>{
 const sent:any[]=[];
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  const p=JSON.parse(stdin!);sent.push({command,p});
  if(command==="duplicates-preview"){
   log('@@change '+JSON.stringify({calibre_id:1,title:"Book",duplicate_review:{plan:{...p.groups[0],reviewed:"ok"},blockers:[]}})+'\n');
   log('@@change '+JSON.stringify({calibre_id:9,title:"Blocked",duplicate_review:{plan:{keep:{id:9,uuid:"u9"},remove:[{id:8,uuid:"u8"}],discard_conflicts:false,reviewed:"x"},blockers:["Shelf"]}})+'\n');
  } else log('@@change '+JSON.stringify({calibre_id:9,title:"Blocked",duplicate_skipped:{message:"changed"}})+'\n');
 }});
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 const applied=await wait(r,r.start("duplicates","apply",{previewOf:preview.id}));
 expect(sent[1].p).toEqual({library:"main",groups:[{keep:{id:1,uuid:"uuid-1"},remove:[{id:2,uuid:"uuid-2"}],discard_conflicts:false,reviewed:"ok"}]});
 expect(applied.items[0].duplicate_skipped?.message).toBe("changed");
});
it("suggests the record added to Calibre first, not the lowest id",()=>{
 c.db.prepare("UPDATE books SET added=? WHERE id=?").run("2026-11-12T00:00:00Z","main:1");
 c.db.prepare("UPDATE books SET added=? WHERE id=?").run("2025-06-09T00:00:00Z","main:2");
 expect(duplicateGroups(c,"main").groups[0].suggested_keep).toBe("main:2");
 c.db.prepare("UPDATE books SET added=NULL WHERE id='main:2'").run();
 expect(duplicateGroups(c,"main").groups[0].suggested_keep).toBe("main:1");
});
it("keeps keep-both decisions valid whatever only ranks the keeper",()=>{
 const p=pair();dismissDuplicate(c,"main",p.books.map(b=>b.id),p.fingerprint,false);
 c.db.prepare("UPDATE books SET added='2020-01-01T00:00:00Z' WHERE id='main:1'").run();
 expect(duplicatePairs(c,"main").total).toBe(0);
});
it("asks for a new preview instead of applying one saved before batch resolution",()=>{
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async()=>{}});
 const id=Number(c.data.prepare("INSERT INTO jobs(kind,mode,params,status,created_at,log,items) VALUES('duplicates','preview',?,'succeeded',?,'',?)").run(
  JSON.stringify({plan:{library:"main",keep:{id:1,uuid:"uuid-1"},remove:{id:2,uuid:"uuid-2"},discard_conflicts:false}}),new Date().toISOString(),
  JSON.stringify([{calibre_id:1,title:"Book",duplicate_review:{plan:{keep:{id:1,uuid:"uuid-1"},remove:{id:2,uuid:"uuid-2"},discard_conflicts:false,reviewed:"x"},blockers:[]}}])).lastInsertRowid);
 expect(()=>r.start("duplicates","apply",{previewOf:id})).toThrow(/predates batch resolution/);
});
it("renders duplicate reviews saved before batch resolution on the job page",async()=>{
 const els=new Map<string,any>();const el=(id:string)=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',scrollTop:0,clientHeight:0,scrollHeight:0,addEventListener(){}});return els.get(id);};
 const legacy={calibre_id:1,title:"Book",duplicate_review:{plan:{keep:{id:1,uuid:"u1"},remove:{id:2,uuid:"u2"},discard_conflicts:false},keep:{id:1,values:{},formats:{PDF:{}}},remove:{id:2,values:{},formats:{EPUB:{}}},copy_formats:["EPUB"],conflicting_formats:[],blockers:[]}};
 const api=async(url:string)=>url.includes('limit=1')?{kinds:{}}:{id:20,kind:'duplicates',mode:'preview',status:'succeeded',created_at:'2026-11-07T00:00:00Z',params:{plan:{library:'main'}},items:[legacy],log:''};
 const script=[...JOB_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1];
 new Function('document','location','ME','VOCAB','LABELS','api','post','esc','bookLink','when','num','toast','confirm','setTimeout',script)(
  {getElementById:el,title:''},{pathname:'/admin/jobs/20'},Promise.resolve({can_write:true}),Promise.resolve(new Map()),new Map(),api,async()=>({}),String,(_:string,t:string)=>t,String,String,()=>{},()=>true,()=>{});
 await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0));
 expect(el('items').innerHTML).toContain('Keep main:1; trash main:2');expect(el('items').innerHTML).toContain('Copy unique formats: EPUB.');
});

function cover(id:string,colour:boolean){
 const folder=c.db.prepare("SELECT folder FROM books WHERE id=?").pluck().get(id) as string;
 const pix=new mupdf.Pixmap(colour?mupdf.ColorSpace.DeviceRGB:mupdf.ColorSpace.DeviceGray,[0,0,40,60],false);
 const px=pix.getPixels();for(let i=0;i<px.length;i++)px[i]=colour?(i%3===0?200:i%3===1?40:(i*7)%255):(i*5)%255;
 fs.writeFileSync(path.join(root,folder,"cover.jpg"),pix.asJPEG(90,false));
}
it("reads black-and-white and colour covers apart",()=>{
 cover("main:1",false);cover("main:2",true);
 const folder=(id:string)=>path.join(root,c.db.prepare("SELECT folder FROM books WHERE id=?").pluck().get(id) as string,"cover.jpg");
 expect(coverColour(folder("main:1"))).toBeLessThan(GREYSCALE_COVER);
 expect(coverColour(folder("main:2"))).toBeGreaterThan(50);
 expect(coverColour(path.join(root,"missing.jpg"))).toBeNull();
});
it("prefers a colour cover, then a shelved record, and says why, without changing fingerprints",()=>{
 const before=pair().fingerprint,bookPrint=pair().books[1].fingerprint;
 expect(duplicateGroups(c,"main").groups[0]).toMatchObject({suggested_keep:"main:1",suggested_because:"has the lowest Calibre id"});
 cover("main:1",false);cover("main:2",true);
 expect(duplicateGroups(c,"main").groups[0]).toMatchObject({suggested_keep:"main:2",suggested_because:"has a colour cover"});
// A shelf does not outweigh the colour cover (its links move to the keeper anyway)...
 c.db.exec("INSERT INTO shelves(id,name) VALUES(3,'Peace Studies'); INSERT INTO book_shelves(book_id,shelf_id,ord) VALUES('main:1',3,1);");
 let g=duplicateGroups(c,"main").groups[0];
 expect(g).toMatchObject({suggested_keep:"main:2",suggested_because:"has a colour cover"});
 expect(g.books.map(b=>b.shelves)).toEqual([["Peace Studies"],[]]);
 // ...but breaks a tie between colour covers.
 cover("main:1",true);
 g=duplicateGroups(c,"main").groups[0];
 expect(g).toMatchObject({suggested_keep:"main:1",suggested_because:"is on a Calibre-Web shelf"});
 expect(pair().fingerprint).toBe(before);expect(pair().books[1].fingerprint).toBe(bookPrint);
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','k','main:2','T','now')").run();
 expect(duplicateGroups(c,"main").groups[0]).toMatchObject({suggested_keep:"main:2",suggested_because:"has saved references"});
});
it("flags groups whose EPUB or PDF sizes differ by 10% or more",()=>{
 expect(sizeWarnings([{id:"main:100",sizes:{EPUB:357*1024}},{id:"main:783",sizes:{EPUB:6617*1024}}])[0]).toMatch(/^EPUB sizes differ 18\.5×: main:100 357 KB, main:783 6\.5 MB\./);
 expect(sizeWarnings([{id:"main:98",sizes:{EPUB:447*1024}},{id:"main:661",sizes:{EPUB:381*1024}}])).toEqual([expect.stringMatching(/^EPUB sizes differ by 17%: main:98 447 KB, main:661 381 KB\./)]);
 expect(sizeWarnings([{id:"main:106",sizes:{EPUB:1123}},{id:"main:814",sizes:{EPUB:1058}},{id:"main:9",sizes:{PDF:5}}])).toEqual([]);
 const db=new Database(path.join(root,"main/metadata.db"));
 db.exec("ALTER TABLE data ADD COLUMN uncompressed_size INTEGER; UPDATE data SET uncompressed_size=CASE book WHEN 1 THEN 1000000 ELSE 3000000 END");db.close();
 expect(duplicateGroups(c,"main").groups[0].size_warnings).toEqual([expect.stringMatching(/^PDF sizes differ 3\.0×/)]);
 expect(pair().fingerprint).toBeDefined();
});
