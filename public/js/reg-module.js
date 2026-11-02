'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let csrf='', rows=[], importId='', objectUrl='', busy=false, duplicate=false, dirty=false;
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
    const input=document.createElement('input'); input.id=key; input.name=key; input.type=type || 'number'; input.required=group!=='optional';
    if(type==='text') input.maxLength=group==='optional'?200:150;
    else {input.step='any'; input.min=['betaVoc','gammaPower'].includes(key)?'-2':key==='alphaIsc'?'-1':'0.01'; input.max=key==='betaVoc'?'-0.001':key==='gammaPower'?'0':key==='alphaIsc'?'1':key==='eff'?'50':'3000';}
    box.append(input);
    if(unit){const span=document.createElement('span');span.className='unit';span.textContent=unit;box.append(span);}
    wrapper.append(title,box); $(group+'-fields').append(wrapper);
  }
  const identity=text=>text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu,'');
  function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
  function updateSave(){ $('save').disabled=busy || !importId || duplicate || !$('reviewed').checked; }
  function duplicates(){
    duplicate=rows.some(row=>identity(row.manufacturer)===identity($('manufacturer').value) && identity(row.name)===identity($('name').value));
    $('duplicate').hidden=!duplicate;
    $('duplicate').textContent='동일한 제조사·모델명이 이미 존재합니다. 시리즈나 사양이 달라도 중복 등록할 수 없습니다.';
    $('name').classList.toggle('invalid',duplicate); updateSave();
  }
  async function api(url,options={}) {
    const headers={'X-CSRF-Token':csrf};
    if(options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
    const response=await fetch('/api/admin'+url,{...options,headers,cache:'no-store'});
    let data; try{data=await response.json();}catch{throw new Error('서버 응답을 확인하지 못했습니다. 다시 등록하기 전에 목록을 새로고침하세요.');}
    if(response.status===401){$('management').hidden=true;csrf='';reset();throw new Error('관리자 로그인이 만료되었습니다. 상단 A/S 관리에서 다시 로그인하세요.');}
    if(!response.ok)throw Object.assign(new Error(data.message || '처리에 실패했습니다.'),{data});
    return data;
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
      const status=document.createElement('span');status.className='status';status.textContent='계산기 사용 중';tr.children[4].append(status);$('rows').append(tr);
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
    importId='';dirty=false;duplicate=false;$('module-form').reset();$('review').hidden=true;
    $('pdf-preview').removeAttribute('src');$('pdf-preview').hidden=true;$('preview-help').hidden=false;$('open-pdf').removeAttribute('href');
    if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl='';
    document.querySelectorAll('.field input').forEach(input=>{input.classList.remove('extracted','invalid');input.closest('label').querySelector('em').hidden=true;});
    updateSave();
  }
  async function discard(){const id=importId;reset();if(id)await api('/modules/import/'+encodeURIComponent(id),{method:'DELETE'});}
  async function run(action){
    if(busy)return;busy=true;message('');
    ['analyze','cancel','copy-stc','refresh','pdf-file','source-page'].forEach(id=>$(id).disabled=true);updateSave();
    try{await action();}catch(error){message(error.message,true);}
    finally{busy=false;['analyze','cancel','copy-stc','refresh','pdf-file','source-page'].forEach(id=>$(id).disabled=false);$('analysis-status').textContent='한 번에 한 페이지를 분석합니다.';updateSave();}
  }
  function preview(data){
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
      for(const [key,value] of Object.entries(data.fields)){const input=$(key);if(input && input.closest('.field')){input.value=value;input.classList.add('extracted');input.closest('label').querySelector('em').hidden=false;}}
      $('extracted-text').textContent=data.text || '읽을 수 있는 텍스트가 없습니다. 원본을 확인해 직접 입력하세요.';
      duplicates();message(`${data.page} / ${data.pages}페이지 텍스트 분석 완료. 추출된 ${Object.keys(data.fields).length}개 항목을 확인하고 빈 필수 항목을 입력하세요.`+(data.warning ? '\n'+data.warning : ''));
      $('review').scrollIntoView({behavior:'smooth',block:'start'});
    });
  };
  $('module-form').addEventListener('input',event=>{
    if(event.target.id!=='reviewed'){$('reviewed').checked=false;dirty=true;event.target.classList.remove('extracted');const badge=event.target.closest('.field')?.querySelector('em');if(badge)badge.hidden=true;}
    duplicates();
  });
  $('copy-stc').onclick=()=>{
    for(const [to,from] of Object.entries({bnpi:'p',bnpiVoc:'voc',bnpiVmp:'vmp',bnpiIsc:'isc',bnpiImp:'imp'}))$(to).value=$(from).value;
    $('reviewed').checked=false;dirty=true;updateSave();
  };
  $('module-form').onsubmit=event=>{
    event.preventDefault();if(duplicate)return;
    run(async()=>{
      const body={importId,reviewed:$('reviewed').checked};
      for(const fields of Object.values(groups))for(const [key,,,type]of fields)body[key]=type==='text'?$(key).value.trim():Number($(key).value);
      const result=await api('/modules',{method:'POST',body:JSON.stringify(body)});
      reset();$('upload-form').reset();$('filename').textContent='PDF를 끌어놓거나 클릭해 선택하세요';
      message(result.message);
      try{await list();}catch(error){message(result.message+'\n목록 갱신 실패: '+error.message,true);}
    });
  };
  $('cancel').onclick=()=>run(discard);
  $('refresh').onclick=()=>run(list);
  $('search').oninput=render;$('manufacturer-filter').onchange=render;
  run(async()=>{csrf=(await api('/session')).csrf;$('management').hidden=false;await list();});
})();
