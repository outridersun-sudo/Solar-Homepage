'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright'),{hansol,format}=require('./helpers/text-import-fixtures.cjs'),{testApp}=require('./helpers/module-test-app.cjs');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'solar-text-ui-'));process.env.MODULE_DATA_DIR=dir;
 const {app,password}=testApp();let browser;const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
 try{
  browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const login=await page.request.post(base+'/api/admin/login',{headers:{Origin:base},data:{username:process.env.ADMIN_USERNAME,password}});assert.equal(login.status(),200);
  await page.goto(base+'/reg-module.html');await page.waitForSelector('#management:visible');assert.equal(await page.locator('#legacy-import').count(),0);assert.equal(await page.locator('input[type=file]').count(),0);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
  const cells=structuredClone(hansol);cells[0][9]='확인 필요';
  await page.evaluate(text=>navigator.clipboard.writeText(text),format.serialize(cells));await page.click('#text-input');await page.keyboard.press('Control+V');
  await page.click('#text-check');await page.waitForSelector('#text-grid tbody tr');await page.waitForFunction(()=>!document.querySelector('#text-check').disabled);
  assert.equal(await page.locator('#text-grid tbody tr').count(),6);assert.equal(await page.locator('#text-grid tbody tr').first().locator('input[type=checkbox]').isDisabled(),true);
  const coefficient=page.locator('#text-grid tbody tr').first().locator('input[data-column="9"]');assert.equal(await coefficient.isEnabled(),true);await coefficient.fill('-.22');assert.equal(await page.locator('#text-register').isDisabled(),true);
  await page.click('#text-recheck');await page.waitForFunction(()=>!document.querySelector('#text-recheck').disabled);
  await page.locator('#text-grid tbody tr').first().locator('input[type=checkbox]').check();
  await page.check('#text-reviewed');assert.equal(await page.locator('#text-register').isDisabled(),true);await page.check('#text-modes');assert.equal(await page.locator('#text-register').isEnabled(),true);
  await page.locator('#text-grid tbody tr').first().locator('input[data-column="13"]').fill('35');assert.equal(await page.locator('#text-reviewed').isChecked(),false);assert.equal(await page.locator('#text-register').isDisabled(),true);
  await page.click('#text-recheck');await page.waitForFunction(()=>!document.querySelector('#text-recheck').disabled);await page.check('#text-reviewed');await page.check('#text-modes');
  await page.locator('.text-grid-scroll').evaluate(node=>node.scrollLeft=0);
  await page.locator('#text-review').screenshot({path:path.join(os.tmpdir(),'solar-text-import-v11-review.png')});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'table must scroll inside its container on mobile');
  const saved=page.waitForResponse(response=>response.url().endsWith('/modules/text/register'));await page.click('#text-register');assert.equal((await saved).status(),201);
  await page.waitForSelector('#text-review',{state:'hidden'});await page.waitForFunction(()=>document.querySelector('#rows').textContent.includes('HS620AE-NHE00'));
  const stored=JSON.parse(await fs.readFile(path.join(dir,'catalog.json'),'utf8'));assert.equal(stored.length,6);assert.equal(stored[0].module.maxSeriesFuse,35);assert.equal(stored[0].module.rearSpecMode,'bstc');
  await page.setViewportSize({width:1440,height:1050});await page.goto(base+'/calculator.html');await page.waitForSelector('#manufacturer option[value="한솔테크닉스"]',{state:'attached'});await page.selectOption('#manufacturer','한솔테크닉스');
  assert.equal(await page.locator('#rearIrradiance').isDisabled(),true);assert.match(await page.locator('#rearBasisNote').innerText(),/BSTC/);assert.match(await page.locator('#profileNote').innerText(),/고정/);
  const calculation=page.waitForResponse(response=>response.url().endsWith('/api/calculator/calculate')&&response.request().method()==='POST');await page.click('#runBtn');const result=await calculation;assert.equal(result.status(),200);const body=await result.json();assert.equal(body.values.power,679);assert.equal(body.values.voc,57.1);assert.equal(body.input.module.p,620);
  assert.deepEqual(errors,[]);console.log('PASS: actual TSV clipboard paste, editable validation table, missing-value correction, explicit consent, invalidation after edits, mobile scroll, batch save, catalog refresh and BSTC calculator display');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
