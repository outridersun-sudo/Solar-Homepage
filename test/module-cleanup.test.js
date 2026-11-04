'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {testApp}=require('./helpers/module-test-app.cjs');
test('text-only module registration removes legacy routes and preserves existing catalog records',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'solar-cleanup-'));process.env.MODULE_DATA_DIR=dir;
 // Historical PDF-based records remain valid data even though their upload workflow is retired.
 const original=[{manufacturer:'Historical Solar',series:'Legacy',module:{name:'OLD-620',p:620,rearSpecMode:'bnpi'},pdfId:'historical-pdf',originalName:'original.pdf',supplements:[{storedName:'retained.png'}],evidence:{page:2,text:'Original source evidence'}}];
 await fs.writeFile(path.join(dir,'catalog.json'),JSON.stringify(original));
 await fs.writeFile(path.join(dir,'historical-pdf.pdf'),'historical source retained');
 await fs.writeFile(path.join(dir,'retained.png'),'historical attachment retained');
 const {app,password}=testApp();const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
 let cookie='',csrf='';
 const req=(url,method='GET',body)=>fetch(base+url,{method,redirect:'manual',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try{
  await t.test('private page and module data still require authentication',async()=>{assert.equal((await req('/reg-module.html')).status,302);assert.equal((await req('/api/admin/modules')).status,401);});
  const login=await req('/api/admin/login','POST',{username:process.env.ADMIN_USERNAME,password});assert.equal(login.status,200);cookie=login.headers.getSetCookie()[0].split(';')[0];csrf=(await login.json()).csrf;
  await t.test('only text registration is shown and legacy endpoints no longer exist',async()=>{
   const response=await req('/reg-module.html');assert.equal(response.status,200);const html=await response.text();assert.match(html,/text-input/);assert.doesNotMatch(html,/legacy-import|pdf-file|image-paste|upload-form|module-form/);
   for(const [method,url]of [['POST','/api/admin/modules/import'],['POST','/api/admin/modules/import/old/extract'],['POST','/api/admin/modules/import/old/images'],['DELETE','/api/admin/modules/import/old'],['GET','/api/admin/modules/import/old/images/old'],['POST','/api/admin/modules']])assert.equal((await req(url,method,method==='POST'?{}:undefined)).status,404,method+' '+url);
  });
  await t.test('catalog data and historical PDF/image sources are never migrated or removed',async()=>{
   const listed=await req('/api/admin/modules');assert.ok((await listed.json()).rows.some(row=>row.name==='OLD-620'));
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'catalog.json'),'utf8')),original);
   assert.equal(await fs.readFile(path.join(dir,'historical-pdf.pdf'),'utf8'),'historical source retained');assert.equal(await fs.readFile(path.join(dir,'retained.png'),'utf8'),'historical attachment retained');
  });
  await t.test('A/S and downloads still have their file-handling dependencies',async()=>{assert.ok(require('multer'));assert.equal(typeof (await import('file-type')).fileTypeFromBuffer,'function');assert.equal((await req('/calculator.html')).status,200);assert.equal((await req('/products.html')).status,200);assert.equal((await req('/as-request.html')).status,200);});
 }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});
