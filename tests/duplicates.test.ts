import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { openDataStore } from "../src/data.js";
import { scanLibraries } from "../src/indexer.js";
import { zoteroMatch } from "../src/zotero.js";
import { type Corpus, getBook } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { duplicatePairs, duplicatePlan, dismissDuplicate, duplicateCandidates, duplicateReferences } from "../src/duplicates.js";
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
function select(){return {keep:"main:1",remove:"main:2",fingerprint:pair().fingerprint};}
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
 let p=pair();dismissDuplicate(c,"main",p.books.map(b=>b.id),p.fingerprint,false,"reviewer");
 expect(duplicatePairs(c,"main").total).toBe(0);expect(duplicatePairs(c,"main",true).pairs[0].dismissed).toBe(true);
 dismissDuplicate(c,"main",p.books.map(b=>b.id),p.fingerprint,true);expect(duplicatePairs(c,"main").total).toBe(1);
 dismissDuplicate(c,"main",p.books.map(b=>b.id),p.fingerprint,false);
 c.db.prepare("UPDATE books SET year=2022 WHERE id='main:2'").run();expect(duplicatePairs(c,"main").total).toBe(1);
 expect(()=>duplicatePlan(c,"main",{...select(),fingerprint:p.fingerprint})).toThrow(/changed/);
});
it("blocks referenced records and cross-library resolution without moving any links",()=>{
 const p=pair();c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','saved2021book','main:2','The Same Book','now')").run();
 expect(()=>duplicatePlan(c,"main",{...select()})).toThrow(/saved references/);
 expect(()=>duplicatePlan(c,"other",{...select()})).toThrow(/writable/);
 expect(c.data.prepare("SELECT count(*) FROM citekeys").pluck().get()).toBe(1);
 expect(()=>dismissDuplicate(c,"main",["main:1","main:3"],p.fingerprint,false)).toThrow(/changed/);
});
async function wait(r:JobRunner,id:number){for(let i=0;i<100;i++){if(r.get(id).status!=="running"){await new Promise(done=>setTimeout(done,0));return r.get(id);}await new Promise(done=>setTimeout(done,5));}throw new Error("Job did not finish");}
it("applies the source-reviewed plan, audits resolution, refreshes and releases the write pause",async()=>{
 let refreshes=0;const calls:any[]=[];
 const commands:JobCommands={refresh:async()=>{refreshes++;},calibre:async(command,stdin,log)=>{
  const plan=JSON.parse(stdin!);calls.push({command,plan});
  if(command==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"The Same Book",duplicate_review:{plan:{...plan,reviewed:"source-hash"},blockers:[]}})+'\n');
  else {expect(c.writesPaused).toBeTruthy();log('@@change '+JSON.stringify({calibre_id:1,title:"The Same Book",duplicate_resolved:{removed_id:2,removed_uuid:"uuid-2",trash:true,backup:"saved.db"}})+'\n');}
 }};
 const r=new JobRunner(c,config,commands);
 expect(()=>r.start("duplicates","apply")).toThrow(/Preview first/);
 const preview=await wait(r,r.start("duplicates","preview",{duplicate:select()}));
 const result=await wait(r,r.start("duplicates","apply",{previewOf:preview.id}));
 expect(result.status).toBe("succeeded");expect(calls[1].plan.reviewed).toBe("source-hash");expect(refreshes).toBe(1);expect(c.writesPaused).toBeUndefined();
 expect(c.data.prepare("SELECT count(*) FROM changes WHERE kind='duplicate_resolved'").pluck().get()).toBe(1);
});
it("refuses newly referenced duplicates after preview and previews with source blockers",async()=>{
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{log('@@change '+JSON.stringify({calibre_id:1,title:"Book",duplicate_review:{plan:{...JSON.parse(stdin!),reviewed:"source"},blockers:[]}})+'\n');}});
 const preview=await wait(r,r.start("duplicates","preview",{duplicate:select()}));
 c.data.prepare("INSERT INTO citekeys(calibre_uuid,citekey,book_id,title,pinned_at) VALUES('uuid-2','newkey','main:2','Book','now')").run();
 expect(()=>r.start("duplicates","apply",{previewOf:preview.id})).toThrow(/saved references/);
});
it("refreshes after a failed source write and keeps the job failed",async()=>{
 let refreshed=0;
 const r=new JobRunner(c,config,{refresh:async()=>{refreshed++;},calibre:async(cmd,stdin,log)=>{
  if(cmd==="duplicates-preview")log('@@change '+JSON.stringify({calibre_id:1,title:"Book",duplicate_review:{plan:{...JSON.parse(stdin!),reviewed:"source"},blockers:[]}})+'\n');
  else {log('@@change '+JSON.stringify({calibre_id:1,title:"Book",added_format:"EPUB",source_format:"duplicate"})+'\n');throw new Error("Injected write failure");}
 }});
 const preview=await wait(r,r.start("duplicates","preview",{duplicate:select()}));
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
 expect(()=>duplicatePlan(c,'main',select())).toThrow(/saved references/);
});

it("rechecks Zotero UUID references added after a successful source preview",async()=>{
 const calls:string[]=[];
 const r=new JobRunner(c,config,{refresh:async()=>{},calibre:async(command,stdin,log)=>{
  calls.push(command);log('@@change '+JSON.stringify({calibre_id:1,title:'Book',duplicate_review:{plan:{...JSON.parse(stdin!),reviewed:'source'},blockers:[]}})+'\n');
 }});
 const preview=await wait(r,r.start('duplicates','preview',{duplicate:select()}));
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
  calls.push(command);log('@@change '+JSON.stringify({calibre_id:1,title:'Book',duplicate_review:{plan:{...JSON.parse(stdin!),reviewed:'source'},blockers:['Calibre-Web shelf Main contains the duplicate. Remove its membership first.','Retain the keeper format.']}})+'\n');
 }});
 const preview=await wait(r,r.start('duplicates','preview',{duplicate:select()}));
 expect(preview.status).toBe('succeeded');expect(preview.items[0].duplicate_review?.blockers).toHaveLength(2);
 expect(()=>r.start('duplicates','apply',{previewOf:preview.id})).toThrow(/Resolve the blockers/);
 expect(calls).toEqual(['duplicates-preview']);
});
