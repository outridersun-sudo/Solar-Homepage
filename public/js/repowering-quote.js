'use strict';
// Append only the repowering request. Product/contact fields and submission stay unchanged.
(() => {
  if(new URLSearchParams(location.search).get('from')!=='repowering')return;
  const key='solar-repowering-quote-v1';
  function apply(){
    const field=document.getElementById('requestMessage');
    if(!field)return;
    const status=document.createElement('p');
    status.className='q-message';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    field.closest('label')?.after(status);
    let draft;
    try{const raw=sessionStorage.getItem(key);if(!raw)return;draft=JSON.parse(raw);}catch{status.textContent='리파워링 결과를 읽지 못했습니다. 리파워링 화면에서 다시 연결해 주세요.';return;}
    if(draft?.version!==1||typeof draft.request!=='string'||!draft.request.trim()||!Number.isFinite(draft.createdAt)||draft.createdAt>Date.now()+60000||Date.now()-draft.createdAt>86400000){
      status.textContent='리파워링 연결 정보가 만료되었거나 올바르지 않습니다. 다시 계산해 연결해 주세요.';return;
    }
    const incoming=draft.request.trim(),existing=field.value;
    const combined=existing.includes(incoming)?existing:(existing?existing+'\n\n':'')+incoming;
    if(field.maxLength>=0&&combined.length>field.maxLength){
      status.textContent=`기존 요청사항과 리파워링 결과가 ${field.maxLength.toLocaleString('ko-KR')}자 한도를 초과합니다. 기존 내용을 조정한 뒤 새로고침하면 다시 반영합니다.`;return;
    }
    field.value=combined;
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
    status.textContent='리파워링 설계 결과를 추가 요청사항에 반영했습니다.';
    try{sessionStorage.removeItem(key);}catch{/* The full-text duplicate guard keeps retries idempotent. */}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply,{once:true});else apply();
})();
