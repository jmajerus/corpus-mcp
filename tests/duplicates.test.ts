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
import { coverColour, GREYSCALE_COVER, sizeWarnings, duplicatePairs, duplicateGroups, duplicateBatchPlan, dismissDuplicate, duplicateCandidates, duplicateReferences, duplicateContents } from "../src/duplicates.js";
import { profilesSettled } from "../src/duplicate-contents.js";
import { stopPdfWorkers, usePdfWorkers } from "../src/pdf-runner.js";
import { JobRunner, type JobCommands } from "../src/jobs.js";
import { DUPLICATES_HTML } from "../src/web/duplicates.js";
import { JOB_HTML } from "../src/web/jobs.js";
import { makeLibrary, makePdf, makeShapedEpub, tempDir } from "./fixtures.js";

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
/** An anchor for a quote-mcp quote on this record: it ties the record to its own file. */
const anchor=(uuid:string,id:string)=>c.data.prepare("INSERT INTO anchors(quote_id,calibre_uuid,book_id,start_page,start_offset,end_page,end_offset,prefix,suffix,text,status,created_at,updated_at) VALUES((SELECT COALESCE(MAX(quote_id),0)+1 FROM anchors),?,?,0,0,0,5,'','','A syn','verified','now','now')").run(uuid,id);
/** A quote in corpus-mcp's own old quote store: it cannot move, so its record can only be the keeper. */
const oldQuote=(uuid:string,id:string)=>c.data.prepare("INSERT INTO quotes(calibre_uuid,book_id,title,text,start_page,start_offset,end_page,end_offset,prefix,suffix,status,source,created_at) VALUES(?,?,'B','A syn',0,0,0,5,'','','verified','agent','now')").run(uuid,id);
/** Makes the copies match by title and authors only, so nothing shows they are one edition. */
const differentFiles=()=>c.db.prepare("UPDATE books SET sha256='another-file' WHERE id='main:2'").run();
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
it("blocks records with old corpus quotes and cross-library resolution without moving any links",()=>{
 const p=pair();anchor('uuid-2','main:2');oldQuote('uuid-2','main:2');
 expect(()=>plan()).toThrow(/old quote store/);
 expect(()=>duplicateBatchPlan(c,"other",[select()])).toThrow(/writable/);
 expect(c.data.prepare("SELECT count(*) FROM anchors WHERE calibre_uuid='uuid-2'").pluck().get()).toBe(1);
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
 oldQuote('uuid-2','main:2');
 expect(()=>r.start("duplicates","apply",{previewOf:preview.id})).toThrow(/old quote store/);
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

it("holds resolution when quote-mcp has an anchor that is not kept here, or cannot be asked",async()=>{
 const {assertBookQuotesMovable}=await import('../src/quoteMcp.js');
 const http=await import('node:http');
 let status=200,body:any={quotes:[{id:90,anchor:null}]};
 const server=http.createServer((req,res)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body)));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 try{
  // An unanchored quote needs nothing here: its book resolves to the keeper through the alias.
  await expect(assertBookQuotesMovable(base,'uuid-2',c.data)).resolves.toBeUndefined();
  body={quotes:[{id:1,anchor:{start_page:0}}]};
  await expect(assertBookQuotesMovable(base,'uuid-2',c.data)).rejects.toThrow(/anchors are not kept here \(quote 1\)/);
  anchor('uuid-2','main:2');await expect(assertBookQuotesMovable(base,'uuid-2',c.data)).resolves.toBeUndefined();
  status=503;await expect(assertBookQuotesMovable(base,'uuid-2',c.data)).rejects.toThrow(/Could not verify/);
 }finally{await new Promise<void>(done=>server.close(()=>done()));}
});


