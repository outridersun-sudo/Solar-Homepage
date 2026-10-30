'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {calculate,catalog} = require('../server/calculator-engine');
const base = {manufacturer:'HD현대에너지솔루션',series:'NA 시리즈',model:'HiC-T645OJ',basis:'capacity',priority:'desc',requestedKWp:400,moduleCount:620,ratio:1,tolerance:.1,voltage:380,kva350:350,pf350:1,minTemperature:-20,maxCellTemperature:70,vmpCoefficient:-.35,rearIrradiance:10,vocMargin:5,iscFactor:1.25,azimuth:180,tilt:30};
function verify(r) {
 assert.equal(r.selection.requiresFullAllocation,true);
 for(const id of ['A','B','C']) {
  const p=r.plans[id],a=r.allocations[id];
  if(!p) {assert.equal(a,undefined);continue;}
  assert.ok(p.within);assert.ok(p.acKW>r.input.dcKW);
  assert.equal(p.metrics.allocated,r.input.moduleCount);
  assert.equal(p.metrics.unallocated,0);
  assert.equal(a.unallocated,0);
 }
 for (const a of Object.values(r.allocations)) {
  assert.equal(a.allocated+a.unallocated,r.input.moduleCount);
  assert.equal(a.allocated,a.units.reduce((n,u)=>n+u.modules,0));
  for (const u of a.units) {
   const d=r.designs[u.kw],inv=d.inverter,v=d.values;
   assert.ok(u.stcKW<=u.unitAC+1e-9);
   assert.equal(u.modules,u.mppts.reduce((n,m)=>n+m.modules,0));
   assert.equal(u.mppts.length,inv.mppt);
   for (const m of u.mppts) {
    assert.equal(m.modules,m.series*m.parallel);
    if (!m.modules) continue;
    assert.ok(m.series*v.vocWithMargin<=Math.min(inv.dcMax,r.input.module.maxV)+1e-8);
    assert.ok(m.series*v.vmpHot>=Math.max(inv.mppMin,inv.startV)-1e-8);
    assert.ok(m.series*v.vmpCold<=inv.mppMax+1e-8);
    assert.ok(m.parallel<=inv.portsPerMppt);
    assert.ok(v.impDesign<=(m.parallel===1&&inv.singleStringA?inv.singleStringA:inv.stringA)+1e-8);
    assert.ok(m.parallel*v.impDesign<=inv.mpptA+1e-8);
    assert.ok(m.parallel*v.iscDesign<=inv.mpptIscA+1e-8);
   }
  }
 }
}
test('Voc coefficient replaces stale Vmpp input for every module and temperature formula',()=>{
 for(const [manufacturer,seriesList] of Object.entries(catalog)) for(const [series,models] of Object.entries(seriesList)) {
  const m=models[0];
  const r=calculate({...base,manufacturer,series,model:m.name,requestedKWp:20});
  assert.equal(r.input.vmpCoefficient,m.betaVoc);
  assert.equal(r.input.vmpCoefficientSource,'Voc');
  const v=r.values;
  assert.ok(Math.abs(v.vmpHot-v.vmp*(1+m.betaVoc/100*(70-25)))<1e-9);
  verify(r);
 }
});
test('400 kW uses all panels and finds globally optimal long-string/proportional allocation',()=>{
 const r=calculate(base),a=r.allocations.A;
 verify(r);assert.equal(a.optimization,'global');assert.equal(a.unallocated,0);
 assert.equal(a.allocated,620);
 assert.match(r.plans.A.reason,/최소/);assert.match(r.plans.B.reason,/최근접/);assert.match(r.plans.C.reason,/40%/);
 // Independent enumeration of 14/15-module string inventories. Strings of
 // different lengths must fit separate MPPTs; each inverter is power-capped.
 function inventories(kw) {
  const d=r.designs[kw],inv=d.inverter;
  assert.equal(d.minSeries,14);assert.equal(d.maxSeries,15);
  let ports=0;
  for(let p=1;p<=inv.portsPerMppt;p++) if(p*d.values.impDesign<=inv.mpptA&&p*d.values.iscDesign<=inv.mpptIscA) ports=p;
  const options=new Map([[0,0]]);
  for(let short=0;short<=ports*inv.mppt;short++) for(let long=0;long<=ports*inv.mppt;long++) {
   if(Math.ceil(short/ports)+Math.ceil(long/ports)>inv.mppt) continue;
   const panels=14*short+15*long;
   if(panels*645>kw*1000) continue;
   options.set(panels,Math.min(options.get(panels)??Infinity,short));
  }
  return options;
 }
 const first=inventories(150),last=inventories(110);
 let bestShort=Infinity,bestBalance=Infinity;
 for(const [x,sx] of first) for(const [y,sy] of first) {
  const z=620-x-y;if(!last.has(z)) continue;
  const short=sx+sy+last.get(z),balance=x*x/150+y*y/150+z*z/110;
  if(short<bestShort||(short===bestShort&&balance<bestBalance)) {bestShort=short;bestBalance=balance;}
 }
 const short=a.units.flatMap(u=>u.mppts).reduce((n,m)=>n+m.parallel*(15-m.series),0);
 assert.equal(short,bestShort);
 assert.ok(Math.abs(a.units.reduce((n,u)=>n+u.modules*u.modules/u.unitAC,0)-bestBalance)<1e-8);
 const full=a.units.find(u=>u.modules===225);
 assert.ok(full);assert.deepEqual(full.mppts.map(m=>m.parallel),[2,2,2,2,2,2,3]);
});
test('500 kW floors panel count, conserves panels, and is deterministic',()=>{
 const r=calculate({...base,requestedKWp:500});verify(r);
 assert.equal(r.input.moduleCount,775);assert.ok(r.input.dcKW<=500);
 assert.equal(r.allocations.A.unallocated,0);
 assert.deepEqual(r.allocations,calculate({...base,requestedKWp:500}).allocations);
});
test('400 kW T645OJ B connects all 620 panels and chooses the closest feasible AC total',()=>{
 for(const designMode of ['document','standard']) {
  const r=calculate({...base,designMode,maxCellTemperature:40,rearIrradiance:13.5,vocMargin:designMode==='document'?0:5});
  verify(r);
  const b=r.plans.B;
  assert.equal(b.acKW,408);
  assert.deepEqual(b.rows.map(row=>[row.kw,row.count]),[[150,2],[36,3]]);
  assert.equal(r.allocations.B.allocated,620);
  assert.equal(r.allocations.B.allocated*r.input.module.p/1000,399.9);
  assert.equal(r.input.iscFactor,1.25);
  assert.ok(2*r.values.iscDesign>r.designs[110].inverter.mpptIscA);
  // Independently rule out every smaller AC total using a conservative upper
  // bound on each inverter's module count, not the allocation optimizer.
  const cap={};
  for(const kw of [150,110,60,36]) {
   const d=r.designs[kw],inv=d.inverter,v=d.values;
   let parallel=0;
   for(let p=1;p<=inv.portsPerMppt;p++) if(v.impDesign<=(p===1&&inv.singleStringA?inv.singleStringA:inv.stringA)&&p*v.impDesign<=inv.mpptA&&p*v.iscDesign<=inv.mpptIscA) parallel=p;
   cap[kw]=Math.min(Math.floor(kw*1000/r.input.module.p),inv.mppt*parallel*d.maxSeries);
  }
  for(let a=0;a*150<408;a++) for(let c=0;c*110<408;c++)
   for(let d=0;d*60<408;d++) for(let e=0;e*36<408;e++) {
    const ac=a*150+c*110+d*60+e*36;
    if(ac<=r.input.dcKW||ac>=408)continue;
    assert.ok(a*cap[150]+c*cap[110]+d*cap[60]+e*cap[36]<620,`closer AC ${ac} cannot connect 620 panels`);
   }
 }
});
test('800V and large-plant fallback preserve electrical/power constraints',()=>{
 for(const requestedKWp of [400,10000,100000]) {
  const r=calculate({...base,requestedKWp,voltage:requestedKWp===400?800:380});verify(r);
  if(requestedKWp>=10000) assert.equal(r.allocations.A.optimization,'bounded-pairwise');
 }
});
const documentInput = {...base,series:'NJ-ES 시리즈',model:'HiS-T645NJ-ES',requestedKWp:500,
 maxCellTemperature:40,rearIrradiance:13.5,vocMargin:0,designMode:'document'};
