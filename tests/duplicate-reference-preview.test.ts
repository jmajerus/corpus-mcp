import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import { tempDir } from "./fixtures.js";
let root:string,web:Database;
beforeEach(()=>{
 root=tempDir();new Database(path.join(root,'metadata.db')).close();
 web=new Database(path.join(root,'web.db'));
 // Calibre-Web's own columns for these tables.
 web.exec(`CREATE TABLE shelf(id INTEGER PRIMARY KEY,name TEXT,is_public INTEGER,last_modified DATETIME);
 CREATE TABLE book_shelf_link(id INTEGER PRIMARY KEY,book_id INTEGER,"order" INTEGER,shelf INTEGER,date_added DATETIME);
 CREATE TABLE bookmark(book_id INTEGER);
 INSERT INTO shelf VALUES(1,'Main',1,'2026-01-01 00:00:00'),(2,'Private subject',0,'2026-01-01 00:00:00'),(3,'Peace Studies',1,'2026-01-01 00:00:00');
 INSERT INTO book_shelf_link(book_id,"order",shelf,date_added) VALUES(116,1,1,'2025-06-09'),(127,7,1,'2026-11-12'),(127,3,2,'2026-11-12'),(127,5,3,'2026-11-12');`);
});
afterEach(()=>{web.close();fs.rmSync(root,{recursive:true,force:true});});
function call(fn:string,body?:string){
 const script=`import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('duplicates',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2])
${body ?? `print(json.dumps(module.${fn}))`}`;
 const r=spawnSync('python3',['-B','-c',script,path.resolve('tools/calibre-duplicates.py'),root],{encoding:'utf8'});
 expect(r.status,r.stderr).toBe(0);return JSON.parse(r.stdout);
}
const inspect=()=>call("reference_blockers(root,root/'web.db',116,127)") as string[];
const links=()=>web.prepare('SELECT book_id,"order",shelf,date_added FROM book_shelf_link ORDER BY shelf,book_id').all();
it('treats shelf links as moves, naming public shelves and hiding private names',()=>{
 const before=fs.readFileSync(path.join(root,'web.db'));
 expect(inspect()).toEqual([]);
 expect(call("shelf_plan(root/'web.db',116,[127])")).toEqual([
  {shelf:'“Main”',duplicate:127,action:'drop'},{shelf:'a private shelf',duplicate:127,action:'move'},{shelf:'“Peace Studies”',duplicate:127,action:'move'}]);
 expect(fs.readFileSync(path.join(root,'web.db'))).toEqual(before);
});
const move=(removes:string)=>call('',`with module.calibre_web_write(root/'web.db') as web:
    print(json.dumps(module.move_shelves(web,116,${removes})))`);
