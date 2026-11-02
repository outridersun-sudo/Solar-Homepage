'use strict';
// Parse text-layer datasheets only. Never treat NOCT/NMOT or bifacial gain as STC/BNPI.
const {numeric} = require('./module-catalog');
const normalize = text => text.normalize('NFKC').replace(/[−–﹣]/g,'-').replace(/\u00ad/g,'');
const numbers = text => (text.match(/[+-]?\d+(?:\.\d+)?/g) || []).map(Number);
const keys = ['p','voc','isc','vmp','imp'];
const labels = {
  p:/(?:최대\s*출력(?:1)?(?!\s*(?:전압|전류))|정격\s*출력|maximum\s*power(?!\s*(?:voltage|current))|rated\s*power|\bPmax\b)/i,
  voc:/(?:개방\s*(?:회로\s*)?전압(?:1)?|open\s*circuit\s*voltage|\bVoc\b)/i,
  isc:/(?:단락\s*전류(?:1)?|short\s*circuit\s*current|\bIsc\b)/i,
  vmp:/(?:최대\s*(?:출력|동작)\s*전압|voltage\s*at\s*maximum\s*power|maximum\s*power\s*voltage|\bVmpp?\b)/i,
  imp:/(?:최대\s*(?:출력|동작)\s*전류|current\s*at\s*maximum\s*power|maximum\s*power\s*current|\bImpp?\b)/i,
  eff:/(?:모듈\s*효율(?:1)?|module\s*efficiency)/i
};
function tail(line, match) {
  return line.slice(match.index+match[0].length).replace(/^\s*\([^)]*\)/,'').replace(/^[^\d+\-]*\[[^\]]*\]/,'');
}
function safe(fields) {
  for (const [key,[min,max]] of Object.entries(numeric)) if (key in fields &&
    (!Number.isFinite(fields[key]) || fields[key]<min || fields[key]>max)) delete fields[key];
  return fields;
}
function sharedFields(text) {
  const values={};
  const put=(key,value)=>{if(Number.isFinite(value))(values[key] ||= []).push(value);};
  const coefficient=/(?:temperature\s*coefficient\s*(?:of\s*)?\(?\s*(Pmax|PMPP|Voc|Isc)\b|온도\s*계수\s*\(?\s*(Pmax|PMPP|Voc|Isc)\b|\b(Pmax|PMPP|Voc|Isc)\s*온도\s*계수)/gi;
  for (const line of text.split('\n')) {
    const matches=[...line.matchAll(coefficient)];
    for(let i=0;i<matches.length;i++) {
      const m=matches[i], symbol=(m[1]||m[2]||m[3]).toLowerCase();
      const segment=line.slice(m.index+m[0].length,matches[i+1]?.index).replace(/\[[^\]]*\]/g,'');
      const key=symbol==='voc'?'betaVoc':symbol==='isc'?'alphaIsc':'gammaPower';
      put(key,numbers(segment)[0]);
    }
    const propertyLine=matches.length ? line.slice(0,matches[0].index) : line;
    for(const [key,label] of Object.entries({maxV:/(?:최대\s*시스템\s*전압|(?:maximum|max\.)\s*system\s*voltage)/i,maxSeriesFuse:/(?:최대\s*직렬\s*퓨즈\s*(?:정격|등급)?|(?:maximum|max\.)\s*series\s*fuse(?:\s*rating)?)/i})) {
      const m=label.exec(propertyLine);if(m)put(key,numbers(tail(propertyLine,m))[0]);
    }
  }
  return safe(Object.fromEntries(Object.entries(values).filter(([,v])=>new Set(v).size===1).map(([k,v])=>[k,v[0]])));
}
function rowsFrom(text,count,stride=1,index=0) {
  const result={};
  for(const [key,label]of Object.entries(labels)) {
    const candidates=[];
    for(const line of text.split('\n')) {
      if(/coefficient|온도\s*계수|tolerance|오차|양면성/i.test(line))continue;
      if(key==='p' && !/^\s*(?:최대\s*출력|정격\s*출력|maximum\s*power|rated\s*power|Pmax)/i.test(line))continue;
      const match=label.exec(line);if(!match)continue;
      const values=numbers(tail(line,match));
      if(values.length===(key==='eff'?count:count*stride))candidates.push(values);
    }
    if(candidates.length===1)result[key]=Array.from({length:count},(_,i)=>candidates[0][key==='eff'?i:i*stride+index]);
  }
  return result;
}
function columnFields(columns,index) {return Object.fromEntries(Object.entries(columns).map(([key,values])=>[key,values[index]]));}
function bnpiFields(fields){return Object.fromEntries(keys.filter(key=>key in fields).map(key=>[key==='p'?'bnpi':'bnpi'+key[0].toUpperCase()+key.slice(1),fields[key]]));}
function candidate(fields,conditions=[],warning='') {
  safe(fields);
  // A candidate needs all five STC electrical values to avoid partial/ambiguous table matches.
  if(!keys.every(key=>typeof fields[key]==='number'))return null;
  const warnings=[warning];
  if(fields.alphaIsc<0)warnings.push('Isc 온도계수가 원본에 음수로 표시되어 있습니다. 부호를 확인하세요. 계산에는 보수적인 전류 보정을 적용합니다.');
  return {id:fields.name,label:fields.name+' · '+fields.p+' W',fields,conditions,warnings:warnings.filter(Boolean)};
}
function registrationPolicy(text,model){
  if(/monofacial|단면\s*(?:모듈|제품)/i.test(text))return {allowed:false,code:'MONOFACIAL',message:'단면 제품: 양면 모듈만 등록할 수 있습니다.'};
  const native=['bnpi','bnpiVoc','bnpiVmp','bnpiIsc','bnpiImp'].every(key=>Number.isFinite(model.fields[key]));
  const alternative=model.substitute10 && ['bnpi','bnpiVoc','bnpiVmp','bnpiIsc','bnpiImp'].every(key=>Number.isFinite(model.substitute10[key]));
  if(!native && !alternative){
    const known=/bifacial|양면|BNPI/i.test(text);
    return {allowed:false,code:known?'BIFACIAL_SPECS_MISSING':'BIFACIAL_UNCONFIRMED',message:known?'양면 사양 부족: 실제 BNPI 또는 제조사 발전 증가율 10%의 필수 사양을 확인할 수 없습니다.':'양면 여부 미확인: 이 PDF에서 양면 제품 근거를 확인할 수 없습니다.'};
  }
  return {allowed:true,mode:native?'bnpi':'gain10',message:''};
}
function analyze(raw) {
  const text=normalize(raw),shared=sharedFields(text);
  let models=[],profile='generic';
  if(/LR7-72HVH/.test(text)&&/Module Type/.test(text)) {
    profile='longi-lr7';
    const table=text.split(/Module Type/)[1]?.split(/Operating Parameters/)[0]||'';
    const names=[...table.split('\n')[0].matchAll(/LR7-72HVH\s*-\s*\d{3}M/g)].map(m=>m[0].replace(/\s/g,''));
    const stc=rowsFrom(table,names.length,2,0),noct=rowsFrom(table,names.length,2,1);
    models=names.map((name,i)=>candidate({...shared,manufacturer:'LONGi',series:'LR7-72HVH',name,...columnFields(stc,i)},[{label:'NOCT（참고용·자동 입력 안 함）',values:columnFields(noct,i)}], 'BNPI 수치가 없어 등록할 수 없습니다. 단면 제품은 등록 불가이며, 양면 제품이라면 해당 기준의 추가 사양과 양면 확인 근거가 필요합니다.'));
  } else if(/Q\.TRON\s*XL-G2R/.test(text)&&/전력\s*등급/.test(text)) {
    profile='qcells-xl-g2r';
    const table=text.split(/전력\s*등급/)[1]?.split(/정상\s*작동\s*조건/)[0]||'';
    const powers=numbers(table.split('\n')[0]);
    const stc=rowsFrom(table,powers.length,2,0),rear=rowsFrom(table,powers.length,2,1);
    const nmotText=(text.split(/정상\s*작동\s*조건/)[1]?.split(/Qcells 성능 보증/)[0]||'').replace(/(개방\s*전압\s+VOC)\s*최소\s*(\[V\])/g,'$1 $2');
    const nmot=rowsFrom(nmotText,powers.length);
    models=powers.map((p,i)=>candidate({...shared,manufacturer:'Qcells',series:'Q.TRON XL-G2R.9 / BFG',name:`Q.TRON XL-G2R.9 / BFG ${p}W`,...columnFields(stc,i),...bnpiFields(columnFields(rear,i))},[{label:'STC + BNPI（후면 135 W/m² 기준·원본의 양면성 계수 조건 확인）'},{label:'NMOT（참고용·자동 입력 안 함）',values:columnFields(nmot,i)}], '공통 제품군명에 정격 출력을 붙여 모델을 구분했습니다. 원본 라벨의 모델명을 확인하세요.'));
  } else if(/TWMNF\s*66HD730-750/.test(text)&&/전기적\s*특성\s*\(STC\)/.test(text)) {
    profile='tw-66hd';
    // Poppler layout preserves the left STC and right BNPI panels. Split at the
    // actual BNPI heading position, not at a hard-coded column offset.
    const lines=text.split('\n'),heading=lines.find(line=>/전기적\s*특성\s*\(BNPI\)/.test(line));
    const split=heading?.search(/전기적\s*특성\s*\(BNPI\)/) ?? -1;
    if(split>0){
      const start=lines.findIndex(line=>/전기적\s*특성\s*\(STC\)/.test(line));
      const segment=lines.slice(Math.max(0,start-1)).join('\n').split(/표준시험조건/)[0];
      const panel=side=>segment.split('\n').map(line=>side===0?line.slice(0,split):line.slice(split)).join('\n');
      const stc=rowsFrom(panel(0),5),rear=rowsFrom(panel(1),5);
      models=(stc.p||[]).map((p,i)=>candidate({...shared,manufacturer:'통웨이 TW Solar',series:'TWMNF 66HD',name:`TWMNF-66HD${p}`,...columnFields(stc,i),...bnpiFields(columnFields(rear,i))},[{label:'STC + BNPI（후면 135 W/m²）'}]));
    }
  } else if(/CS6\.2-66TB/.test(text)&&/ELECTRICAL DATA\s*(?:\(|\|)\s*STC/.test(text)) {
    profile='canadian-cs62';
    // STC and NMOT panels are side by side; only consume the STC side.
    const lines=text.split('\n'),heading=lines.find(line=>/ELECTRICAL DATA\s*(?:\(|\|)\s*STC/.test(line));
    const split=heading.search(/ELECTRICAL DATA\s*(?:\(|\|)\s*NMOT/);
    const table=lines.slice(lines.indexOf(heading)).map(line=>split>0?line.slice(0,split):line).join('\n').split(/ELECTRICAL DATA\s*\n/)[0];
    const nmotValues=new Map();
    if(split>0)for(const line of lines.slice(lines.indexOf(heading))){const m=line.slice(split).match(/^\s*(?:CS6\.2-66TB-)?(\d{3})\s+(\d+)\s*W\s+([\d.]+)\s*V\s+([\d.]+)\s*A\s+([\d.]+)\s*V\s+([\d.]+)\s*A/);if(m)nmotValues.set(m[1],{p:+m[2],vmp:+m[3],imp:+m[4],voc:+m[5],isc:+m[6]});}
    let current=null;
    const tableLines=table.split('\n');
    for(let rowIndex=0;rowIndex<tableLines.length;rowIndex++){
      let line=tableLines[rowIndex];
      if(/\b10%\s+\d+\s*W\s*$/.test(line))line+=' '+(tableLines[rowIndex+1]||'').replace(/^\s*Gain\*\*/, '');
      const match=line.match(/^\s*(?:CS6\.2-66TB-)?(\d{3})\s+(\d{3})\s*W\s+([\d.]+)\s*V\s+([\d.]+)\s*A\s+([\d.]+)\s*V\s+([\d.]+)\s*A\s+([\d.]+)\s*%/);
      if(match&&match[1]===match[2]){
        const [,rating,p,vmp,imp,voc,isc,eff]=match;
        current=candidate({...shared,manufacturer:'Canadian Solar',series:'TOPBiHiKu6 CS6.2-66TB-H',name:`CS6.2-66TB-${rating}${/CS6\.2-66TB-\d{3}/.test(line)?'':'H'}`,p:+p,vmp:+vmp,imp:+imp,voc:+voc,isc:+isc,eff:+eff},nmotValues.has(rating)?[{label:'NMOT（참고용·자동 입력 안 함）',values:nmotValues.get(rating)}]:[], '후면 발전 증가율은 BNPI와 다릅니다. 발전 증가율 10% 대체 사양을 선택하고 명시적으로 동의한 경우에만 대체 등록할 수 있습니다.');
        models.push(current);
      } else if(current) {
        const gain=line.match(/\b(5|10|20)%\s+(\d+)\s*W\s+([\d.]+)\s*V\s+([\d.]+)\s*A\s+([\d.]+)\s*V\s+([\d.]+)\s*A/);
        if(gain)current.conditions.push({gainPercent:+gain[1],label:`양면 발전 증가율 ${gain[1]}%（참고용·BNPI로 자동 입력 안 함）`,values:{p:+gain[2],vmp:+gain[3],imp:+gain[4],voc:+gain[5],isc:+gain[6]}});
      }
    }
  }
  models=models.filter(Boolean);
  for(const model of models){
    const gain=model.conditions.find(condition=>condition.gainPercent===10);
    if(gain && keys.every(key=>Number.isFinite(gain.values[key])))model.substitute10=bnpiFields(gain.values);
  }
  // Efficiency belongs to the STC row; never present it as a measured NOCT value.
  for(const model of models)for(const condition of model.conditions)if(condition.values)delete condition.values.eff;
  if(profile==='generic') {
    const fields={...shared};
    // Unknown layouts stay conservative. Do not fill one of several numbers.
    const stcText=text.split(/\b(?:BNPI|NOCT|NMOT)\b|BIFACIAL GAIN 10%/i)[0];
    for(const [key,label]of Object.entries(labels)){
      const values=[];
      for(const line of stcText.split('\n')){if(/coefficient|온도\s*계수/i.test(line))continue;if(key==='p' && !/^\s*(?:최대\s*출력|정격\s*출력|maximum\s*power|rated\s*power|Pmax)/i.test(line))continue;const m=label.exec(line);if(m){const v=numbers(tail(line,m));if(v.length===1)values.push(v[0]);}}
      if(values.length&&new Set(values).size===1)fields[key]=values[0];
    }
    for(const [key,label]of Object.entries({manufacturer:/^\s*(?:제조사|manufacturer)\s*[:：]\s*(.+)$/im,series:/^\s*(?:시리즈|series)\s*[:：]\s*(.+)$/im,name:/^\s*(?:모델명?|model(?:\s*name)?)\s*[:：]\s*(.+)$/im})){const m=text.match(label);if(m)fields[key]=m[1].trim();}
    safe(fields);
    if(fields.name && keys.every(key=>Number.isFinite(fields[key]))){
      const rearSegment=text.split(/\bBNPI\b/)[1];
      if(rearSegment)Object.assign(fields,bnpiFields(columnFields(rowsFrom(rearSegment,1),0)));
      const model=candidate(fields);
      const gainSegment=text.split(/BIFACIAL GAIN 10%/i)[1];
      if(gainSegment)model.substitute10=bnpiFields(columnFields(rowsFrom(gainSegment,1),0));
      model.registration=registrationPolicy(text,model);
      return {profile,fields:model.fields,models:[model],warning:model.registration.message};
    }
    return {profile,fields,models:[],warning:text.trim()?'표 형식이 자동 인식되지 않았습니다. 추출된 값과 빈 항목을 원본과 대조하세요.':'선택한 페이지에 추출할 텍스트가 없습니다. 원본을 보며 직접 입력하세요.'};
  }
  for(const model of models)model.registration=registrationPolicy(text,model);
  return {profile,models,fields:models.length===1?models[0].fields:shared,warning:models.length?'등록할 모델을 선택한 뒤 원본과 대조하세요.':'이 페이지에서 모델별 사양을 확정하지 못했습니다. 사양표 페이지를 선택하거나 직접 입력하세요.'};
}
module.exports={analyze,normalize};
