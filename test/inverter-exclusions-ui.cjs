'use strict';
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const app=require('../server');
(async()=>{
 const server=await new Promise(resolve=>{const s=app.listen(3000,'127.0.0.1',()=>resolve(s));});let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const wait=()=>page.waitForResponse(r=>r.url().endsWith('/api/calculator/calculate')&&r.request().method()==='POST',{timeout:40000});
  const initial=wait();await page.goto('http://127.0.0.1:'+server.address().port+'/calculator.html');const initialData=await (await initial).json();await page.waitForSelector('#inverterExclusionSection:visible');
  assert.equal(await page.locator('main > section').last().getAttribute('id'),'inverterExclusionSection');
  const visible=await page.locator('#inverterExclusionSection').innerText();assert.match(visible,/전기 조건 충족 · 선택한 조합에서 미선정/);assert.match(visible,/선택 AC 전압 380V ≠ 제품 AC 전압 800V/);
  for(const node of await page.locator('#inverterExclusionSection h2,#inverterExclusionSection h3,#inverterExclusionSection p,#inverterExclusionSection td').all())assert.deepEqual(await node.evaluate(n=>({font:getComputedStyle(n).fontSize,color:getComputedStyle(n).color})),{font:'12px',color:'rgb(192, 0, 0)'});
  for(const id of ['A','B','C'])if(initialData.plans[id]){
   await page.click('.result-card[data-card="'+id+'"]');assert.match(await page.locator('#inverterExclusionContext').innerText(),new RegExp(id+'안 기준'));
   const used=new Set(initialData.plans[id].rows.map(r=>r.kw)),shown=await page.locator('#inverterExclusionBody article').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.kw)));for(const kw of used)assert.ok(!shown.includes(kw));
  }
  await page.selectOption('#manufacturer','통웨이 TW Solar');await page.selectOption('#model','TWMNF-66HD750');const tw=wait();await page.click('#runBtn');const data=await (await tw).json();await page.waitForFunction(()=>document.querySelector('#inverterExclusionContext').textContent.includes('TWMNF-66HD750'));
  const article=page.locator('#inverterExclusionBody article[data-kw="150"]');assert.match(await article.innerText(),/전기 조건 미충족으로 후보 제외/);assert.match(await article.innerText(),/스트링 동작전류 초과/);assert.match(await article.innerText(),/20\.118 > 18/);assert.equal(await article.locator('tbody tr').count(),3);assert.equal(data.designs[150].eligible,false);
  await page.locator('#inverterExclusionSection').screenshot({path:'/tmp/solar-patches/inverter-exclusion-150kw.png'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.fill('#plantCapacity','1');assert.equal(await page.locator('#inverterExclusionSection').isHidden(),true);
  const empty=wait();await page.click('#runBtn');await empty;await page.waitForSelector('#inverterExclusionSection:visible');assert.match(await page.locator('#inverterExclusionContext').innerText(),/구성안이 없습니다/);
  await page.selectOption('#manufacturer','HD현대에너지솔루션');await page.selectOption('#model','HiC-T645OJ');const low=wait();await page.click('#runBtn');await low;await page.waitForFunction(()=>document.querySelector('#inverterExclusionContext').textContent.includes('HiC-T645OJ'));assert.match(await page.locator('#inverterExclusionBody article[data-kw="150"]').innerText(),/1대의 AC 150kW > 현재 조합의 허용 AC 상한/);
  assert.deepEqual(errors,[]);console.log('PASS: bottom placement, red 12px text, active-plan updates, electrical exclusion versus combination omission, 150kW numeric inequalities, empty results, stale-data clearing and mobile overflow');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