it('moves the duplicate’s shelf links to the keeper in place, drops redundant ones, and touches each shelf',()=>{
 expect(move('[127]')).toEqual([
  {shelf:'“Main”',duplicate:127,action:'dropped'},{shelf:'a private shelf',duplicate:127,action:'moved'},{shelf:'“Peace Studies”',duplicate:127,action:'moved'}]);
 expect(links()).toEqual([
  {book_id:116,order:1,shelf:1,date_added:'2025-06-09'},{book_id:116,order:3,shelf:2,date_added:'2026-11-12'},{book_id:116,order:5,shelf:3,date_added:'2026-11-12'}]);
 expect(web.prepare("SELECT count(*) FROM shelf WHERE last_modified > '2026-01-01 00:00:00'").pluck().get()).toBe(3);
 expect(move('[127]')).toEqual([]);
});
it('keeps only the first of two duplicates’ links to one shelf, in the preview and the apply alike',()=>{
 web.exec(`INSERT INTO book_shelf_link(book_id,"order",shelf,date_added) VALUES(130,9,3,'2026-11-13')`);
 expect(call("shelf_plan(root/'web.db',116,[127,130])").filter((s:any)=>s.shelf==='“Peace Studies”')).toEqual([
  {shelf:'“Peace Studies”',duplicate:127,action:'move'},{shelf:'“Peace Studies”',duplicate:130,action:'drop'}]);
 expect(move('[127,130]').filter((s:any)=>s.shelf==='“Peace Studies”')).toEqual([
  {shelf:'“Peace Studies”',duplicate:127,action:'moved'},{shelf:'“Peace Studies”',duplicate:130,action:'dropped'}]);
 expect(web.prepare('SELECT book_id,"order" FROM book_shelf_link WHERE shelf=3').all()).toEqual([{book_id:116,order:5}]);
});
it('rolls the shelf moves back when the trash fails inside the lock',()=>{
 const before=links();
 const out=call('',`try:
    with module.calibre_web_write(root/'web.db') as web:
        module.move_shelves(web,116,[127])
        raise OSError('trash failed')
except OSError as error:
    print(json.dumps(str(error)))`);
 expect(out).toBe('trash failed');expect(links()).toEqual(before);
});
it('reports remaining references after shelf membership is cleared, including orphaned links',()=>{
 web.exec('DELETE FROM book_shelf_link; INSERT INTO book_shelf_link(book_id,shelf) VALUES(127,99); INSERT INTO bookmark VALUES(127);');
 const blockers=inspect();expect(blockers.some(b=>b.includes('orphaned shelf'))).toBe(true);expect(blockers.some(b=>b.includes('bookmarks'))).toBe(true);
});
it('fails closed with an actionable blocker when the Calibre-Web database is unavailable',()=>{
 fs.renameSync(path.join(root,'web.db'),path.join(root,'held.db'));
 expect(inspect()).toEqual(['Calibre-Web reference database is unavailable. Restore access before resolving this pair.']);
});
it('blocks on any other Calibre-Web link to the duplicate',()=>{
 expect(inspect()).toEqual([]);
 web.exec('INSERT INTO bookmark VALUES(127);');expect(inspect()[0]).toContain('bookmarks');
});

const g=(keep:number,remove:number[])=>({keep:{id:keep,uuid:'u'+keep},remove:remove.map(id=>({id,uuid:'u'+id})),discard_conflicts:false});
it.each(['{}','null','{"groups":[]}','{"groups":[{"discard_conflicts":true}]}','{"groups":[{"discard_conflicts":true,"keep":null,"remove":[]}]}',
 JSON.stringify({groups:[{...g(1,[]),remove:[]}]}),JSON.stringify({groups:[g(1,[2]),g(3,[2])]}),JSON.stringify({groups:[g(1,[1])]}),'not JSON'])('reports an invalid review plan concisely: %s',input=>{
 const result=spawnSync('python3',['-B',path.resolve('tools/calibre-duplicates.py'),root,path.join(root,'web.db')],{input,encoding:'utf8'});
 expect(result.status).toBe(1);expect(result.stderr.trim()).toMatch(/at least one duplicate group|Review conflicting formats|Invalid book identity|only once in a batch|valid JSON/);
 expect(result.stderr).not.toContain('Traceback');
});

it.each(['KeyError','TypeError','OSError','ValueError','sqlite3.OperationalError'])('preserves the traceback for an unexpected %s',type=>{
 const script=`import json,runpy,sys,sqlite3
original=sys.argv[1]
def fault(*args,**kwargs):raise ${type}('injected unexpected failure')
json.load=fault
sys.argv=[original,sys.argv[2],sys.argv[3]]
runpy.run_path(original,run_name='__main__')`;
 const result=spawnSync('python3',['-B','-c',script,path.resolve('tools/calibre-duplicates.py'),root,path.join(root,'web.db')],{encoding:'utf8'});
 expect(result.status).not.toBe(0);expect(result.stderr).toContain('Traceback');
 expect(result.stderr).toContain(type+':');expect(result.stderr).toContain('injected unexpected failure');
});
