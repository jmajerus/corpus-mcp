import { expect, it } from "vitest";
import { BOOK_HTML } from "../src/web/book.js";

function preview(post:any,writable=true) {
 const fields:any={
  'metadata-key-preview':{innerHTML:'',textContent:''},
  'metadata-title':{value:'Draft title'},'metadata-authors':{value:'Jane Doe'},'metadata-year':{value:'2026'},
 };
 const script=[...BOOK_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1];
 const fn=script.slice(script.indexOf('async function previewMetadataKey()'),script.indexOf("document.getElementById('book').addEventListener('input'"));
 const run=new Function('document','book','canWrite','post','id','esc','let citekeyRequest=0;'+fn+';return previewMetadataKey;')(
  {getElementById:(id:string)=>fields[id]},
  {title:'Before',authors:['Original Author'],publication_year:{calibre:2020},metadata_writable:writable},true,post,'main:1',String);
 return {fields,run};
}
it('shows a draft key and assigned key while ignoring older preview responses',async()=>{
 const requests:any[]=[];
 const p=preview((url:string,body:any)=>new Promise(resolve=>requests.push({url,body,resolve})));
 const old=p.run();p.fields['metadata-title'].value='New title';const latest=p.run();
 expect(requests[1]).toMatchObject({url:'/api/books/main%3A1/metadata-preview',body:{title:'New title',authors:['Jane Doe'],year:2026,before:{title:'Before',authors:['Original Author'],year:2020}}});
 requests[1].resolve({generated:'doe2026new',provisional:true,blockers:[],assigned:'EstablishedKey'});await latest;
 expect(p.fields['metadata-key-preview'].innerHTML).toContain('<code>doe2026new</code>');
 expect(p.fields['metadata-key-preview'].innerHTML).toContain('provisional');
 expect(p.fields['metadata-key-preview'].innerHTML).toContain('EstablishedKey');
 requests[0].resolve({generated:'oldpreview',provisional:false,blockers:[],assigned:null});await old;
 expect(p.fields['metadata-key-preview'].innerHTML).not.toContain('oldpreview');
});
it('does not request draft previews for a read-only library',async()=>{
 let calls=0;const p=preview(()=>{calls++;},false);await p.run();
 expect(calls).toBe(0);expect(p.fields['metadata-key-preview'].textContent).toBe('This library is read-only.');
});
