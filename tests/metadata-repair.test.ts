import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { tempDir } from "./fixtures.js";

let root: string, library: string, plan: any;
beforeEach(() => {
 root=tempDir();library=path.join(root,"main");fs.mkdirSync(library);
 const db=new Database(path.join(library,"metadata.db"));
 db.exec(`CREATE TABLE books(id INTEGER PRIMARY KEY,uuid TEXT,title TEXT,comment TEXT,pubdate TEXT,path TEXT);CREATE TABLE data(book INTEGER,format TEXT,name TEXT);CREATE TABLE authors(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE books_authors_link(id INTEGER PRIMARY KEY,book INTEGER,author INTEGER);
 INSERT INTO books VALUES(1,'uuid-1','awscloudprojects','keep this comment',NULL,'book');INSERT INTO authors VALUES(1,'Unknown');INSERT INTO books_authors_link VALUES(1,1,1);`);db.close();fs.mkdirSync(path.join(library,"book"));fs.writeFileSync(path.join(library,"book","notes.txt"),"extra data");
 plan={library:"main",books:[{calibre_id:1,uuid:"uuid-1",title:"awscloudprojects",before:{title:"awscloudprojects",authors:["Unknown"],year:null},after:{title:"AWS Cloud Projects",authors:["Ivo Pinto","Pedro Santos"],year:2024}}]};
 fs.writeFileSync(path.join(root,"calibre-debug"),`#!/usr/bin/env python3
import sys,sqlite3,json,pathlib
args=sys.argv[1:]
plan=json.load(sys.stdin)
pathlib.Path(${JSON.stringify(path.join(root,"calls.json"))}).write_text(json.dumps(plan))
lib=args[-1]
book=plan['books'][0]
db=sqlite3.connect(lib+'/metadata.db')
db.execute('UPDATE books SET title=? WHERE id=1',(book['after']['title'],))
if book['after']['year'] != book['before']['year']:
 db.execute('UPDATE books SET pubdate=? WHERE id=1',(str(book['after']['year'])+'-01-01T12:00:00+00:00' if book['after']['year'] is not None else None,))
db.execute('DELETE FROM books_authors_link WHERE book=1')
for name in book['after']['authors']:
 cur=db.execute('INSERT INTO authors(name) VALUES(?)',(name.replace(',','|'),))
 db.execute('INSERT INTO books_authors_link(book,author) VALUES(1,?)',(cur.lastrowid,))
db.commit()
`,{mode:0o755});
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
const run=(apply=false)=>spawnSync('python3',[path.resolve('tools/calibre-metadata.py'),...(apply?['--apply']:[]),library],{input:JSON.stringify(plan),encoding:'utf8',env:{...process.env,CALIBRE_BIN:root}});

it('previews without writing and applies only the reviewed fields with a consistent backup',()=>{
 expect(run().status).toBe(0);expect(fs.existsSync(path.join(root,'calls.json'))).toBe(false);
 const result=run(true);expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('@@change');
 const db=new Database(path.join(library,'metadata.db'));expect(db.prepare('SELECT title,comment FROM books').get()).toEqual({title:'AWS Cloud Projects',comment:'keep this comment'});db.close();
 const backups=fs.readdirSync(library).filter(f=>f.startsWith('metadata.db.before-metadata-')&&!f.endsWith('.files'));expect(backups).toHaveLength(1);
 const old=new Database(path.join(library,backups[0]));expect(old.prepare('SELECT title FROM books').pluck().get()).toBe('awscloudprojects');old.close();
 fs.unlinkSync(path.join(root,'calls.json'));expect(run(true).status).toBe(0);expect(fs.existsSync(path.join(root,'calls.json'))).toBe(false);
});
it('refuses changed metadata or a reused Calibre id before any write',()=>{
 plan.books[0].before.title='stale';expect(run(true).status).toBe(1);expect(fs.existsSync(path.join(root,'calls.json'))).toBe(false);
 plan.books[0].before.title='awscloudprojects';plan.books[0].uuid='wrong';expect(run(true).status).toBe(1);expect(fs.readdirSync(library).filter(f=>f.startsWith('metadata.db.before-'))).toEqual([]);
});
it('passes literal titles safely and preserves separate authors and comma-containing names',()=>{
 plan.books[0].after={title:'A title: $(touch SHOULD_NOT_EXIST)',authors:['Research and Development','William Strunk, Jr.'],year:2024};
 const result=run(true);expect(result.status,result.stderr).toBe(0);
 const actual=JSON.parse(fs.readFileSync(path.join(root,'calls.json'),'utf8'));
 expect(actual.books[0].after).toEqual(plan.books[0].after);
 expect(fs.existsSync('SHOULD_NOT_EXIST')).toBe(false);
});

it('rejects the reserved Calibre author separator before any write',()=>{
 plan.books[0].after.authors=['Research & Development'];
 const result=run(true);expect(result.status).toBe(1);expect(result.stderr).toContain('reserved & separator');expect(fs.existsSync(path.join(root,'calls.json'))).toBe(false);
});

it('applies a year-only correction and rejects stale or invalid year values',()=>{
 plan.books[0].after={...plan.books[0].before,year:2023};
 const result=run(true);expect(result.status,result.stderr).toBe(0);
 const db=new Database(path.join(library,'metadata.db'));expect(db.prepare('SELECT pubdate FROM books').pluck().get()).toBe('2023-01-01T12:00:00+00:00');db.close();
 plan.books[0].after.year=2022;expect(run(true).status).toBe(1);
 plan.books[0].before.year=2023;plan.books[0].after.year=2022.5;expect(run(true).status).toBe(1);
});
it('keeps an existing complete publication date when its year is unchanged',()=>{
 const db=new Database(path.join(library,'metadata.db'));db.prepare('UPDATE books SET pubdate=?').run('2019-05-17T12:34:56+00:00');db.close();
 plan.books[0].before.year=2019;plan.books[0].after.year=2019;
 expect(run(true).status).toBe(0);
 const after=new Database(path.join(library,'metadata.db'));expect(after.prepare('SELECT pubdate FROM books').pluck().get()).toBe('2019-05-17T12:34:56+00:00');after.close();
});

it('reports a partial native write and retains both database and book-file backups',()=>{
 const binary=path.join(root,'calibre-debug');
 fs.writeFileSync(binary,fs.readFileSync(binary,'utf8').replace("db.execute('DELETE FROM books_authors_link", "db.commit(); sys.exit(3)\ndb.execute('DELETE FROM books_authors_link"));
 const result=run(true);expect(result.status).toBe(1);expect(result.stdout).toContain('@@change');
 const change=JSON.parse(result.stdout.split('\n').find(l=>l.startsWith('@@change '))!.slice(9));
 expect(change.metadata).toMatchObject({partial:true,after:{title:'AWS Cloud Projects',authors:['Unknown'],year:2024}});
 const files=fs.readdirSync(library).find(f=>f.endsWith('.files'))!;
 expect(fs.readFileSync(path.join(library,files,'book','notes.txt'),'utf8')).toBe('extra data');
 expect(result.stderr).toContain('do not replace the live database alone');
});
it('fails before backup or mutation if the Calibre runtime is unavailable',()=>{
 fs.unlinkSync(path.join(root,'calibre-debug'));
 const result=run(true);expect(result.status).toBe(1);expect(result.stderr).toContain('runtime is unavailable');
 expect(fs.readdirSync(library).filter(f=>f.startsWith('metadata.db.before-'))).toEqual([]);
});
