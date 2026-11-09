'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {calculate}=require('../server/calculator-engine');
const base={manufacturer:'HD현대에너지솔루션',series:'NA 시리즈',model:'HiC-T645OJ',basis:'capacity',priority:'desc',requestedKWp:400,moduleCount:620,ratio:1,tolerance:.1,voltage:380,kva350:350,pf350:1,minTemperature:-20,maxCellTemperature:40,rearIrradiance:13.5,vocMargin:0,iscFactor:1.25,azimuth:180,tilt:30,designMode:'document'};
test('150kW current exclusion includes actual string and MPPT inequalities',()=>{
 const r=calculate({...base,manufacturer:'통웨이 TW Solar',series:'TWMNF 66HD',model:'TWMNF-66HD750'}),d=r.designs[150];
 const expected=19.71*(1+.046/100*45);
 assert.ok(Math.abs(d.values.impDesign-expected)<1e-10);assert.equal(d.eligible,false);assert.equal(d.currentChecks.length,3);
 for(const row of d.currentChecks){assert.equal(row.stringLimit,18);assert.equal(row.stringPassed,false);assert.equal(row.passed,false);assert.equal(row.mpptLimit,54);assert.equal(row.mpptShortCircuitLimit,75);assert.equal(row.mpptCurrent,row.parallel*expected);}
 assert.equal(d.currentChecks[0].mpptPassed,true);assert.equal(d.currentChecks[2].mpptPassed,false);
});
test('110kW single-string exception and rejected parallel counts do not reject an eligible product',()=>{
 const d=calculate(base).designs[110];
 assert.equal(d.eligible,true);assert.equal(d.currentChecks[0].stringLimit,19.2);assert.equal(d.currentChecks[1].stringLimit,16);
 assert.equal(d.currentChecks[0].passed,true);assert.equal(d.currentChecks[1].shortCircuitPassed,false);
});
test('voltage exclusions expose both independently limiting maximum series counts',()=>{
 const r=calculate({...base,minTemperature:-50,maxCellTemperature:90,vocMargin:10});
 let found=false;
 for(const d of Object.values(r.designs)){
  assert.equal(d.voltageChecks.maxSeries,Math.min(d.voltageChecks.maximumDCSeries,d.voltageChecks.maximumMPPTSeries));
  assert.equal(d.voltageChecks.passed,d.minSeries<=d.maxSeries);
  if(!d.voltageChecks.passed){found=true;assert.equal(d.eligible,false);assert.ok(d.minSeries>d.maxSeries);}
 }
 assert.equal(found,true);
});
test('diagnostics match inverter eligibility and selected voltage groups',()=>{
 for(const voltage of [380,800]){
  const r=calculate({...base,voltage});
  for(const d of Object.values(r.designs)){
   for(const row of d.currentChecks){
    const expected=d.values.impDesign<=row.stringLimit+1e-10&&row.parallel*d.values.impDesign<=d.inverter.mpptA+1e-10&&row.parallel*d.values.iscDesign<=d.inverter.mpptIscA+1e-10;
    assert.equal(row.passed,expected);assert.equal(row.passed&&d.voltageChecks.passed,expected&&d.minSeries<=d.maxSeries);
   }
   assert.equal(d.eligible,d.voltageChecks.passed&&d.currentChecks.some(row=>row.passed));
   if(d.inverter.voltage!==voltage)for(const plan of Object.values(r.plans))if(plan?.rows)assert.ok(!plan.rows.some(row=>row.kw===d.inverter.kw));
  }
 }
});