it.each([false,true])("moves a Zotero UUID filing only for the same edition, including a merged survivor (%s)",merged=>{
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,calibre_uuid,trashed,replaces,synced_at) VALUES('FILED',1,'book','Filed duplicate','uuid-2',?,'[]','now')").run(merged?1:0);
 if(merged)c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,trashed,replaces,synced_at) VALUES('SURVIVOR',2,'book','Merged book',0,'[\"FILED\"]','now')").run();
 expect(c.data.prepare("SELECT count(*) FROM zotero_links").pluck().get()).toBe(0);
 expect(zoteroMatch(c,getBook(c,'main:2')).match).toMatchObject({key:merged?'SURVIVOR':'FILED',matched_by:'calibre_uuid'});
 expect(duplicateReferences(c,'uuid-2').zotero_items).toBe(1);
 expect(pair().books[1].references.zotero_items).toBe(1);
 // An identical file shows one edition.
 expect(plan().groups[0].remove).toEqual([{id:2,uuid:"uuid-2"}]);
 differentFiles();
 expect(()=>plan()).toThrow(/same edition/);
 expect(plan({...select(),same_edition:true}).groups[0]).toMatchObject({same_edition:true,remove:[{id:2}]});
});

it("rechecks Zotero filing added after a successful source preview",async()=>{
 const calls:string[]=[];
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  calls.push(command);log('@@change '+JSON.stringify({calibre_id:1,title:'Book',duplicate_review:{plan:{...JSON.parse(stdin!).groups[0],reviewed:'source'},blockers:[]}})+'\n');
 }});
 const preview=await wait(r,r.start('duplicates','preview',{duplicates:[select()]}));
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,calibre_uuid,synced_at) VALUES('NEW',1,'book','uuid-2','now')").run();
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,calibre_uuid,synced_at) VALUES('OTHER',1,'book','uuid-1','now')").run();
 expect(()=>r.start('duplicates','apply',{previewOf:preview.id})).toThrow(/different Zotero items/);
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
it("prefers a keeper with old corpus quotes and refuses to trash it",()=>{
 oldQuote('uuid-2','main:2');
 expect(duplicateGroups(c,"main").groups[0].suggested_keep).toBe("main:2");
 expect(()=>plan()).toThrow(/main:2 has quotes in corpus-mcp's old quote store/);
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
 expect(duplicateGroups(c,"main").groups[0]).toMatchObject({suggested_keep:"main:2",suggested_because:"is filed with a citekey or in Zotero"});
 anchor('uuid-1','main:1');
 expect(duplicateGroups(c,"main").groups[0]).toMatchObject({suggested_keep:"main:1",suggested_because:"has quotes anchored in its text"});
 oldQuote('uuid-2','main:2');
 expect(duplicateGroups(c,"main").groups[0]).toMatchObject({suggested_keep:"main:2",suggested_because:"has quotes that cannot move"});
});
it("flags groups whose EPUB or PDF sizes differ by 10% or more",()=>{
 expect(sizeWarnings([{id:"main:100",sizes:{EPUB:357*1024}},{id:"main:783",sizes:{EPUB:6617*1024}}])[0]).toMatch(/^EPUB sizes differ 18\.5×: main:100 357 KB, main:783 6\.5 MB\./);
 expect(sizeWarnings([{id:"main:98",sizes:{EPUB:447*1024}},{id:"main:661",sizes:{EPUB:381*1024}}])).toEqual([expect.stringMatching(/^EPUB sizes differ by 17%: main:98 447 KB, main:661 381 KB\./)]);
 expect(sizeWarnings([{id:"main:106",sizes:{EPUB:1123}},{id:"main:814",sizes:{EPUB:1058}},{id:"main:9",sizes:{PDF:5}}])).toEqual([]);
 const db=new Database(path.join(root,"main/metadata.db"));
 db.exec("ALTER TABLE data ADD COLUMN uncompressed_size INTEGER; UPDATE data SET uncompressed_size=CASE book WHEN 1 THEN 1000000 ELSE 3000000 END");db.close();
 // The fixture's PDFs are the same file, so their contents explain the recorded gap.
 expect(duplicateGroups(c,"main").groups[0]).toMatchObject({size_warnings:[],content_notes:["PDF sizes differ, but the pages, text and bookmarks match: probably different image compression."]});
 expect(pair().fingerprint).toBeDefined();
});
it("compares the copies' contents, prefers the more complete one as keeper, and explains it, without changing fingerprints",async()=>{
 const db=new Database(path.join(root,"main/metadata.db"));
 for(const id of [1,2]){
  db.prepare("INSERT INTO data(book,format,name) VALUES(?,'EPUB','copy')").run(id);
  fs.writeFileSync(path.join(root,`main/Ann Author/The Same Book (${id})/copy.epub`),makeShapedEpub({images:30,pages:200}));
 }
 db.close();
 const before=pair().fingerprint,bookPrint=pair().books[1].fingerprint;
 // Copy 1 loses its figures and print pages in place: the same record, a weaker file.
 fs.writeFileSync(path.join(root,"main/Ann Author/The Same Book (1)/copy.epub"),makeShapedEpub({images:1,pages:0}));
 const g=duplicateGroups(c,"main").groups[0];
 expect(g).toMatchObject({suggested_keep:"main:2",suggested_because:"has the most complete contents"});
 expect(g.content_warnings.map(w=>[w.measure,w.against])).toEqual([["page_list",["main:1"]],["images",["main:1"]]]);
 expect(g.books.find(b=>b.id==="main:2")!.contents.EPUB).toMatchObject({images:30,page_list:200});
 expect(g.books[1].contents.EPUB).not.toHaveProperty("sketch");expect(g.content_overlap).toEqual({EPUB:{reference:"main:1",shared:{"main:2":1}},PDF:{reference:"main:1",shared:{"main:2":1}}});
 expect(g.books[0].contents.PDF).toMatchObject({pages:1});
 expect(pair().fingerprint).toBe(before);expect(pair().books[1].fingerprint).toBe(bookPrint);
 // The preview page gets the findings; the source gets only the plan.
 const sent:any[]=[];
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(_command,stdin)=>{sent.push(JSON.parse(stdin!));}});
 const job=await wait(r,r.start("duplicates","preview",{duplicates:[select("main:2",["main:1"])]}));
 expect(job.params.contents).toEqual({2:{warnings:g.content_warnings.map(w=>w.message),notes:[]}});
 expect(Object.keys(sent[0])).toEqual(["library","groups"]);
});
it("shows groups at once while the server reads their files, and refuses a preview until it has",async()=>{
 usePdfWorkers();
 try{
  const first=duplicateGroups(c,"main").groups[0];
  expect(first.contents_pending).toEqual(["PDF"]);
  expect(first.books[0].contents.PDF).toEqual({pending:true});
  expect(()=>duplicateContents(c,"main",["main:1"])).toThrow(/PDF contents of main:1's group are still being checked/);
  await profilesSettled();
  const done=duplicateGroups(c,"main").groups[0];
  expect(done.contents_pending).toEqual([]);
  expect(done.books[0].contents.PDF).toMatchObject({pages:1});
  expect(()=>duplicateContents(c,"main",["main:1"])).not.toThrow();
  // Saved in data.db: a restarted server doesn't read the files again.
  expect(c.data.prepare("SELECT COUNT(*) FROM file_profiles").pluck().get()).toBe(2);
 }finally{stopPdfWorkers();}
});
it("lets a record with only a tag proposal be trashed and moves the proposal to the keeper",async()=>{
 const propose=(uuid:string,id:string,status:string,tags:string[],approved:string[]|null=null)=>c.data.prepare("INSERT INTO tag_proposals(calibre_uuid,book_id,title,tags,rationale,status,approved_tags,proposed_at) VALUES(?,?,?,?,?,?,?,'now')").run(uuid,id,"The Same Book",JSON.stringify(tags),"why "+id,status,approved&&JSON.stringify(approved));
 propose("uuid-2","main:2","pending",["History"]);
 expect(duplicateGroups(c,"main").groups[0].suggested_because).not.toBe("has saved references");
 expect(plan().groups[0].remove).toEqual([{id:2,uuid:"uuid-2"}]);
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  const p=JSON.parse(stdin!);
  if(command==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"The Same Book",duplicate_review:{plan:{...p.groups[0],reviewed:"ok"},blockers:[]}})+'\n');
  else log('@@change '+JSON.stringify({calibre_id:1,uuid:"uuid-1",title:"The Same Book",duplicate_resolved:{removed_id:2,removed_uuid:"uuid-2",trash:true,backup:"b"}})+'\n');
 }});
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 expect((await wait(r,r.start("duplicates","apply",{previewOf:preview.id}))).status).toBe("succeeded");
 expect(c.data.prepare("SELECT calibre_uuid,book_id,status FROM tag_proposals").all()).toEqual([{calibre_uuid:"uuid-1",book_id:"main:1",status:"pending"}]);
 expect(c.data.prepare("SELECT detail, job_id FROM changes WHERE kind='proposal_moved'").get()).toEqual({detail:"moved from main:2",job_id:expect.any(Number)});
});
it("combines a moved tag proposal with the keeper's own",async()=>{
 const {moveTagProposal}=await import("../src/tagging.js");
 const propose=(uuid:string,id:string,status:string,tags:string[],approved:string[]|null=null)=>c.data.prepare("INSERT INTO tag_proposals(calibre_uuid,book_id,title,tags,rationale,status,approved_tags,proposed_at) VALUES(?,?,?,?,?,?,?,'now')").run(uuid,id,"Book",JSON.stringify(tags),"why "+id,status,approved&&JSON.stringify(approved));
 const to={uuid:"uuid-1",book_id:"main:1",title:"Book"};
 const row=()=>c.data.prepare("SELECT calibre_uuid,tags,approved_tags,status FROM tag_proposals").all();
 propose("uuid-1","main:1","approved",["History"],["History"]);propose("uuid-2","main:2","approved",["Ethics","History"],["Ethics"]);
 expect(moveTagProposal(c.data,"uuid-2",to)).toBe("combined");
 expect(row()).toEqual([{calibre_uuid:"uuid-1",tags:'["History","Ethics"]',approved_tags:'["History","Ethics"]',status:"approved"}]);
 propose("uuid-2","main:2","pending",["Law"]);
 expect(moveTagProposal(c.data,"uuid-2",to)).toBe("combined");
 expect(row()).toEqual([{calibre_uuid:"uuid-1",tags:'["History","Ethics","Law"]',approved_tags:null,status:"pending"}]);
 propose("uuid-2","main:2","rejected",["Art"]);
 expect(moveTagProposal(c.data,"uuid-2",to)).toBe("dropped");
 expect(row()).toHaveLength(1);
});
it("leaves a tag proposal in place when the source reports a duplicate it did not trash",async()=>{
 c.data.prepare("INSERT INTO tag_proposals(calibre_uuid,book_id,title,tags,rationale,status,proposed_at) VALUES('uuid-2','main:2','Book','[\"History\"]','why','pending','now')").run();
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  const p=JSON.parse(stdin!);
  if(command==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"Book",duplicate_review:{plan:{...p.groups[0],reviewed:"ok"},blockers:[]}})+'\n');
  else log('@@change '+JSON.stringify({calibre_id:1,uuid:"uuid-1",title:"Book",duplicate_resolved:{removed_id:2,removed_uuid:"uuid-2",trash:false,backup:"b"}})+'\n');
 }});
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 await wait(r,r.start("duplicates","apply",{previewOf:preview.id}));
 expect(c.data.prepare("SELECT calibre_uuid FROM tag_proposals").pluck().all()).toEqual(["uuid-2"]);
});
it("moves a trashed duplicate's citekey and Zotero links to the keeper after Calibre trashes it",async()=>{
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','same2021book','main:2','The Same Book','now')").run();
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,calibre_uuid,trashed,replaces,synced_at) VALUES('FILED',1,'book','The Same Book','uuid-2',0,'[]','now')").run();
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,trashed,replaces,synced_at) VALUES('WRONG',1,'book','Another',0,'[]','now')").run();
 c.data.prepare("INSERT INTO zotero_links(calibre_uuid,zotero_key,status,linked_at) VALUES('uuid-2','WRONG','rejected','now')").run();
 const g=duplicateGroups(c,"main").groups[0];
 expect(g.books.find(b=>b.id==="main:2")!.filing).toEqual({citekey:"same2021book",zotero:"FILED",stranded:null});
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  const p=JSON.parse(stdin!);
  if(command==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"The Same Book",duplicate_review:{plan:{...p.groups[0],reviewed:"ok"},blockers:[]}})+'\n');
  else log('@@change '+JSON.stringify({calibre_id:1,uuid:"uuid-1",title:"The Same Book",duplicate_resolved:{removed_id:2,removed_uuid:"uuid-2",trash:true,backup:"b"}})+'\n');
 }});
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 expect((await wait(r,r.start("duplicates","apply",{previewOf:preview.id}))).status).toBe("succeeded");
 expect(c.data.prepare("SELECT calibre_uuid,citekey,book_id FROM citekeys").all()).toEqual([{calibre_uuid:"uuid-1",citekey:"same2021book",book_id:"main:1"}]);
 expect(c.data.prepare("SELECT calibre_uuid,zotero_key,status FROM zotero_links ORDER BY zotero_key").all()).toEqual([
  {calibre_uuid:"uuid-1",zotero_key:"FILED",status:"confirmed"},{calibre_uuid:"uuid-1",zotero_key:"WRONG",status:"rejected"}]);
 expect(zoteroMatch(c,getBook(c,"main:1")).match).toMatchObject({key:"FILED",matched_by:"confirmed"});
 expect(c.data.prepare("SELECT detail FROM changes WHERE kind='filing_moved' ORDER BY id").pluck().all()).toEqual(["citekey same2021book from main:2","Zotero item FILED from main:2"]);
});
it("blocks moving filing onto a keeper cited differently",()=>{
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','first2020book','main:2','B','now')").run();
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-1','second2021book','main:1','B','now')").run();
 expect(()=>plan()).toThrow(/cited as first2020book and main:1 as second2021book/);
 expect(()=>plan({...select(),same_edition:true})).toThrow(/different editions/);
});
it("blocks a Zotero filing whose item is in Zotero's trash with no survivor",()=>{
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,calibre_uuid,trashed,replaces,synced_at) VALUES('GONE',1,'book','Gone','uuid-2',1,'[]','now')").run();
 expect(()=>plan()).toThrow(/GONE, which is in Zotero's trash/);
 expect(duplicateGroups(c,"main").groups[0].books.find(b=>b.id==="main:2")!.filing).toMatchObject({stranded:"GONE"});
});
it("never promotes a Zotero item rejected for the trashed record",async()=>{
 const {moveDuplicateFiling}=await import("../src/duplicates.js");
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,calibre_uuid,trashed,replaces,synced_at) VALUES('NOPE',1,'book','Wrong','uuid-2',0,'[]','now')").run();
 c.data.prepare("INSERT INTO zotero_links(calibre_uuid,zotero_key,status,linked_at) VALUES('uuid-2','NOPE','rejected','now')").run();
 expect(plan().groups[0].remove).toEqual([{id:2,uuid:"uuid-2"}]);
 expect(moveDuplicateFiling(c,"uuid-2","main:2",{uuid:"uuid-1",book_id:"main:1",title:"B"})).toEqual([]);
 expect(c.data.prepare("SELECT calibre_uuid,zotero_key,status FROM zotero_links").all()).toEqual([{calibre_uuid:"uuid-1",zotero_key:"NOPE",status:"rejected"}]);
});
it("accepts only a boolean same-edition confirmation",()=>{
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','k2020','main:2','B','now')").run();
 differentFiles();
 expect(()=>plan({...select(),same_edition:"false" as any})).toThrow(/true or false/);
 expect(()=>plan({...select(),same_edition:false})).toThrow(/same edition/);
});
it("ranks only stored filing, not an ISBN match, as filed",()=>{
 c.data.prepare("INSERT INTO zotero_items(key,version,item_type,title,trashed,replaces,synced_at) VALUES('BYISBN',1,'book','The Same Book',0,'[]','now')").run();
 c.data.prepare("INSERT INTO zotero_isbns(isbn,key) VALUES('9780306406157','BYISBN')").run();
 c.db.prepare("UPDATE books SET isbn='9780306406157' WHERE id='main:2'").run();
 expect(zoteroMatch(c,getBook(c,"main:2")).match).toMatchObject({matched_by:"isbn"});
 expect(duplicateGroups(c,"main").groups[0].suggested_because).not.toBe("is filed with a citekey or in Zotero");
});
const mergeRunner=()=>new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
 const p=JSON.parse(stdin!);
 if(command==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"The Same Book",duplicate_review:{plan:{...p.groups[0],reviewed:"ok"},blockers:[]}})+'\n');
 else log('@@change '+JSON.stringify({calibre_id:1,uuid:"uuid-1",title:"The Same Book",duplicate_resolved:{removed_id:2,removed_uuid:"uuid-2",trash:true,backup:"b"}})+'\n');
}});
it("re-anchors a trashed duplicate's quotes in the keeper and leaves an alias for its UUID",async()=>{
 const {verifyPassage}=await import("../src/anchors.js");const {resolveUuid,aliasesOf}=await import("../src/data.js");
 anchor('uuid-2','main:2');
 const g=duplicateGroups(c,"main").groups[0];
 expect(g.books.find(b=>b.id==="main:2")!.anchor_moves).toEqual({"main:1":{moves:1,orphaned:0,review:[]}});
 const r=mergeRunner();
 const preview=await wait(r,r.start("duplicates","preview",{duplicates:[select()]}));
 expect((await wait(r,r.start("duplicates","apply",{previewOf:preview.id}))).status).toBe("succeeded");
 expect(c.data.prepare("SELECT calibre_uuid,book_id,status,text,start_offset FROM anchors").all()).toEqual([{calibre_uuid:"uuid-1",book_id:"main:1",status:"verified",text:"A syn",start_offset:0}]);
 const change=c.data.prepare("SELECT kind,status,anchor FROM anchor_changes ORDER BY seq DESC LIMIT 1").get() as any;
 expect(change).toMatchObject({kind:"reanchored",status:"verified"});expect(JSON.parse(change.anchor).calibre_uuid).toBe("uuid-1");
 expect(c.data.prepare("SELECT detail FROM changes WHERE kind='quotes_moved'").pluck().get()).toBe("1 re-anchored from main:2");
 expect(resolveUuid(c.data,"UUID-2")).toBe("uuid-1");expect(aliasesOf(c.data,"uuid-1")).toEqual(["uuid-2"]);
 // After the refresh drops the trashed record, its UUID still reaches the keeper.
 c.db.prepare("DELETE FROM books WHERE id='main:2'").run();
 const answer=verifyPassage(c,{excludeTags:[]},{book:"uuid-2",text:"A synthetic book"});
 expect(answer.body).toMatchObject({match:true,book:{calibre_uuid:"uuid-1",former_uuids:["uuid-2"]}});
});
it("blocks a merge when a quote's wording is missing from, or repeated in, the keeper",()=>{
 anchor('uuid-2','main:2');
 const text=c.db.prepare("SELECT text FROM pages WHERE book_id='main:1' AND page_index=0").pluck().get() as string;
 c.db.prepare("UPDATE pages SET text=? WHERE book_id='main:1' AND page_index=0").run("Different words entirely");
 expect(()=>plan()).toThrow(/main:2 has 1 quote that cannot be placed in main:1: quote 1 \(its wording is not in the keeper's text\)/);
 expect(duplicateGroups(c,"main").groups[0].books.find(b=>b.id==="main:2")!.anchor_moves!["main:1"].review).toEqual([{quote_id:1,reason:"wording-not-found"}]);
 c.db.prepare("UPDATE pages SET text=? WHERE book_id='main:1' AND page_index=0").run(text+" "+text);
 expect(()=>plan()).toThrow(/occurs more than once/);
 // The other way round is unaffected: main:2 keeps its quote as the keeper.
 expect(plan(select("main:2",["main:1"])).groups[0].remove).toEqual([{id:1,uuid:"uuid-1"}]);
});
it("carries a lost anchor to the keeper for the next scan to find",async()=>{
 const {moveAnchors}=await import("../src/anchors.js");
 anchor('uuid-2','main:2');c.data.prepare("UPDATE anchors SET status='orphaned'").run();
 expect(plan().groups[0].remove).toEqual([{id:2,uuid:"uuid-2"}]);
 expect(moveAnchors(c,"uuid-2",getBook(c,"main:1"))).toEqual({moved:0,orphaned:1});
 expect(c.data.prepare("SELECT calibre_uuid,status,sha256 FROM anchors").all()).toEqual([{calibre_uuid:"uuid-1",status:"orphaned",sha256:null}]);
});
it("re-points older aliases when their keeper is merged in turn",async()=>{
 const {recordAlias,resolveUuid,aliasesOf}=await import("../src/data.js");
 recordAlias(c.data,{old_uuid:"uuid-9",uuid:"uuid-2",reason:"duplicate_merged"});
 recordAlias(c.data,{old_uuid:"uuid-2",uuid:"uuid-1",reason:"duplicate_merged"});
 expect(resolveUuid(c.data,"uuid-9")).toBe("uuid-1");expect(aliasesOf(c.data,"uuid-1").sort()).toEqual(["uuid-2","uuid-9"]);
 expect(resolveUuid(c.data,"uuid-1")).toBe("uuid-1");
});
it("records what a metadata job wrote to Calibre as sync baselines",async()=>{
 const r=new JobRunner(c,config,{refresh:async()=>{c.db.prepare("UPDATE books SET title='The Same Book, Revised' WHERE id='main:1'").run();},calibre:async(command,stdin,log)=>{
  const b=JSON.parse(stdin!).books[0];
  if(command==="metadata-apply")log('@@change '+JSON.stringify({calibre_id:b.calibre_id,uuid:b.uuid,title:b.after.title,metadata:{before:b.before,after:b.after}})+'\n');
 }});
 const job=await wait(r,r.start("metadata","apply",{metadata:{book_id:"main:1",title:"The Same Book, Revised",authors:["Ann Author"],year:2020,before:{title:"The Same Book",authors:["Ann Author"],year:2020}}}));
 expect(job.status).toBe("succeeded");
 expect(c.data.prepare("SELECT surface,field,value,job_id FROM sync_baselines WHERE calibre_uuid='uuid-1' ORDER BY field").all()).toEqual([
  {surface:"calibre",field:"authors",value:'["Ann Author"]',job_id:job.id},{surface:"calibre",field:"title",value:'"The Same Book, Revised"',job_id:job.id},{surface:"calibre",field:"year",value:"2020",job_id:job.id}]);
});
it("records the tags a tag job leaves on a book as its sync baseline",async()=>{
 c.data.prepare("INSERT INTO tag_proposals(calibre_uuid,book_id,title,tags,rationale,status,approved_tags,proposed_at) VALUES('uuid-1','main:1','The Same Book','[\"social-sciences.sociology\"]','why','approved','[\"social-sciences.sociology\"]','now')").run();
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  for(const b of JSON.parse(stdin!).books)log('@@change '+JSON.stringify({calibre_id:b.calibre_id,uuid:b.uuid,title:b.title,added:b.add??[],removed:b.remove??[]})+'\n');
 }});
 const preview=await wait(r,r.start("tags","preview"));
 const job=await wait(r,r.start("tags","apply",{previewOf:preview.id}));
 expect(job.status).toBe("succeeded");
 const before=JSON.parse(c.db.prepare("SELECT tags FROM books WHERE id='main:1'").pluck().get() as string) as string[];
 expect(c.data.prepare("SELECT value FROM sync_baselines WHERE calibre_uuid='uuid-1' AND surface='calibre' AND field='tags'").pluck().get())
  .toBe(JSON.stringify([...new Set([...before,"social-sciences.sociology"])].sort((a,b)=>a.localeCompare(b))));
});
