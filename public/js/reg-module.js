'use strict';
(()=>{
  const $=id=>document.getElementById(id);
  let rows=[],requestVersion=0;
  function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
  async function get(path){
    const response=await fetch('/api/admin'+path,{cache:'no-store'});
    if(response.status===401){$('management').hidden=true;throw Error('관리자 로그인이 필요합니다. 상단 A/S 관리에서 로그인한 뒤 다시 열어주세요.');}
    if(!response.ok)throw Error('모듈 목록을 읽지 못했습니다. 잠시 후 다시 시도하세요.');
    return response.json();
  }
  function render(){
    const term=$('search').value.trim().toLocaleLowerCase('ko-KR'),manufacturer=$('manufacturer-filter').value;
    const visible=rows.filter(row=>(!manufacturer||row.manufacturer===manufacturer)&&[row.manufacturer,row.series,row.name].join(' ').toLocaleLowerCase('ko-KR').includes(term));
    $('module-count').textContent=rows.length;$('rows').replaceChildren();
    for(const row of visible){
      const tr=document.createElement('tr');
      const mode=row.rearSpecMode==='bstc'?'BSTC 고정':row.rearSpecMode==='gain10'?'10% 사양 고정':'BNPI 보정';
      for(const value of [row.manufacturer,null,row.p+' W',row.voc+' / '+row.vmp+' V',mode]){const td=document.createElement('td');if(value!==null)td.textContent=value;tr.append(td);}
      const small=document.createElement('small'),strong=document.createElement('strong');small.textContent=row.series;strong.textContent=row.name;tr.children[1].append(small,strong);$('rows').append(tr);
    }
    if(!visible.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='검색 결과가 없습니다.';tr.append(td);$('rows').append(tr);}
  }
  async function list(){
    const version=++requestVersion;$('refresh').disabled=true;
    try{
      const data=await get('/modules');if(version!==requestVersion)return;
      rows=data.rows;
      const previous=$('manufacturer-filter').value;
      $('manufacturer-filter').replaceChildren(new Option('전체 제조사',''),...[...new Set(rows.map(row=>row.manufacturer))].map(name=>new Option(name,name)));
      if([...$('manufacturer-filter').options].some(option=>option.value===previous))$('manufacturer-filter').value=previous;
      render();message('');
    }catch(error){if(version===requestVersion)message(error.message,true);}
    finally{if(version===requestVersion)$('refresh').disabled=false;}
  }
  $('refresh').onclick=list;$('search').oninput=render;$('manufacturer-filter').onchange=render;
  window.addEventListener('modules-changed',list);
  (async()=>{try{await get('/session');$('management').hidden=false;await list();}catch(error){message(error.message,true);}})();
})();
