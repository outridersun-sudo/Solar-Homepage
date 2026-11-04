'use strict';
(()=>{
 const $=id=>document.getElementById(id),format=window.ModuleTextFormat;
 let rows=[],validated=false,busy=false;
 const status=(text,error=false)=>{$('text-status').textContent=text;$('text-status').classList.toggle('error',error);};
 function controls(){
  const chosen=rows.filter(row=>row.selected&&!row.errors.length).length;
  $('text-register').disabled=busy||!validated||!chosen||!$('text-reviewed').checked||!$('text-modes').checked;
  $('text-check').disabled=busy;$('text-recheck').disabled=busy||!rows.length;
  $('text-input').disabled=busy;
  document.querySelectorAll('#text-grid input[type=text]').forEach(input=>input.disabled=busy);
  document.querySelectorAll('#text-grid input[type=checkbox]').forEach((input,i)=>input.disabled=busy||!!rows[i]?.errors.length);
  $('text-selection').textContent='선택 '+chosen+'개 / 전체 '+rows.length+'개';
 }
 function invalidate(){validated=false;$('text-reviewed').checked=false;$('text-modes').checked=false;status('입력값이 바뀌었습니다. 수정값 검사를 누른 뒤 원본을 다시 확인하세요.');controls();}
 async function api(path,body){
  const session=await fetch('/api/admin/session',{cache:'no-store'});
  if(!session.ok)throw Error('관리자 로그인이 필요합니다.');
  const csrf=(await session.json()).csrf;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await fetch('/api/admin/modules/text/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body),signal:controller.signal});
   let data;try{data=await response.json();}catch{throw Error('서버 응답을 확인하지 못했습니다. 등록 목록을 확인한 뒤 다시 시도하세요.');}
   if(!response.ok)throw Error(data.message||'처리에 실패했습니다.');return data;
  }catch(error){if(controller.signal.aborted)throw Error('서버 응답 시간이 초과되었습니다. 등록 목록을 확인한 뒤 다시 시도하세요.');throw error;}
  finally{clearTimeout(timer);}
 }
 async function run(action){if(busy)return;busy=true;controls();$('text-grid').setAttribute('aria-busy','true');try{await action();}catch(error){status(error.message,true);}finally{busy=false;controls();$('text-grid').removeAttribute('aria-busy');}}
 function render(){
  const table=$('text-grid');table.replaceChildren();
  const caption=document.createElement('caption');caption.textContent='모델별 사양 검토표 — 셀을 수정한 뒤 수정값 검사를 누르세요.';table.append(caption);
  const head=document.createElement('thead'),tr=document.createElement('tr');
  for(const label of ['등록 선택 / 모델',...format.headers,'검사 결과']){const th=document.createElement('th');th.scope='col';th.textContent=label;tr.append(th);}head.append(tr);table.append(head);
  const tbody=document.createElement('tbody');
  rows.forEach((row,index)=>{
   const tr=document.createElement('tr');tr.dataset.row=index;
   const choose=document.createElement('input');choose.type='checkbox';choose.checked=row.selected;choose.disabled=!!row.errors.length;choose.setAttribute('aria-label',row.cells[2]+' 등록 선택');
   choose.onchange=()=>{row.selected=choose.checked;$('text-reviewed').checked=false;$('text-modes').checked=false;controls();};
   const cell=document.createElement('td'),model=document.createElement('span');model.textContent=row.cells[2];cell.append(choose,model);tr.append(cell);
   row.cells.forEach((value,column)=>{
    const td=document.createElement('td'),input=document.createElement('input');input.type='text';input.value=value;input.setAttribute('aria-label',(index+1)+'행 '+format.headers[column]);input.dataset.column=column;
    input.oninput=()=>{row.cells[column]=input.value;invalidate();};
    input.disabled=busy;
    const errors=row.errors.filter(error=>error.column===column);
    if(errors.length){input.setAttribute('aria-invalid','true');input.title=errors.map(error=>error.message).join('\n');}
    td.append(input);tr.append(td);
   });
   const result=document.createElement('td');result.className=row.errors.length?'error':'text-row-ok';
   result.textContent=row.errors.length?row.errors.map(error=>error.message).join('\n'):['등록 가능',...row.warnings,row.calculatedGainPercent===null?'':'출력 증가율 검산: '+row.calculatedGainPercent.toFixed(4)+'%'].filter(Boolean).join('\n');tr.append(result);tbody.append(tr);
  });table.append(tbody);$('text-review').hidden=false;controls();
 }
 async function inspect(text,preserve=false){
  const previous=preserve?rows.map(row=>row.selected):[];
  const data=await api('validate',{text});
  rows=data.rows.map((row,i)=>({...row,selected:!row.errors.length&&(preserve?previous[i]!==false:true)}));validated=true;
  $('text-reviewed').checked=false;$('text-modes').checked=false;render();
  const invalid=rows.filter(row=>row.errors.length).length;
  status(rows.length+'개 모델 검사 완료. 오류 '+invalid+'개 모델'+(invalid?' — 오류 모델을 수정하거나 정상 모델만 선택해 등록하세요.':' — 원본과 적용 방식을 확인한 뒤 등록하세요.'),!!invalid);
 }
 $('text-check').onclick=()=>run(async()=>{validated=false;await inspect($('text-input').value);});
 $('text-recheck').onclick=()=>run(()=>inspect(format.serialize(rows),true));
 $('text-input').oninput=invalidate;
 $('text-reviewed').onchange=controls;$('text-modes').onchange=controls;
 $('text-register').onclick=()=>run(async()=>{
  if(!validated||!$('text-reviewed').checked||!$('text-modes').checked)throw Error('수정값 검사와 원본 검토·적용 동의를 확인하세요.');
  const selected=rows.filter(row=>row.selected&&!row.errors.length);if(!selected.length)throw Error('등록할 모델을 선택하세요.');
  const data=await api('register',{text:format.serialize(selected),reviewed:true,acceptedModes:true});
  rows=[];validated=false;$('text-reviewed').checked=false;$('text-modes').checked=false;$('text-review').hidden=true;$('text-input').value='';
  status(data.message);window.dispatchEvent(new Event('modules-changed'));
 });
 controls();
})();
