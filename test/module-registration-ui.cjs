'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const {testApp,textPDF,moduleBody}=require('./helpers/module-fixtures.cjs');
(async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'module-registration-ui-'));
  process.env.MODULE_DATA_DIR=directory;
  const {app,password}=testApp();
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/reg-module.html');assert.equal(new URL(page.url()).pathname,'/admin.html');
    const login=await page.request.post(base+'/api/admin/login',{headers:{Origin:base},data:{username:process.env.ADMIN_USERNAME,password}});assert.equal(login.status(),200);
    await page.goto(base+'/reg-module.html');await page.locator('#management').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelectorAll('#rows tr').length>1);
    assert.equal(await page.locator('aside').count(),0);
    await page.locator('#pdf-file').setInputFiles({name:'solar-module-spec.pdf',mimeType:'application/pdf',buffer:textPDF()});
    await page.click('#analyze');await page.locator('#review').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
    assert.equal(await page.inputValue('#name'),'TEST-650');assert.equal(await page.inputValue('#voc'),'50');
    await page.waitForFunction(()=>document.querySelector('#pdf-preview').naturalWidth>0);
    assert.equal(await page.locator('#save').isDisabled(),true);
    for(const [key,value]of Object.entries(moduleBody)){
      if(key==='reviewed'||key.startsWith('bnpi'))continue;
      await page.locator('#'+key).fill(String(value));
    }
    await page.click('#copy-stc');assert.equal(await page.inputValue('#bnpi'),'650');
    await page.check('#reviewed');assert.equal(await page.locator('#save').isEnabled(),true);
    await page.locator('#manufacturer').fill(' test solar ');assert.equal(await page.isChecked('#reviewed'),false);
    await page.locator('#manufacturer').fill('Test Solar');await page.check('#reviewed');
    await fs.mkdir(path.resolve('artifacts'),{recursive:true});
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:path.resolve('artifacts/reg-module-desktop.png'),fullPage:true});
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/admin/modules')&&r.request().method()==='POST');
    await page.click('#save');assert.equal((await saved).status(),201);
    await page.waitForFunction(()=>document.querySelector('#review').hidden && [...document.querySelectorAll('#rows strong')].some(n=>n.textContent==='TEST-650'));
    await page.locator('#pdf-file').setInputFiles({name:'duplicate.pdf',mimeType:'application/pdf',buffer:textPDF()});
    await page.click('#analyze');await page.locator('#duplicate').waitFor({state:'visible'});assert.equal(await page.locator('#save').isDisabled(),true);
    await page.locator('#search').fill('TEST-650');assert.equal(await page.locator('#rows tr').count(),1);
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.resolve('artifacts/reg-module-mobile.png'),fullPage:true});
    await page.click('#cancel');await page.waitForFunction(()=>document.querySelector('#review').hidden);
    assert.deepEqual(errors,[]);
    console.log('PASS: admin page restriction, PDF extraction form, review invalidation, registration, duplicate blocking, filtering and mobile layout');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
