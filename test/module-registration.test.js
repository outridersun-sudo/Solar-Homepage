'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {textPDF,scannedPDF,testApp,moduleBody}=require('./helpers/module-fixtures.cjs');
test('private registration: text PDF, CSRF, duplicate prevention and live worker catalog', {timeout:120000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'module-registration-'));
  process.env.MODULE_DATA_DIR=dir;
  const {app,password}=testApp();
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  let cookie='',csrf='';
  async function request(url,options={}){
    const headers={Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,...options.headers};
    if(options.body && !(options.body instanceof FormData))headers['Content-Type']='application/json';
    return fetch(base+url,{...options,headers,redirect:'manual'});
  }
  const upload=async buffer=>{const form=new FormData();form.set('file',new Blob([buffer],{type:'application/pdf'}),'module.pdf');form.set('page','1');return request('/api/admin/modules/import',{method:'POST',body:form});};
  try{
    await t.test('anonymous page and API are protected',async()=>{
      const response=await request('/reg-module.html');assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/admin.html');
      assert.equal((await request('/api/admin/modules')).status,401);
      assert.equal((await request('/private/reg-module.html')).status,404);
      assert.equal((await request('/REG-MODULE.HTML')).status,302);
    });
    const login=await request('/api/admin/login',{method:'POST',body:JSON.stringify({username:process.env.ADMIN_USERNAME,password})});
    assert.equal(login.status,200);cookie=login.headers.getSetCookie()[0].split(';')[0];csrf=(await login.json()).csrf;
    await t.test('authenticated page has no sidebar and session uses root cookie',async()=>{
      assert.match(login.headers.getSetCookie()[0],/Path=\//);const response=await request('/reg-module.html');
      assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.match(await response.text(),/PDF 사양서 불러오기/);
      assert.equal((await request('/api/admin/modules',{method:'POST',headers:{'X-CSRF-Token':''},body:'{}'})).status,403);
      assert.equal((await request('/api/admin/modules',{method:'POST',headers:{Origin:'https://other.example'},body:'{}'})).status,403);
    });
    let importId;
    await t.test('real text PDF extraction and invalid upload handling',async()=>{
      assert.equal((await upload(Buffer.from('not pdf'))).status,400);
      const response=await upload(textPDF());assert.equal(response.status,200);const data=await response.json();importId=data.importId;
      assert.equal(data.method,'text');assert.equal(data.fields.name,'TEST-650');assert.equal(data.fields.p,650);assert.equal(data.fields.voc,50);assert.equal(data.fields.betaVoc,-.25);assert.equal(data.pages,1);
      const otherLogin=await request('/api/admin/login',{method:'POST',headers:{Cookie:''},body:JSON.stringify({username:process.env.ADMIN_USERNAME,password})});
      const otherCookie=otherLogin.headers.getSetCookie()[0].split(';')[0],otherCsrf=(await otherLogin.json()).csrf;
      const crossSession=await request('/api/admin/modules/import/'+importId+'/extract',{method:'POST',headers:{Cookie:otherCookie,'X-CSRF-Token':otherCsrf},body:'{"page":1}'});
      assert.equal(crossSession.status,410);
      assert.equal((await request('/api/admin/modules/import/'+importId+'/extract',{method:'POST',body:'{"page":2}'})).status,400);
    });
    await t.test('review, electrical consistency and concurrent duplicate guard',async()=>{
      const save=body=>request('/api/admin/modules',{method:'POST',body:JSON.stringify({...moduleBody,importId,...body})});
      assert.equal((await save({reviewed:false})).status,400);assert.equal((await save({p:1000})).status,400);
      const responses=await Promise.all([save({}),save({})]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,410]);
      const second=await upload(textPDF());const secondId=(await second.json()).importId;
      const duplicate=await request('/api/admin/modules',{method:'POST',body:JSON.stringify({...moduleBody,manufacturer:' TEST  SOLAR ',name:'test-650',series:'Different series',importId:secondId})});
      assert.equal(duplicate.status,409);assert.match((await duplicate.json()).message,/동일한 제조사/);
      const catalog=require('../server/module-catalog');assert.equal(catalog.list().filter(r=>r.name==='TEST-650').length,1);
      const {module,...base}=catalog.validate(moduleBody);assert.ok(module);assert.ok(base);
      assert.throws(()=>catalog.validate({...moduleBody,manufacturer:'__proto__'}));
      const builtIn=catalog.list().find(r=>r.name!=='TEST-650');
      assert.throws(()=>catalog.add({...moduleBody,manufacturer:builtIn.manufacturer,name:builtIn.name},{id:'unused',filename:'test.pdf'}),/동일한 제조사/);
    });
    await t.test('calculator endpoint and fresh worker read the new module immediately',async()=>{
      const response=await request('/api/calculator/catalog');assert.ok((await response.json()).modules['Test Solar']['TEST Series'].some(m=>m.name==='TEST-650'));
      const input={manufacturer:'Test Solar',series:'TEST Series',model:'TEST-650',basis:'capacity',priority:'desc',requestedKWp:10,moduleCount:15,ratio:1,tolerance:.1,voltage:380,kva350:350,pf350:1,minTemperature:-20,maxCellTemperature:70,vmpCoefficient:-.25,rearIrradiance:0,vocMargin:5,iscFactor:1.25,azimuth:180,tilt:30};
      const result=await request('/api/calculator/calculate',{method:'POST',body:JSON.stringify(input)});assert.equal(result.status,200);assert.equal((await result.json()).input.module.name,'TEST-650');
    });
    await t.test('image-only PDF has no automatic extraction and supports manual entry',async()=>{
      const filename=path.join(dir,'source.pdf'),prefix=path.join(dir,'scan');await fs.writeFile(filename,textPDF());
      await promisify(execFile)(require('../server/module-pdf').renderCommand,['-singlefile','-scale-to-x','1600','-scale-to-y','2000','-jpeg',filename,prefix]);
      const response=await upload(scannedPDF(await fs.readFile(prefix+'.jpg')));
      const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.method,'text');assert.equal(data.text.trim(),'');assert.deepEqual(data.fields,{});assert.match(data.warning,/텍스트가 없습니다/);assert.match(data.previewImage,/^data:image\/png;base64,/);
    });
    await t.test('session logout revokes direct page and API access',async()=>{
      assert.equal((await request('/api/admin/logout',{method:'POST'})).status,200);
      assert.equal((await request('/reg-module.html')).status,302);assert.equal((await request('/api/admin/modules')).status,401);
    });
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});
