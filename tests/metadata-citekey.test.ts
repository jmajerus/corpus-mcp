import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { JobRunner } from "../src/jobs.js";
import { loadConfig, type Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { openDataStore, pinnedByUuid } from "../src/data.js";
import { scanLibraries } from "../src/indexer.js";
import { type Corpus, getBook, pinCitekey } from "../src/tools.js";
import { Vocabulary } from "../src/vocabulary.js";
import { completeMetadataCitekey } from "../src/metadata-repair.js";
import { makeLibrary, makePdf, tempDir } from "./fixtures.js";
let root:string,c:Corpus,config:Config;
const reviewed={calibre_id:1,uuid:'uuid-1',title:'Old',before:{title:'Old',authors:['Unknown'],year:null},after:{title:'Corrected Alpha',authors:['Ann Author'],year:2024}};
beforeEach(()=>{
 root=tempDir();const pdf=makePdf({pages:[['Synthetic correction test']]});
 makeLibrary(root,'main',[{id:1,title:reviewed.after.title,authors:reviewed.after.authors,pubdate:'2024-01-01',files:{pdf}},{id:2,title:'Beta',authors:['Other Writer'],pubdate:'2022-01-01',files:{pdf}}]);
 config=loadConfig({CORPUS_BOOKS_ROOT:root,CORPUS_LIBRARIES:'main',CORPUS_DB:path.join(root,'corpus.db'),CORPUS_DATA_DB:path.join(root,'data.db')});
 c={db:openDatabase(config.dbPath),data:openDataStore(config.dataDbPath),booksRoot:root,vocabulary:new Vocabulary(JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'vocabulary.json'),'utf8')))};scanLibraries(config,c.db);
});
afterEach(()=>{c.db.close();c.data.close();fs.rmSync(root,{recursive:true,force:true});});
it('pins the refreshed derived key and attributes its audit to the same correction job',()=>{
 const key=getBook(c,'main:1').proposed_citekey!;
 expect(completeMetadataCitekey(c,'main',reviewed,'person',42)).toContain('Pinned derived citekey '+key);
 expect(pinnedByUuid(c.data,'uuid-1')).toMatchObject({citekey:key,pinned_by:'person'});
 expect(c.data.prepare("SELECT source,job_id,actor FROM changes WHERE kind='citekey_pinned'").get()).toEqual({source:'admin-job',job_id:42,actor:'person'});
});
it.each(['pin','calibre'])('preserves an existing assigned %s key',type=>{
 if(type==='pin')pinCitekey(c,{book_id:'main:1',citekey:'ExternalKey'},'owner');else c.db.prepare("UPDATE books SET calibre_citekey='externalkey' WHERE id='main:1'").run();
 const before=c.data.prepare("SELECT count(*) FROM changes").pluck().get();
 expect(completeMetadataCitekey(c,'main',reviewed)).toMatch(/Kept existing citekey/i);
 expect(c.data.prepare("SELECT count(*) FROM changes").pluck().get()).toBe(before);
});
it.each(['proposed','calibre','pinned'])('does not claim a key conflicting with another book’s %s key',type=>{
 const key=getBook(c,'main:1').proposed_citekey!;
 if(type==='pinned')pinCitekey(c,{book_id:'main:2',citekey:key.toUpperCase()});
 else c.db.prepare(`UPDATE books SET ${type==='calibre'?'calibre_citekey':'proposed_citekey'}=? WHERE id='main:2'`).run(key.toUpperCase());
 expect(completeMetadataCitekey(c,'main',reviewed)).toContain('Citekey needs review');expect(pinnedByUuid(c.data,'uuid-1')).toBeUndefined();
});
it.each(['uuid','title','authors','year'])('refuses a stale refreshed %s before pinning',field=>{
 const value=field==='year'?2020:field==='authors'?'["Other Author"]':'different';
 c.db.prepare(`UPDATE books SET ${field}=? WHERE id='main:1'`).run(value);
 expect(()=>completeMetadataCitekey(c,'main',reviewed)).toThrow(/refresh did not confirm/);expect(pinnedByUuid(c.data,'uuid-1')).toBeUndefined();
});
it('leaves incomplete metadata unpinned',()=>{
 c.db.prepare("UPDATE books SET year=NULL WHERE id='main:1'").run();
 expect(completeMetadataCitekey(c,'main',{...reviewed,after:{...reviewed.after,year:null}})).toContain('Citekey needs review');expect(pinnedByUuid(c.data,'uuid-1')).toBeUndefined();
});


it.each(['source','refresh','stale-index'])('does not pin when the correction job fails at %s',async phase=>{
 const b=getBook(c,'main:1');
 const runner=new JobRunner(c,config,{
  calibre:async command=>{if(command==='metadata-apply'&&phase==='source')throw new Error('Source write failed');},
  refresh:async()=>{if(phase==='refresh')throw new Error('Refresh failed');},
 });
 const id=runner.start('metadata','apply',{metadata:{book_id:b.id,title:'Next title',authors:['Ann Author'],year:2025,before:{title:b.title,authors:JSON.parse(b.authors),year:b.year}}},'person');
 for(let i=0;i<100&&runner.get(id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,5));
 expect(runner.get(id).status).toBe('failed');expect(pinnedByUuid(c.data,'uuid-1')).toBeUndefined();
 expect(c.data.prepare("SELECT count(*) FROM changes WHERE kind='citekey_pinned'").pluck().get()).toBe(0);
});
