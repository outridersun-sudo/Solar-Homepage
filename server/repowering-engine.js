'use strict';
// Independent repowering calculations. The existing calculator engine is unchanged.
// Use the registered K variants and continue excluding 350kW from repowering.
const INVERTERS = require('./calculator-data/calculator-inverters.json').filter(inv => inv.kw !== 350);
const EPS = 1e-8;
const DEFAULTS = Object.freeze({acKW:120,moduleCount:480,series:20,pmax:250,voc:37.8,vmp:30.6,imp:8.17,isc:8.8,maxSeriesFuse:15,maxSystemV:1000});
function normalizeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('입력값을 확인하세요.');
  const x = {};
  const ranges = {acKW:[1,10000],moduleCount:[1,100000],series:[1,100],pmax:[1,1500],voc:[1,200],vmp:[1,200],imp:[0.01,100],isc:[0.01,100],maxSeriesFuse:[0.1,200],maxSystemV:[100,1500]};
  for (const [key,[min,max]] of Object.entries(ranges)) {
    const value = body[key] === undefined ? DEFAULTS[key] : body[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`${key}: ${min}~${max} 범위의 숫자를 입력하세요.`);
    x[key] = value;
  }
  if (!Number.isInteger(x.moduleCount) || !Number.isInteger(x.series)) throw Error('모듈·직렬 수량은 정수로 입력하세요.');
  if (x.vmp >= x.voc || x.imp > x.isc) throw Error('Vmp < Voc, Imp ≤ Isc 조건을 확인하세요.');
  // Never silently discard modules or change the existing series count.
  if (x.moduleCount % x.series) throw Error(`전체 ${x.moduleCount}장은 기존 ${x.series}직렬로 나누어지지 않습니다. 나머지 ${x.moduleCount % x.series}장 — 기존 결선 수량을 확인하세요.`);
  x.strings = x.moduleCount / x.series;
  if (x.strings > 20000) throw Error('전체 스트링 수는 20,000개 이하로 입력하세요.');
  return x;
}
const f = n => Number(n.toFixed(3));
function designValues(x) {
  // STC nameplate values only. Removed temperature fields never affect selection.
  return {dcKW:x.moduleCount*x.pmax/1000,strings:x.strings,stringKW:x.series*x.pmax/1000,
    vocMax:x.voc*x.series,vocMin:x.voc*x.series,vmpMin:x.vmp*x.series,vmpMax:x.vmp*x.series,imp:x.imp,isc:x.isc};
}
function fuseReview(inv,x,v) {
  const minimumA=1.5*v.isc, maximumA=Math.min(2.4*v.isc,x.maxSeriesFuse);
  const options=(inv.stringFuseOptions||[]).map(o=>({...o,eligible:o.currentA+EPS>=minimumA && o.currentA<=maximumA+EPS && o.voltageV+EPS>=v.vocMax}));
  const selected=options.filter(o=>o.eligible).sort((a,b)=>a.currentA-b.currentA)[0]||null;
  const impossible=minimumA>maximumA+EPS;
  return {minimumA,maximumA,moduleLimitA:x.maxSeriesFuse,options,selected,status:impossible?'fail':selected?'catalog':'approval',
    reason:`${inv.model}: `+(impossible?`1개 스트링 STC Isc ${f(v.isc)}A × 1.5 = ${f(minimumA)}A > 모듈 Max Series Fuse ${x.maxSeriesFuse}A. 적용 참고 범위가 없습니다.`:selected?`등록 정격 ${selected.currentA}A / ${selected.voltageV}V가 참고 범위 ${f(minimumA)}~${f(maximumA)}A를 만족합니다. 실제 장착·접속 승인은 별도 확인이 필요합니다.`:`모듈 Max Series Fuse ${x.maxSeriesFuse}A와 비교하면, 등록 정격 ${options.map(o=>o.currentA+'A').join('·')||'없음'}는 허용 상한 ${f(maximumA)}A를 초과하거나 참고 범위 밖이므로 그대로 적용할 수 없습니다. ${f(minimumA)}~${f(maximumA)}A, ${f(v.vocMax)}V 이상 대체 퓨즈의 장착·보증·인증을 제조사가 승인하는 경우에만 재검토할 수 있습니다.`)};
}
function reviewInverter(inv,x,v) {
  const checks=[];
  const check=(code,label,value,limit,pass,unit,operator)=>checks.push({code,label,value,limit,pass,unit,operator});
  check('ac','1대 AC 용량',inv.kw,x.acKW,inv.kw<=x.acKW+EPS,'kW','≤');
  check('voc','STC 스트링 Voc',v.vocMax,Math.min(inv.dcMax,x.maxSystemV),v.vocMax<=Math.min(inv.dcMax,x.maxSystemV)+EPS,'V','≤');
  check('vmpMin','STC Vmp / MPPT 하한',v.vmpMin,inv.mppMin,v.vmpMin+EPS>=inv.mppMin,'V','≥');
  check('vmpMax','STC Vmp / MPPT 상한',v.vmpMax,inv.mppMax,v.vmpMax<=inv.mppMax+EPS,'V','≤');
  check('start','STC Voc / 기동전압',v.vocMin,inv.startV,v.vocMin+EPS>=inv.startV,'V','≥');
  const parallels=[];
  for(let p=1;p<=inv.portsPerMppt;p++) {
    const stringLimit=p===1 && inv.singleStringA?inv.singleStringA:inv.stringA;
    parallels.push({parallel:p,imp:v.imp*p,isc:v.isc*p,stringLimit,pass:v.imp<=stringLimit+EPS && v.imp*p<=inv.mpptA+EPS && v.isc*p<=inv.mpptIscA+EPS});
  }
  const maxParallel=parallels.filter(c=>c.pass).at(-1)?.parallel||0;
  check('current','1스트링 입력전류',v.imp,inv.singleStringA||inv.stringA,v.imp<=(inv.singleStringA||inv.stringA)+EPS,'A','≤');
  const fuse=fuseReview(inv,x,v);
  const failures=checks.filter(c=>!c.pass).map(c=>({code:c.code,text:`${c.label}: 계산 ${f(c.value)}${c.unit} / 허용 ${c.operator} ${c.limit}${c.unit} — 조건 미충족`}));
  if(!maxParallel) failures.push({code:'mpptCurrent',text:`STC 1스트링 Imp ${f(v.imp)}A / 단자 한도 ${inv.singleStringA||inv.stringA}A, MPPT Imp ${f(v.imp)}A / 한도 ${inv.mpptA}A, MPPT Isc ${f(v.isc)}A / 한도 ${inv.mpptIscA}A — 1병렬도 연결 불가`});
  if(fuse.status==='fail') failures.push({code:'fuse',text:fuse.reason});
  return {inverter:inv,checks,parallels,maxParallel,maxStrings:inv.mppt*maxParallel,fuse,eligible:!failures.length,failures,mainReason:failures[0]?.text||fuse.reason};
}
// Each existing string remains intact. Feasibility is count <= strings <= sum(capacities).
// Pareto states retain minimum unit count and maximum string capacity at each AC sum.
function compositions(models,strings,maxAC) {
  const limit=Math.floor(maxAC/2+EPS),states=Array.from({length:limit+1},()=>[]);
  states[0]=[{count:0,cap:0,counts:models.map(()=>0)}];
  let work=0;
  for(let ac=1;ac<=limit;ac++) {
    const candidates=[];
    for(let i=0;i<models.length;i++) {
      const m=models[i],before=ac-m.inverter.kw/2;
      if(before<0)continue;
      for(const state of states[before]) {
        if(++work>2000000) throw Error('조합 탐색 범위를 초과했습니다. 설비를 구간별로 나누어 검토하세요. 부분 탐색 결과는 선정안으로 사용하지 않습니다.');
        if(state.count>=strings)continue;
        const next={count:state.count+1,cap:Math.min(strings,state.cap+m.maxStrings),counts:[...state.counts]};next.counts[i]++;
        candidates.push(next);
      }
    }
    candidates.sort((a,b)=>a.count-b.count||b.cap-a.cap);
    let maxCap=-1;
    for(const c of candidates) if(c.cap>maxCap) {states[ac].push(c);maxCap=c.cap;}
  }
  return states.flatMap((list,ac)=>list.filter(s=>s.cap>=strings).map(s=>({acKW:ac*2,counts:s.counts,count:s.count})));
}
function allocate(candidate,reviews,x,v) {
  const units=[];
  candidate.counts.forEach((count,i)=>{for(let n=0;n<count;n++)units.push({review:reviews[i],strings:1});});
  // Discrete convex cost sum(n_i^2 / AC_i) balances DC load in proportion to AC rating.
  for(let remaining=x.strings-units.length;remaining>0;remaining--) {
    let best=null;
    for(const unit of units) if(unit.strings<unit.review.maxStrings && (!best || (2*unit.strings+1)/unit.review.inverter.kw < (2*best.strings+1)/best.review.inverter.kw-EPS))best=unit;
    if(!best)throw Error('전체 스트링 배분에 실패했습니다.');
    best.strings++;
  }
  return units.map((u,index)=>{
    const inv=u.review.inverter,base=Math.floor(u.strings/inv.mppt),extra=u.strings%inv.mppt;
    return {index:index+1,model:inv.model,kw:inv.kw,voltage:inv.voltage,strings:u.strings,modules:u.strings*x.series,dcKW:u.strings*v.stringKW,ratio:inv.kw/(u.strings*v.stringKW),mpptA:inv.mpptA,mpptIscA:inv.mpptIscA,portsPerMppt:inv.portsPerMppt,fuse:u.review.fuse,
      mppts:Array.from({length:inv.mppt},(_,i)=>{const p=base+(i<extra?1:0);return {index:i+1,parallel:p,series:p?x.series:0,modules:p*x.series,imp:p*v.imp,isc:p*v.isc};})};
  });
}
function calculate(body) {
  const input=normalizeInput(body),values=designValues(input);
  const reviews=INVERTERS.map(inv=>reviewInverter(inv,input,values));
  const eligible=reviews.filter(r=>r.eligible);
  const solutions=compositions(eligible,input.strings,input.acKW).filter(c=>c.acKW+EPS>=values.dcKW);
  // Preserve catalog-fuse plans even when a higher-current approval-only model
  // dominates their string capacity in the general Pareto search.
  const registeredIndices=eligible.flatMap((r,i)=>r.fuse.status==='catalog'?[i]:[]);
  if(registeredIndices.length && registeredIndices.length<eligible.length) {
    const registered=registeredIndices.map(i=>eligible[i]);
    for(const c of compositions(registered,input.strings,input.acKW)) {
      if(c.acKW+EPS<values.dcKW)continue;
      const counts=eligible.map(()=>0);
      registeredIndices.forEach((index,i)=>{counts[index]=c.counts[i];});
      solutions.push({...c,counts});
    }
  }
  const approvalCount=c=>c.counts.reduce((sum,n,i)=>sum+(eligible[i].fuse.status==='approval'?n:0),0);
  // Preserve the established no-DC-oversizing rule. There is no adjustable ratio target.
  const compare=(a,b)=>Math.abs(a.acKW-values.dcKW)-Math.abs(b.acKW-values.dcKW)||approvalCount(a)-approvalCount(b)||a.count-b.count||b.acKW-a.acKW;
  solutions.sort(compare);
  const choices=[],seen=new Set();
  const add=c=>{const key=c.counts.join(',');if(!seen.has(key)){seen.add(key);choices.push(c);}};
  if(solutions[0])add(solutions[0]);
  // Keep homogeneous alternatives visible even if dominated in the Pareto search.
  for(let i=0;i<eligible.length;i++) {
    const r=eligible[i],min=Math.max(Math.ceil(input.strings/r.maxStrings),Math.ceil(values.dcKW/r.inverter.kw-EPS)),max=Math.min(Math.floor(input.acKW/r.inverter.kw+EPS),input.strings);
    const ideal=values.dcKW/r.inverter.kw;
    const numbers=new Set([min,max,Math.floor(ideal),Math.ceil(ideal)]);
    const homogeneous=[...numbers].filter(n=>n>=min&&n<=max).map(n=>({acKW:n*r.inverter.kw,count:n,counts:eligible.map((_,j)=>i===j?n:0)})).sort(compare);
    if(homogeneous[0])add(homogeneous[0]);
  }
  const mixed=solutions.find(c=>c.counts.filter(Boolean).length>1);if(mixed)add(mixed);
  for(const c of solutions) {if(choices.length>=10)break;add(c);}
  choices.sort(compare);
  const plans=choices.slice(0,10).map((c,index)=>{
    const rows=c.counts.flatMap((count,i)=>count?[{model:eligible[i].inverter.model,kw:eligible[i].inverter.kw,count}]:[]),units=allocate(c,eligible,input,values);
    const alternativeFuse=units.some(u=>u.fuse.status==='approval');
    const ratio=c.acKW/values.dcKW;
    return {id:'P'+(index+1),rows,count:c.count,acKW:c.acKW,ratio,status:'conditional',alternativeFuse,units,allocatedModules:units.reduce((n,u)=>n+u.modules,0),
      reasons:[`기존 ${input.series}직렬 × ${input.strings}스트링 = ${input.moduleCount}장 전량 배분`, `AC ${c.acKW}kW ≤ 기존 ${input.acKW}kW${Math.abs(c.acKW-input.acKW)<EPS?' (용량 일치)':' (AC 용량 감소)'}`,`실제 AC/DC ${f(ratio)} (AC ${c.acKW}kW / DC ${f(values.dcKW)}kWp)`, `STC 기준 · 온도계수·현장 최저기온·설계 모듈 최고온도 검토 제외 · 목표 AC/DC 설정 없음`,`사용 MPPT의 합산 Imp·Isc 및 단자 수 제한 충족`,...(alternativeFuse?['등록된 퓨즈로는 적용 불가. 제조사 승인 대체 퓨즈를 전제로 한 검토안입니다.']:['등록 퓨즈 정격 범위 충족. 실제 장착 정격·제조사 접속 승인 확인 필요.'])]};
  });
  for(const r of reviews) {
    const maxUnits=Math.min(input.strings,Math.floor(input.acKW/r.inverter.kw+EPS)),capacity=maxUnits*r.maxStrings;
    r.homogeneousCapacity=capacity;
    const requiredUnits=Math.max(Math.ceil(input.strings/(r.maxStrings||1)),Math.ceil(values.dcKW/r.inverter.kw-EPS));
    r.homogeneousAvailable=r.eligible && requiredUnits<=maxUnits;
    const reasons=r.failures.map(f=>f.text);
    if(capacity<input.strings)reasons.push(`기존 AC ${input.acKW}kW 이내 최대 ${maxUnits}대 × 1대 ${r.maxStrings}스트링 = ${capacity}스트링 < 필요 ${input.strings}스트링. 전체 모듈 연결 불가.`);
    if(maxUnits*r.inverter.kw+EPS<values.dcKW)reasons.push(`기존 AC 이내 최대 합계 ${maxUnits*r.inverter.kw}kW < 모듈 DC ${f(values.dcKW)}kWp. AC/DC ${maxUnits ? f((maxUnits*r.inverter.kw)/values.dcKW) : '산출 불가'}로 용량 조건 미충족.`);
    if(r.fuse.status==='approval')reasons.push(r.fuse.reason);
    r.comparisonReasons=reasons;
    r.homogeneousReason=r.homogeneousAvailable?`동일 모델 ${requiredUnits}~${maxUnits}대에서 전량 연결·용량 조건 충족. ${r.fuse.reason}`:reasons.join(' ');
  }
  return {modelCatalogVersion:1,input,values,reviews,plans,searchComplete:true,
    selectionPolicy:'STC 기준 / 기존 직렬·전체 모듈 유지 / 모듈 DC ≤ 인버터 AC 합계 ≤ 기존 AC / DC·AC 용량 차이 최소 → 등록 퓨즈 충족 우선 → 대수 최소 → 용량 비례·MPPT 균등 배분',
    calculationBasis:{mode:'STC',temperatureCorrection:false,excluded:['온도계수','현장 최저기온','설계 모듈 최고온도'],targetRatio:null,ratioDefinition:'AC/DC = 인버터 AC 용량 ÷ 모듈 STC DC 용량'},
    assumptions:['온도계수·현장 최저기온·설계 모듈 최고온도를 적용하지 않은 STC 기준 예비 검토입니다. 저온 최대전압·고온 운전전압 및 온도에 따른 전류 변화는 검증하지 않았습니다.',
      '목표 AC/DC 비율은 설정하지 않습니다. 선정된 구성의 실제 AC/DC 비율을 표시하며, 모듈 DC 용량이 인버터 AC 합계를 넘는 구성은 제외합니다.',
      'MPPT별 DC 전력 한도·허용 과대설계·실제 포트 연결·케이블·커넥터·접지·보호설계는 미검증입니다.',
      '1.5~2.4 × STC Isc는 기존 계산기의 참고 선정 조건이며 법적 적합성이나 제조사 승인 근거가 아닙니다.',
      '제품 데이터에는 퓨즈 선택지가 있으며 실제 장착 퓨즈·교체 승인 상태는 없습니다. 모든 선정안은 조건부입니다.',
      `모듈 최대 시스템전압 ${input.maxSystemV}V는 입력값이며 실제 모듈 자료 확인이 필요합니다.`],calculatedAt:new Date().toISOString()};
}
module.exports={DEFAULTS,normalizeInput,calculate,reviewInverter,designValues,compositions};
const {isMainThread,parentPort,workerData}=require('node:worker_threads');
if(!isMainThread&&workerData?.repoweringJob){try{parentPort.postMessage({result:calculate(workerData.input)});}catch(e){parentPort.postMessage({error:e.message});}}
