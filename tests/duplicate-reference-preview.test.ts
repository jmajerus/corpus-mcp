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
 web.exec(`CREATE TABLE shelf(id INTEGER PRIMARY KEY,name TEXT,is_public INTEGER);
 CREATE TABLE book_shelf_link(shelf INTEGER,book_id INTEGER);
 CREATE TABLE bookmark(book_id INTEGER);
 INSERT INTO shelf VALUES(1,'Main',1),(2,'Private subject',0);
 INSERT INTO book_shelf_link VALUES(1,116),(1,127),(2,127);`);
});
afterEach(()=>{web.close();fs.rmSync(root,{recursive:true,force:true});});
function inspect(){
 const script=`import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('duplicates',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2]);print(json.dumps(module.reference_blockers(root,root/'web.db',116,127)))`;
 const r=spawnSync('python3',['-B','-c',script,path.resolve('tools/calibre-duplicates.py'),root],{encoding:'utf8'});
 expect(r.status,r.stderr).toBe(0);return JSON.parse(r.stdout) as string[];
}
it('names public shelves and gives the correct keeper-specific action while hiding private names',()=>{
 const before=fs.readFileSync(path.join(root,'web.db'));
 const blockers=inspect();
 expect(blockers).toHaveLength(2);
 expect(blockers[0]).toContain('shelf “Main”');expect(blockers[0]).toContain('Keeper 116 already belongs');
 expect(blockers[0]).toContain('clean up its shelf links automatically');
 expect(blockers[0]).not.toContain('Remove only duplicate 127 from that shelf');
 expect(blockers[1]).toContain('private shelf');expect(blockers[1]).toContain('Add keeper 116');
 expect(JSON.stringify(blockers)).not.toContain('Private subject');
 expect(fs.readFileSync(path.join(root,'web.db'))).toEqual(before);
});
it('reports remaining references after shelf membership is cleared, including orphaned links',()=>{
 web.exec('DELETE FROM book_shelf_link; INSERT INTO book_shelf_link VALUES(99,127); INSERT INTO bookmark VALUES(127);');
 const blockers=inspect();expect(blockers.some(b=>b.includes('orphaned shelf'))).toBe(true);expect(blockers.some(b=>b.includes('bookmarks'))).toBe(true);
});
it('fails closed with an actionable blocker when the Calibre-Web database is unavailable',()=>{
 fs.renameSync(path.join(root,'web.db'),path.join(root,'held.db'));
 expect(inspect()).toEqual(['Calibre-Web reference database is unavailable. Restore access before resolving this pair.']);
});
it('clears blockers only when all removed-book references are resolved',()=>{
 web.exec('DELETE FROM book_shelf_link WHERE book_id=127;');expect(inspect()).toEqual([]);
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
