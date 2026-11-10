'use strict';
(()=>{
  const $=id=>document.getElementById(id),form=$('repoweringForm');
  let result=null,activePlan=null,revision=0,pending=null,catalogReady=false;
  const number=n=>Number(n).toLocaleString('ko-KR',{maximumFractionDigits:3});
  const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  function message(text,error=false){$('inputMessage').textContent=text;$('inputMessage').classList.toggle('error',error);}
  function stringSummary(){
    const count=Number($('moduleCount').value),series=Number($('series').value);
    $('stringSummary').textContent=Number.isInteger(count)&&count>0&&Number.isInteger(series)&&series>0
      ?count%series?`전체 ${number(count)}장 ÷ ${series}직렬: 나머지 ${count%series}장. 결선 수량을 확인하세요.`:`전체 병렬 스트링: ${number(count)}장 ÷ ${series}직렬 = ${number(count/series)}개`
      :'전체 모듈·직렬 수량을 입력하면 병렬 스트링 수를 자동 계산합니다.';
  }
  function clearResult(){
    result=null;activePlan=null;$('quoteBtn').disabled=true;$('diagram').hidden=true;$('diagramEmpty').hidden=false;
    $('diagramEmpty').textContent='변경된 입력으로 자동 선정을 실행해 주세요.';
    $('inverterSelect').disabled=true;$('inverterSelect').replaceChildren(node('option','계산 후 선택'));
    $('candidates').replaceChildren();$('metrics').replaceChildren();
    $('modelReviews').replaceChildren(node('p','변경된 입력으로 각 모델을 다시 검토합니다.','empty'));
    $('resultSummary').textContent='입력값이 변경되었습니다. 자동 선정을 다시 실행해 주세요.';
    $('verification').replaceChildren(node('p','계산 전입니다.','note'));
  }
  async function loadCatalog(signal){
    const response=await fetch('/api/repowering/catalog',{cache:'no-store',signal:signal||AbortSignal.timeout(10000)});
    if(!response.ok)throw Error(`인버터 자료를 읽지 못했습니다. HTTP ${response.status}`);
    const data=await response.json();
    if(!Array.isArray(data.inverters)||!data.inverters.length)throw Error('인버터 자료가 비어 있습니다.');
    catalogReady=true;return data.inverters.length;
  }
  const selectedPlan=()=>result?.plans.find(p=>p.id===activePlan);
  function renderDiagram(){
    const plan=selectedPlan(),unit=plan?.units[Number($('inverterSelect').value)||0];
    if(!unit)return;
    $('diagramEmpty').hidden=true;$('diagram').hidden=false;
    $('inverterTitle').textContent=`INV-${unit.index} · ${unit.kw}kW · ${unit.model}`;
    $('mpptGrid').style.setProperty('--columns',Math.min(6,unit.mppts.length));
    $('mpptGrid').replaceChildren(...unit.mppts.map(m=>{
      const card=node('article',undefined,'mppt'+(!m.parallel?' unused':''));
      const body=node('div',undefined,'mppt-body');
      body.append(node('div',m.parallel?'▦ '.repeat(m.parallel).trim():'—','panel-symbols'),node('strong',`${m.parallel} 스트링`),node('p',m.parallel?`${m.series}직렬 × ${m.parallel}병렬`:'미사용'),node('p',`Imp ${number(m.imp)} A`),node('p',`Isc ${number(m.isc)} A`));
      card.append(node('h3',`MPPT ${m.index}`),body);return card;
    }));
    $('diagramSummary').textContent=`선택 인버터: ${unit.strings}스트링 · ${unit.modules}장 · AC ${unit.kw}kW / DC ${number(unit.dcKW)}kWp · AC/DC ${number(unit.ratio)}`;
    $('unitChecks').replaceChildren(node('p',`MPPT별 허용 입력전류 ${unit.mpptA}A / 단락전류 ${unit.mpptIscA}A / 입력단자 ${unit.portsPerMppt}개. 전류는 온도 보정 없는 STC 기준입니다.`),node('p',unit.fuse.reason,'fuse-note'));
  }
  function activatePlan(id){
    activePlan=id;const plan=selectedPlan();if(!plan)return;
    $('inverterSelect').disabled=false;
    $('inverterSelect').replaceChildren(...plan.units.map((u,i)=>{const op=node('option',`INV-${u.index} · ${u.model} · ${u.strings}스트링`);op.value=i;return op;}));
    for(const card of $('candidates').children){const active=card.dataset.id===id;card.classList.toggle('active',active);const button=card.querySelector('button');if(button){button.setAttribute('aria-pressed',String(active));button.textContent=active?'선택한 구성안':'이 구성도 보기';}}
    $('quoteBtn').disabled=false;renderDiagram();renderVerification();
  }
  function renderVerification(){
    const plan=selectedPlan();if(!plan)return;
    const badges=node('div');
    for(const text of ['모듈 전량 배분','직렬 유지','전압·MPPT 전류 범위'])badges.append(node('span',text+' 충족','badge'));
    badges.append(node('span',`실제 AC/DC ${number(plan.ratio)}`,'badge warning'),node('span','퓨즈·제조사 승인 확인 필요','badge warning'));
    const ul=node('ul');for(const text of result.assumptions)ul.append(node('li',text));
    $('verification').replaceChildren(badges,ul);
  }
  function renderResults(){
    const {input,values,plans,reviews}=result;
    $('selectionPolicy').textContent=result.selectionPolicy;
    const metric=(label,value)=>{const n=node('div',undefined,'metric');n.append(node('span',label),node('strong',value));return n;};
    $('metrics').replaceChildren(metric('전체 모듈 DC 용량',`${number(values.dcKW)} kWp`),metric('전체 병렬 스트링',`${number(values.strings)} 개`),metric('STC Voc / 스트링',`${number(values.vocMax)} V`),metric('STC Vmp / 스트링',`${number(values.vmpMin)} V`),metric('STC Imp / 1스트링',`${number(values.imp)} A`),metric('STC Isc / 1스트링',`${number(values.isc)} A`),metric('기존 AC 용량',`${number(input.acKW)} kW`),metric('계산 기준','STC · 온도 검토 제외'));
    $('resultSummary').textContent=plans.length?`${plans.length}개 조건부 검토안. 기존 직렬 유지·전량 배분 및 용량 조건을 만족하는 범위에서 DC·AC 용량 차이가 작은 순으로 표시합니다. 퓨즈 대체가 필요한 구성은 제조사 승인 전 사용 가능한 선정안이 아닙니다.`:'현재 입력 조건으로 전량 배분 가능한 구성이 없습니다. 아래 모델별 미선정 원인을 확인하세요.';
    $('candidates').replaceChildren(...plans.map((p,index)=>{
      const card=node('article',undefined,'candidate');card.dataset.id=p.id;
      card.append(node('span',`${index===0?'우선 검토안':'비교안'} · ${p.alternativeFuse?'대체 퓨즈 승인 전제':'조건부 적합'}`,'badge warning'),node('h3',p.rows.map(r=>`${r.kw}kW × ${r.count}대`).join(' + ')),node('div',p.rows.map(r=>r.model).join(' / '),'model-line'));
      const ul=node('ul');for(const reason of p.reasons)ul.append(node('li',reason));card.append(ul);
      const button=node('button','이 구성도 보기');button.type='button';button.addEventListener('click',()=>activatePlan(p.id));card.append(button);return card;
    }));
    if(plans.length===1){
      const excluded=reviews.filter(r=>!r.homogeneousAvailable&&r.inverter.kw<=input.acKW).sort((a,b)=>a.inverter.kw-b.inverter.kw)[0];
      if(excluded){
        const card=node('article',undefined,'candidate rejected');
        const count=Math.ceil(input.strings/(excluded.maxStrings||excluded.inverter.strings));
        card.append(node('span','미선정 비교','badge fail'),node('h3',`${excluded.inverter.kw}kW × ${count}대 검토`),node('div',excluded.inverter.model,'model-line'),node('p',excluded.homogeneousReason||excluded.mainReason,'rejection-reason'),node('p',excluded.fuse.reason,'note'));
        $('candidates').append(card);
      }
    }
    $('modelReviews').replaceChildren(...reviews.map(r=>{
      const card=node('article',undefined,'model-review');
      card.append(node('h3',`${r.inverter.kw}kW · ${r.inverter.model}`),node('span',r.homogeneousAvailable?'조건부 검토 가능':r.eligible?'단독 구성 미선정':'미선정','badge'+(r.homogeneousAvailable?' warning':' fail')));
      const reasons=node('ul',undefined,'comparison-reasons');
      for(const reason of r.comparisonReasons)reasons.append(node('li',reason));
      if(!r.comparisonReasons.length)reasons.append(node('li',r.homogeneousReason));
      card.append(reasons);
      const details=node('details'),list=node('ul');details.append(node('summary','전압·전류·퓨즈 전체 비교 수치'));
      for(const c of r.checks)list.append(node('li',`${c.pass?'✓':'×'} ${c.label}: 계산 ${number(c.value)}${c.unit} / 기준 ${c.operator} ${number(c.limit)}${c.unit}${c.pass?' 충족':' 미충족'}`));
      for(const p of r.parallels)list.append(node('li',`${p.pass?'✓':'×'} MPPT ${p.parallel}병렬: Imp ${number(p.imp)}A / 허용 ≤ ${r.inverter.mpptA}A, Isc ${number(p.isc)}A / 허용 ≤ ${r.inverter.mpptIscA}A, 1스트링 Imp ${number(values.imp)}A / 단자 허용 ≤ ${p.stringLimit}A — ${p.pass?'충족':'미충족'}`));
      list.append(node('li',`전류 조건 허용: MPPT당 최대 ${r.maxParallel}스트링 · 1대 최대 ${r.maxStrings}스트링`),node('li',r.fuse.reason));
      list.append(node('li',`퓨즈 참고 범위: STC Isc ${number(values.isc)}A × 1.5 = ${number(r.fuse.minimumA)}A 이상 / min(Isc × 2.4, 모듈 Max Series Fuse) = ${number(r.fuse.maximumA)}A 이하 / 스트링 Voc ${number(values.vocMax)}V 이상`));
      for(const o of r.fuse.options)list.append(node('li',`${o.eligible?'✓':'×'} 등록 퓨즈 ${number(o.voltageV)}V / ${number(o.currentA)}A — ${o.eligible?'범위 충족':'범위 미충족'}`));
      details.append(list);card.append(details);return card;
    }));
    if(plans.length)activatePlan(plans[0].id);else{
      $('diagram').hidden=true;$('diagramEmpty').hidden=false;$('diagramEmpty').textContent='전량 배분 가능한 구성이 없어 구성도를 표시하지 않습니다.';
      $('inverterSelect').disabled=true;$('inverterSelect').replaceChildren(node('option','선정안 없음'));
      const list=node('ul');for(const text of result.assumptions)list.append(node('li',text));$('verification').replaceChildren(node('p','선정안 없음 · 조건을 수정한 뒤 다시 계산하세요.'),list);
    }
  }
  function quoteRequest(plan){
    const {input:x,values:v}=result;
    const groups=new Map();
    for(const unit of plan.units){
      const mppts=new Map();
      for(const m of unit.mppts){const label=m.parallel?`${m.series}직렬×${m.parallel}병렬`:'미사용';mppts.set(label,(mppts.get(label)||0)+1);}
      const pattern=[...mppts].map(([label,count])=>`${label} MPPT ${count}개`).join(', ');
      const key=JSON.stringify([unit.model,unit.modules,unit.strings,pattern]);
      const g=groups.get(key)||{unit,pattern,count:0};g.count++;groups.set(key,g);
    }
    return [
      '[리파워링 인버터 교체 견적 요청]',
      `기존 발전소 AC ${number(x.acKW)}kW / 기존 모듈 ${number(x.pmax)}W × ${x.moduleCount}장 = ${number(v.dcKW)}kWp / ${x.series}직렬 × ${v.strings}스트링`,
      `모듈 Voc ${number(x.voc)}V, Vmp ${number(x.vmp)}V, Imp ${number(x.imp)}A, Isc ${number(x.isc)}A, Max Series Fuse ${number(x.maxSeriesFuse)}A`,
      `교체 검토: ${plan.rows.map(r=>`${r.model} (${r.kw}kW) × ${r.count}대`).join(' + ')}`,
      `선정 AC 합계 ${number(plan.acKW)}kW / 실제 AC/DC ${number(plan.ratio)} / 기존 모듈 ${plan.allocatedModules}장 전량 배분`,
      ...[...groups.values()].map(({unit:u,pattern,count})=>`${u.model} ${count}대: 각 ${u.modules}장·${u.strings}스트링·DC ${number(u.dcKW)}kWp / ${pattern}`),
      `STC 스트링 Voc ${number(v.vocMax)}V / Vmp ${number(v.vmpMin)}V`,
      '온도계수·현장 최저기온·설계 모듈 최고온도 검토 제외. 목표 AC/DC 설정 없음.',
      ...[...new Set(plan.units.map(u=>u.fuse.reason))],
      '조건부 예비 검토안: 퓨즈 및 제조사 접속 조건 확인 필요. 기존 모듈은 현장 정보이며 신규 구매 수량에 포함하지 않습니다.'
    ].join('\n');
  }
  $('quoteBtn').addEventListener('click',()=>{
    const plan=selectedPlan();if(!plan){message('현재 입력으로 자동 선정을 실행하고 구성안을 선택하세요.',true);return;}
    const request=quoteRequest(plan);
    if(request.length>2000){message('설계 요약이 추가 요청사항의 2,000자 한도를 초과했습니다. 내용을 줄여 연동할 수 있도록 구성안을 확인하세요.',true);return;}
    try{
      sessionStorage.setItem('solar-repowering-quote-v1',JSON.stringify({version:1,createdAt:Date.now(),request}));
      location.assign('quote.html?from=repowering');
    }catch{message('견적 연결 정보를 보관하지 못했습니다. 브라우저 저장소 설정을 확인하세요.',true);}
  });
  form.addEventListener('input',()=>{stringSummary();revision++;pending?.abort();$('runBtn').disabled=false;$('resultArea').setAttribute('aria-busy','false');clearResult();message('입력값이 변경되었습니다. 자동 선정을 다시 실행하세요.');});
  form.addEventListener('change',()=>{stringSummary();});
  $('inverterSelect').addEventListener('change',renderDiagram);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!form.reportValidity())return;
    const sequence=++revision;pending?.abort();const controller=new AbortController();pending=controller;
    const timer=setTimeout(()=>controller.abort(),35000);$('runBtn').disabled=true;$('resultArea').setAttribute('aria-busy','true');message('실제 인버터 사양으로 조합과 MPPT 배분을 검토하고 있습니다.');
    try{
      if(!catalogReady)await loadCatalog(controller.signal);
      const input=Object.fromEntries([...new FormData(form)].map(([k,v])=>[k,Number(v)]));
      const response=await fetch('/api/repowering/calculate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});
      const data=await response.json();if(!response.ok)throw Error(data.message||'계산에 실패했습니다.');if(sequence!==revision)return;
      if(data.modelCatalogVersion!==1)throw Error('리파워링 서버 파일을 적용하고 Node.js 서버를 재시작해 주세요.');
      result=data;renderResults();message(`검토 완료 · ${data.plans.length}개 조건부 검토안 · 기존 모듈 ${data.input.moduleCount}장 / ${data.input.series}직렬 유지`);
    }catch(e){if(sequence!==revision)return;clearResult();$('resultSummary').textContent='계산 결과가 없습니다. 입력 또는 서버 연결을 확인하세요.';message(e.name==='AbortError'?'계산 시간이 초과되었습니다. 조건을 확인하고 다시 실행하세요.':e.message,true);}
    finally{clearTimeout(timer);if(sequence===revision){$('runBtn').disabled=false;$('resultArea').setAttribute('aria-busy','false');}}
  });
  stringSummary();
  loadCatalog().then(count=>{if(!revision)message(`등록 인버터 ${count}종 준비 완료. 모듈 사양을 입력하고 자동 선정을 실행하세요.`);}).catch(e=>{if(!revision)message('자료를 불러오지 못했습니다. 자동 선정 버튼으로 다시 시도할 수 있습니다. '+e.message,true);});
})();
