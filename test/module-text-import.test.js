'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const fixtures=require('./helpers/text-import-fixtures.cjs'),{format}=fixtures;
const {testApp}=require('./helpers/module-test-app.cjs');
test('28-column text import, source preservation, atomic registration and calculation rules',{timeout:120000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'solar-text-import-'));process.env.MODULE_DATA_DIR=dir;
 const {app,password}=testApp();const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
 let cookie='',csrf='';
 const req=(url,body,headers={})=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const validText=format.serialize([...fixtures.hansol,...fixtures.energy,...fixtures.canadian]);
 const register=text=>req('/api/admin/modules/text/register',{text,reviewed:true,acceptedModes:true});
 try{
  await t.test('anonymous access is rejected',async()=>assert.equal((await req('/api/admin/modules/text/validate',{text:validText})).status,401));
  const login=await req('/api/admin/login',{username:process.env.ADMIN_USERNAME,password});assert.equal(login.status,200);cookie=login.headers.getSetCookie()[0].split(';')[0];csrf=(await login.json()).csrf;
  await t.test('Origin and CSRF protect text registration',async()=>{
   assert.equal((await req('/api/admin/modules/text/validate',{text:validText},{'X-CSRF-Token':''})).status,403);
   assert.equal((await req('/api/admin/modules/text/register',{text:validText,reviewed:true,acceptedModes:true},{Origin:'https://other.example'})).status,403);
  });
  await t.test('all 19 supplied model rows preview with no writes and exact 28 cells',async()=>{
   const r=await req('/api/admin/modules/text/validate',{text:'\uFEFF'+validText.replaceAll('\n','\r\n')});assert.equal(r.status,200);const data=await r.json();assert.equal(data.rows.length,19);
   for(const row of data.rows){assert.equal(row.cells.length,28);assert.deepEqual(row.errors,[],JSON.stringify(row));}
   await assert.rejects(fs.stat(path.join(dir,'catalog.json')),{code:'ENOENT'});
  });
  await t.test('malformed columns, header order and numeric units are rejected',async()=>{
   for(const text of [validText.replaceAll('\t',' '),validText.replace('STC출력_W','출력'),validText+'\textra'])assert.equal((await req('/api/admin/modules/text/validate',{text})).status,400);
   const altered=structuredClone(fixtures.hansol);altered[0][3]='620 W';const r=await register(format.serialize(altered));assert.equal(r.status,422);await assert.rejects(fs.stat(path.join(dir,'catalog.json')),{code:'ENOENT'});
  });
  await t.test('unconfirmed required data, electrical inconsistency, modes and batch duplicates cannot save',async()=>{
   for(const [column,value]of [[3,'확인 필요'],[4,'40'],[13,'10'],[15,'other'],[27,'1,x']]){
    const altered=structuredClone(fixtures.hansol);altered[1][column]=value;assert.equal((await register(format.serialize(altered))).status,422,column+' should fail');
   }
   const repeated=structuredClone(fixtures.hansol[0]);repeated[0]='한솔 테크닉스';repeated[2]=repeated[2].toLowerCase();
   assert.equal((await register(format.serialize([fixtures.hansol[0],repeated]))).status,422);await assert.rejects(fs.stat(path.join(dir,'catalog.json')),{code:'ENOENT'});
  });
  await t.test('text cannot supply or replace explicit review and mode consent',async()=>{
   for(const flags of [{},{reviewed:true},{acceptedModes:true}])assert.equal((await req('/api/admin/modules/text/register',{text:validText,...flags})).status,400);
  });
  await t.test('atomic batch saves 19 models, exact source cells and no pretend PDF upload',async()=>{
   const response=await register(validText);assert.equal(response.status,201,await response.clone().text());assert.equal((await response.json()).rows.length,19);
   const saved=JSON.parse(await fs.readFile(path.join(dir,'catalog.json'),'utf8'));assert.equal(saved.length,19);
   assert.deepEqual(saved[0].importCells,fixtures.hansol[0]);assert.equal(saved[0].pdfId,null);assert.equal(saved[0].sourceKind,'text');assert.deepEqual(saved[0].module.specification.sourcePages,[1,2]);
   assert.match(saved[6].module.specification.testConditions,/φVoc=100%/);assert.equal(saved[12].module.specification.referenceRearIrradiancePercent,null);
   const original=await fs.readFile(path.join(dir,'catalog.json'),'utf8');assert.equal((await register(validText)).status,422);assert.equal(await fs.readFile(path.join(dir,'catalog.json'),'utf8'),original);
  });
  await t.test('BSTC and gain10 use fixed original rear values, BNPI interpolates, and DC remains STC',async()=>{
   const {calculate}=require('../server/calculator-engine');
   const baseInput={basis:'modules',priority:'desc',requestedKWp:6.2,moduleCount:10,ratio:1,tolerance:.1,voltage:380,kva350:350,pf350:1,minTemperature:-20,maxCellTemperature:25,vocMargin:0,iscFactor:1,azimuth:180,tilt:30};
   for(const [cells,fixed]of [[fixtures.hansol[0],true],[fixtures.canadian[0],true],[fixtures.energy[0],false]])for(const designMode of ['standard','document'])for(const rearIrradiance of [0,6.75,13.5,27]){
    const r=calculate({...baseInput,manufacturer:cells[0],series:cells[1],model:cells[2],designMode,rearIrradiance}),scale=fixed?1:rearIrradiance/13.5;
    assert.equal(r.input.dcKW,Number(cells[3])*10/1000);
    for(const [key,stc,rear]of [['power',3,17],['vmp',5,19],['imp',7,21],['isc',6,20]])assert.ok(Math.abs(r.values[key]-(Number(cells[stc])+(Number(cells[rear])-Number(cells[stc]))*scale))<1e-9,key);
    const voc=fixed?Number(cells[18]):designMode==='document'?Number(cells[4]):Number(cells[4])+(Number(cells[18])-Number(cells[4]))*scale;assert.ok(Math.abs(r.values.voc-voc)<1e-9);
   }
  });
  await t.test('fresh calculator workers see all newly registered modes',async()=>{
   for(const cells of [fixtures.hansol[0],fixtures.energy[0],fixtures.canadian[0]]){
    const r=await req('/api/calculator/calculate',{manufacturer:cells[0],series:cells[1],model:cells[2],basis:'modules',priority:'desc',requestedKWp:6.2,moduleCount:10,ratio:1,tolerance:.1,voltage:380,kva350:350,pf350:1,minTemperature:-20,maxCellTemperature:25,rearIrradiance:0,vocMargin:0,iscFactor:1,azimuth:180,tilt:30});assert.equal(r.status,200);const j=await r.json();assert.equal(j.values.power,Number(cells[cells[15]==='bnpi'?3:17]));
   }
  });
 }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});
