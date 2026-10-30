'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {calculate,catalog} = require('../server/calculator-engine');
const base = {manufacturer:'HD현대에너지솔루션',series:'NA 시리즈',model:'HiC-T645OJ',basis:'capacity',priority:'desc',requestedKWp:400,moduleCount:620,ratio:1,tolerance:.1,voltage:380,kva350:350,pf350:1,minTemperature:-20,maxCellTemperature:70,vmpCoefficient:-.35,rearIrradiance:10,vocMargin:5,iscFactor:1.25,azimuth:180,tilt:30};
function verify(r) {
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
 const small=calculate({...base,requestedKWp:1});verify(small);
 assert.ok(small.allocations.B.unallocated>0);
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
 assert.equal(r.plans.B.acKW,500);assert.equal(r.plans.B.metrics.unallocated,2);
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
});
test('no full feasible proposal leaves A/C empty and exposes B as incomplete',()=>{
 const r=calculate({...base,requestedKWp:1});
 assert.equal(r.plans.A,null);assert.equal(r.plans.C,null);
 assert.ok(r.plans.B.metrics.unallocated>0);
 assert.match(r.plans.B.reason,/미배분/);
 assert.throws(()=>calculate({...base,designMode:'invalid'}));
});