test('document mode A selects 520 kW and reproduces 47 long + 5 short strings',()=>{
 const r=calculate(documentInput);verify(r);
 const a=r.plans.A;
 assert.deepEqual(a.rows.map(row=>[row.kw,row.count]),[[150,2],[110,2]]);
 assert.deepEqual(a.metrics.strings,{'14':5,'15':47});
 assert.equal(a.metrics.totalStrings,52);assert.equal(a.metrics.unallocated,0);
 assert.equal(r.values.voc,57.61);assert.ok(Math.abs(r.values.vocWithMargin*15-961.366875)<1e-8);
 assert.equal(r.selection.complete,true);
 assert.deepEqual(r.allocations.A.units.map(u=>u.modules),[223,224,164,164]);
 assert.ok(a.metrics.balance<.005);
 assert.equal(r.plans.B.acKW,502);assert.equal(r.plans.B.metrics.unallocated,0);
 assert.deepEqual(r.plans.B.rows.map(row=>[row.kw,row.count]),[[150,1],[110,2],[60,1],[36,2]]);
 assert.equal(r.plans.C.acKW,510);assert.equal(r.plans.C.metrics.totalStrings,53);
 assert.match(r.plans.C.reason,/40%.*30%.*30%/);
});
test('standard settings preserve 5% and 1.25, disallow NJ 15-series and still use all panels',()=>{
 const r=calculate({...documentInput,designMode:'standard',vocMargin:5});verify(r);
 assert.equal(r.input.vocMargin,5);assert.equal(r.input.iscFactor,1.25);
 assert.ok(r.values.vocWithMargin*15>1000);
 assert.equal(r.plans.A.metrics.unallocated,0);
 assert.deepEqual(r.plans.A.metrics.strings,{'13':9,'14':47});
 assert.equal(r.plans.A.metrics.totalStrings,56);
 const a=r.plans.A;
 assert.ok(a.within);assert.equal(a.count,4);
 assert.deepEqual(a.rows.map(row=>[row.kw,row.count]),[[150,2],[110,2]]);
 assert.equal(r.plans.B.acKW,502);assert.equal(r.plans.B.metrics.unallocated,0);
});
test('no full feasible proposal leaves all plans empty, including B',()=>{
 for(const overrides of [{requestedKWp:1},{maxCellTemperature:40,rearIrradiance:13.5,tolerance:.01},{tolerance:0}]) {
  const r=calculate({...base,...overrides});verify(r);
  for(const id of ['A','B','C'])assert.equal(r.plans[id],null);
  assert.deepEqual(r.allocations,{});
 }
 assert.throws(()=>calculate({...base,designMode:'invalid'}));
});
