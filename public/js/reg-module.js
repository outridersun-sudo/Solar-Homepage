'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let csrf='', rows=[], importId='', objectUrl='', busy=false, duplicate=false, dirty=false;
  let extractedModels=[],pdfPages=0,selectedCandidate=null,isSaving=false,lastSaveError='';
  const groups = {
    basic:[['manufacturer','제조사','','text'],['series','시리즈','','text'],['name','모델명','','text']],
    stc:[['p','정격 출력 (Pmax)','W'],['eff','모듈 효율','%'],['voc','개방전압 (Voc)','V'],['vmp','최대출력전압 (Vmp)','V'],['isc','단락전류 (Isc)','A'],['imp','최대출력전류 (Imp)','A'],['maxV','최대 시스템 전압','V']],
    coefficient:[['betaVoc','Voc 온도계수','%/℃'],['alphaIsc','Isc 온도계수','%/℃'],['gammaPower','Pmax 온도계수','%/℃'],['maxSeriesFuse','최대 직렬 퓨즈 정격','A']],
    bnpi:[['bnpi','양면 기준 출력','W'],['bnpiVoc','양면 기준 Voc','V'],['bnpiVmp','양면 기준 Vmp','V'],['bnpiIsc','양면 기준 Isc','A'],['bnpiImp','양면 기준 Imp','A']],
    optional:[['type','제품 유형','','text'],['cells','셀 구성','','text'],['weight','무게','','text'],['warranty','보증 정보','','text']]
  };
  for (const [group, fields] of Object.entries(groups)) for (const [key,label,unit,type] of fields) {
    const wrapper=document.createElement('label'); wrapper.className='field'; wrapper.htmlFor=key;
    const title=document.createElement('span'); title.textContent=label+(group==='optional'?'':' *');
    const badge=document.createElement('em'); badge.hidden=true; badge.textContent='추출됨'; title.append(badge);
    const box=document.createElement('div'); box.className='input-wrap';
    const input=document.createElement('input'); input.id=key; input.name=key; input.type=type || 'number'; input.required=group!=='optional';if(group==='bnpi')input.readOnly=true;
    if(type==='text') input.maxLength=group==='optional'?200:150;
    else {input.step='any'; input.min=['betaVoc','gammaPower'].includes(key)?'-2':key==='alphaIsc'?'-1':'0.01'; input.max=key==='betaVoc'?'-0.001':key==='gammaPower'?'0':key==='alphaIsc'?'1':key==='eff'?'50':'3000';}
    box.append(input);
    if(unit){const span=document.createElement('span');span.className='unit';span.textContent=unit;box.append(span);}
    wrapper.append(title,box); $(group+'-fields').append(wrapper);
  }
  const identity=text=>text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu,'');
  function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
  function blockReason(){
    if(!selectedCandidate)return extractedModels.length?'등록할 모델을 선택하세요.':'양면 여부 미확인: 이 페이지에서 모델과 양면 사양을 읽지 못했습니다. 사양표 페이지 또는 PDF를 확인하세요.';
    if(!selectedCandidate.registration?.allowed)return selectedCandidate.registration?.message || '양면 여부 미확인: 이 PDF의 제품과 적용 조건을 확인할 수 없습니다.';
    for(const fields of Object.values(groups))for(const [key,label,,type]of fields)if(type!=='text' && !$(key).validity.valid)return '필수 사양 부족: '+label+' 항목의 값과 단위를 확인하세요.';
    return '';
  }
  function updateSave(){
    const reason=blockReason();
    const basic=groups.basic.find(([key])=>!$(key).validity.valid);
    const pending=!importId?'PDF를 먼저 불러오세요.':(extractedModels.length>0 && !$('extracted-model').value)?'등록할 모델을 먼저 선택하세요.':duplicate?'동일한 제조사·모델명이 이미 등록되어 있습니다.':reason || (basic?basic[1]+' 항목을 입력하세요.':'');
    $('save').disabled=busy || !!pending;
    $('save').textContent=busy?(isSaving?'등록 중…':'다른 작업 처리 중…'):'검토 완료 후 모듈 등록';
    $('save').title=busy?'서버 응답을 기다리고 있습니다.':pending || '등록 준비 완료';
    $('save-status').textContent=busy?(isSaving?'서버에 등록 요청을 보내고 있습니다. 잠시 기다려 주세요.':'다른 작업이 끝나면 등록할 수 있습니다.'):pending || lastSaveError || '';
    $('save-status').classList.toggle('error',!!lastSaveError && !pending && !busy);
  }
  function fillFields(fields){
    for(const group of Object.values(groups))for(const [key] of group){const input=$(key);input.value='';input.classList.remove('extracted','invalid');input.closest('label').querySelector('em').hidden=true;}
    for(const [key,value] of Object.entries(fields)){const input=$(key);if(input && input.closest('.field')){input.value=value;input.classList.add('extracted');input.closest('label').querySelector('em').hidden=false;}}
    dirty=false;duplicates();
  }
  function showModel(model){
    selectedCandidate=model || null;
    const fields={...(model?.fields || {}),...(model?.registration?.mode==='gain10'?model.substitute10:{})};
    fillFields(fields);
    $('rear-spec-help').textContent=model?.registration?.allowed?(model.registration.mode==='gain10'?'발전 증가율 10% 대체 사양 자동 적용 — BNPI와 다른 조건이며 계산은 고정 10% 시나리오입니다.':'실제 BNPI 사양 자동 적용 — 후면 일사 13.5% 기준입니다.'):'PDF의 양면 적용 사양을 확인할 수 없습니다.';
    $('model-warning').hidden=!model?.warnings?.length;
    $('model-warning').textContent=model?.warnings?.join('\n') || '';
    $('condition-summary').replaceChildren();
    for(const condition of model?.conditions || []){
      const p=document.createElement('p');p.className='hint';
      p.textContent=condition.label+(condition.values?' — '+Object.entries(condition.values).map(([key,value])=>key+': '+value).join(' / '):'');
      $('condition-summary').append(p);
    }
  }
  $('extracted-model').onchange=()=>{
    if(dirty && !confirm('다른 모델을 선택하면 입력한 사양이 초기화됩니다. 계속할까요?')){
      $('extracted-model').value=$('extracted-model').dataset.previous || '';return;
    }
    $('extracted-model').dataset.previous=$('extracted-model').value;
    showModel(extractedModels.find(model=>model.id===$('extracted-model').value));
  };
  function duplicates(){
    duplicate=rows.some(row=>identity(row.manufacturer)===identity($('manufacturer').value) && identity(row.name)===identity($('name').value));
    $('duplicate').hidden=!duplicate;
    $('duplicate').textContent='동일한 제조사·모델명이 이미 존재합니다. 시리즈나 사양이 달라도 중복 등록할 수 없습니다.';
    $('name').classList.toggle('invalid',duplicate); updateSave();
  }
  async function api(url,options={}) {
    const headers={'X-CSRF-Token':csrf};
    if(options.body && !(options.body instanceof FormData))headers['Content-Type']='application/json';
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),url.includes('/import')?90000:20000);
    try{
      const response=await fetch('/api/admin'+url,{...options,headers,cache:'no-store',signal:controller.signal});
      let data;try{data=await response.json();}catch(error){if(controller.signal.aborted)throw error;throw new Error('서버 응답을 확인하지 못했습니다. 다시 등록하기 전에 목록을 새로고침하세요.');}
      if(response.status===401){$('management').hidden=true;csrf='';reset();throw new Error('관리자 로그인이 만료되었습니다. 상단 A/S 관리에서 다시 로그인하세요.');}
      if(!response.ok)throw Object.assign(new Error(data.message || '처리에 실패했습니다.'),{data});
      return data;
    }catch(error){
      if(controller.signal.aborted)throw new Error('서버 응답 대기 시간이 초과되었습니다. 등록이 완료되었을 수 있으므로 다시 제출하기 전에 목록 새로고침으로 확인하세요.');
      throw error;
    }finally{clearTimeout(timeout);}
  }
  function render(){
    const term=$('search').value.trim().toLocaleLowerCase('ko-KR'),manufacturer=$('manufacturer-filter').value;
    const visible=rows.filter(row=>(!manufacturer || row.manufacturer===manufacturer) && [row.manufacturer,row.series,row.name].join(' ').toLocaleLowerCase('ko-KR').includes(term));
    $('module-count').textContent=rows.length;$('rows').replaceChildren();
    for(const row of visible){
      const tr=document.createElement('tr');
      for(const value of [row.manufacturer,null,row.p+' W',row.voc+' / '+row.vmp+' V',null]){const td=document.createElement('td');if(value!==null)td.textContent=value;tr.append(td);}
      const small=document.createElement('small');small.textContent=row.series;
      const strong=document.createElement('strong');strong.textContent=row.name;tr.children[1].append(small,strong);
      const status=document.createElement('span');status.className='status';status.textContent=row.rearSpecMode==='gain10'?'사용 중 · 10% 대체':'계산기 사용 중';tr.children[4].append(status);$('rows').append(tr);
    }
    if(!visible.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='검색 결과가 없습니다.';tr.append(td);$('rows').append(tr);}
  }
  async function list(){
    rows=(await api('/modules')).rows;
    const previous=$('manufacturer-filter').value;
    $('manufacturer-filter').replaceChildren(new Option('전체 제조사',''),...[...new Set(rows.map(r=>r.manufacturer))].map(name=>new Option(name,name)));
    if([...$('manufacturer-filter').options].some(o=>o.value===previous))$('manufacturer-filter').value=previous;
    render();duplicates();
  }
  function reset(){
    importId='';dirty=false;duplicate=false;lastSaveError='';$('module-form').reset();$('review').hidden=true;
    selectedCandidate=null;extractedModels=[];pdfPages=0;$('model-selection').hidden=true;$('extracted-model').replaceChildren(new Option('모델을 선택하세요',''));$('extracted-model').dataset.previous='';
    $('pdf-preview').removeAttribute('src');$('pdf-preview').hidden=true;$('preview-help').hidden=false;$('open-pdf').removeAttribute('href');
    if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl='';
    document.querySelectorAll('.field input').forEach(input=>{input.classList.remove('extracted','invalid');const badge=input.closest('label').querySelector('em');if(badge)badge.hidden=true;});
    updateSave();
  }
  async function discard(){const id=importId;reset();if(id)await api('/modules/import/'+encodeURIComponent(id),{method:'DELETE'});}
  async function run(action,saving=false){
    if(busy)return;busy=true;isSaving=saving;lastSaveError='';document.body.dataset.busy='true';$('management').setAttribute('aria-busy','true');message('');
    ['analyze','cancel','refresh','pdf-file','source-page','extracted-model'].forEach(id=>$(id).disabled=true);updateSave();
    try{await action();}catch(error){if(saving)lastSaveError=error.message;message(error.message,true);}
    finally{busy=false;isSaving=false;delete document.body.dataset.busy;$('management').setAttribute('aria-busy','false');['analyze','cancel','refresh','pdf-file','source-page','extracted-model'].forEach(id=>$(id).disabled=false);$('analysis-status').textContent='한 번에 한 페이지를 분석합니다.';updateSave();}
  }
  function preview(data){
    if(data?.pages)pdfPages=data.pages;
    if(!objectUrl)objectUrl=URL.createObjectURL($('pdf-file').files[0]);
    if(data?.previewImage){$('pdf-preview').src=data.previewImage;$('pdf-preview').hidden=false;$('preview-help').hidden=true;}
    $('open-pdf').href=objectUrl+'#page='+$('source-page').value;$('review').hidden=false;
  }
  $('pdf-file').onchange=()=>{
    const id=importId;reset();if(id)api('/modules/import/'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{});
    $('filename').textContent=$('pdf-file').files[0]?.name || 'PDF를 끌어놓거나 클릭해 선택하세요';
  };
  for(const event of ['dragenter','dragover'])$('dropzone').addEventListener(event,e=>{e.preventDefault();if(!busy)$('dropzone').classList.add('drag');});
  $('dropzone').addEventListener('dragleave',()=>$('dropzone').classList.remove('drag'));
  $('dropzone').addEventListener('drop',event=>{
    event.preventDefault();$('dropzone').classList.remove('drag');if(busy)return;
    if(event.dataTransfer.files.length!==1)return message('PDF 한 개만 선택하세요.',true);
    const transfer=new DataTransfer();transfer.items.add(event.dataTransfer.files[0]);$('pdf-file').files=transfer.files;$('pdf-file').onchange();
  });
  $('upload-form').onsubmit=event=>{
    event.preventDefault();
    if(dirty && !confirm('페이지를 다시 분석하면 입력한 사양이 초기화됩니다. 계속할까요?'))return;
    run(async()=>{
      const file=$('pdf-file').files[0];
      if(!file || !/\.pdf$/i.test(file.name) || file.size===0 || file.size>20*1024*1024)throw new Error('20MB 이하의 PDF 파일 한 개를 선택하세요.');
      $('analysis-status').textContent='PDF에서 텍스트를 추출하고 미리보기를 만들고 있습니다.';
      let data;
      try{
        if(importId)data=await api('/modules/import/'+encodeURIComponent(importId)+'/extract',{method:'POST',body:JSON.stringify({page:Number($('source-page').value)})});
        else{const form=new FormData();form.set('file',file);form.set('page',$('source-page').value);data=await api('/modules/import',{method:'POST',body:form});}
      }catch(error){
        if(error.data?.importId){importId=error.data.importId;preview();$('extracted-text').textContent='분석에 실패했습니다. 사양표 페이지를 바꾸거나 원본을 보며 직접 입력하세요.';}
        throw error;
      }
      const id=data.importId;reset();importId=id;preview(data);
      extractedModels=data.models || [];
      $('model-selection').hidden=!extractedModels.length;
      for(const model of extractedModels)$('extracted-model').add(new Option(model.label,model.id));
      fillFields(data.fields);
      if(extractedModels.length===1){$('extracted-model').value=extractedModels[0].id;$('extracted-model').dataset.previous=extractedModels[0].id;showModel(extractedModels[0]);}
      $('extracted-text').textContent=data.text || '읽을 수 있는 텍스트가 없습니다. 원본을 확인해 직접 입력하세요.';
      duplicates();message(`${data.page} / ${data.pages}페이지 텍스트 분석 완료. 모델 ${extractedModels.length}개 확인. 추출된 ${Object.keys(data.fields).length}개 항목을 확인하고 빈 필수 항목을 입력하세요.`+(data.warning ? '\n'+data.warning : ''));
      $('review').scrollIntoView({behavior:'smooth',block:'start'});
    });
  };
  $('module-form').addEventListener('input',event=>{
    lastSaveError='';
    if(event.target.id!=='extracted-model'){dirty=true;event.target.classList.remove('extracted');const badge=event.target.closest('.field')?.querySelector('em');if(badge)badge.hidden=true;}
    duplicates();
  });
  $('module-form').onsubmit=event=>{
    event.preventDefault();if(duplicate || blockReason())return;
    run(async()=>{
      const body={modelId:selectedCandidate?.id,importId};
      for(const fields of Object.values(groups))for(const [key,,,type]of fields)body[key]=type==='text'?$(key).value.trim():Number($(key).value);
      const result=await api('/modules',{method:'POST',body:JSON.stringify(body)});
      reset();$('upload-form').reset();$('filename').textContent='PDF를 끌어놓거나 클릭해 선택하세요';
      message(result.message);
      try{await list();}catch(error){message(result.message+'\n목록 갱신 실패: '+error.message,true);}
    },true);
  };
  $('cancel').onclick=()=>run(discard);
  $('refresh').onclick=()=>run(list);
  $('search').oninput=render;$('manufacturer-filter').onchange=render;
  run(async()=>{csrf=(await api('/session')).csrf;$('management').hidden=false;await list();});
})();
