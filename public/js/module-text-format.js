'use strict';
(function(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.ModuleTextFormat=value;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const headers='제조사\t시리즈\t모델명\tSTC출력_W\tSTC_Voc_V\tSTC_Vmp_V\tSTC_Isc_A\tSTC_Imp_A\tSTC효율_pct\tVoc온도계수_pct_C\tIsc온도계수_pct_C\tPmax온도계수_pct_C\t최대시스템전압_V\t최대직렬퓨즈_A\t양면제품여부\t양면적용방식\t발전증가율_pct\t양면출력_W\t양면_Voc_V\t양면_Vmp_V\t양면_Isc_A\t양면_Imp_A\t후면일사율_pct\t양면계수_pct\t양면계수허용차_pct\t양면시험조건\t원본파일명\t출처페이지'.split('\t');
 const fields={3:['p',1,2000],4:['voc',1,200],5:['vmp',1,200],6:['isc',.01,100],7:['imp',.01,100],8:['eff',1,50],9:['betaVoc',-2,-.001],10:['alphaIsc',-1,1],11:['gammaPower',-2,0],12:['maxV',100,3000],13:['maxSeriesFuse',1,100],17:['bnpi',1,3000],18:['bnpiVoc',1,200],19:['bnpiVmp',1,200],20:['bnpiIsc',.01,150],21:['bnpiImp',.01,150]};
 const missing=value=>['','미기재','해당없음','확인 필요'].includes(value);
 const number=value=>/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)?Number(value):NaN;
 const identity=(manufacturer,name)=>[manufacturer,name].map(value=>value.normalize('NFKC').toLowerCase().replace(/\s+/gu,'')).join('\u0000');
 function read(cells,line){
  const errors=[],warnings=[];
  const fail=(index,message)=>errors.push({column:index,message:headers[index]+': '+message});
  const body={manufacturer:cells[0],series:cells[1],name:cells[2],rearSpecMode:cells[15],bifacialStatus:cells[14]==='예'?'bifacial':'monofacial',bifacialEvidence:cells[25],reviewed:false};
  for(let i=0;i<cells.length;i++)if(/[\x00-\x1f\x7f]/u.test(cells[i]))fail(i,'제어 문자를 제거하세요.');
  for(const i of [0,1,2])if(missing(cells[i])||cells[i].length>150||['__proto__','constructor','prototype'].includes(cells[i]))fail(i,'150자 이내의 원본 정보를 입력하세요.');
  for(const [index,[key,min,max]]of Object.entries(fields)){
   const value=number(cells[index]);if(!Number.isFinite(value)||value<min||value>max)fail(Number(index),'필수 숫자 범위 '+min+'~'+max+'를 확인하세요.');else body[key]=value;
  }
  if(cells[14]!=='예')fail(14,'양면 제품 여부를 확인하세요. 현재 양면 모듈만 등록합니다.');
  if(!['bnpi','gain10','bstc'].includes(cells[15]))fail(15,'bnpi, gain10, bstc 중 확인된 방식을 입력하세요.');
  if(missing(cells[25])||cells[25].length>1000)fail(25,'1~1000자로 원본 시험 조건과 근거를 입력하세요.');
  if(missing(cells[26])||cells[26].length>255||/[\\/]/.test(cells[26]))fail(26,'경로를 제외한 원본 파일명을 입력하세요.');
  const pageStrings=cells[27].split(',').map(value=>value.trim());
  const pages=pageStrings.map(Number);
  if(!pageStrings.length||pageStrings.some(value=>!/^\d+$/.test(value))||pages.some(value=>!Number.isSafeInteger(value)||value<1||value>10000))fail(27,'1,2처럼 실제 출처 페이지를 입력하세요.');
  body.evidencePage=pages[0];
  const optional={};
  for(const i of [16,22,23,24]){
   optional[i]=missing(cells[i])?null:number(cells[i]);
   if(optional[i]!==null&&(!Number.isFinite(optional[i])||optional[i]<0||optional[i]>100))fail(i,'미기재/해당없음 또는 0~100 숫자를 입력하세요.');
  }
  if(cells[15]==='bnpi'&&optional[22]!==13.5)fail(22,'현재 BNPI 계산 기준은 후면 일사비 13.5%입니다. 원본 시험 조건을 확인하세요.');
  if(cells[15]==='gain10'&&(optional[16]!==10||Math.abs(body.bnpi/body.p-1.1)>.005))fail(16,'제조사 발전 증가율 10% 표의 사양이 필요합니다.');
  if(cells[15]==='bstc'&&!/BSTC/i.test(cells[25]))fail(25,'BSTC 원본 시험 조건을 명시하세요.');
  if(cells[15]==='bnpi'&&/BNPI\s*고정\s*적용/i.test(cells[25]))warnings.push('BNPI는 고정 모드가 아닙니다. 시험 조건 설명을 확인하세요.');
  const calculated=(body.bnpi/body.p-1)*100;
  if(Number.isFinite(calculated)&&optional[16]!==null&&Math.abs(calculated-optional[16])>.1)warnings.push('기재 발전 증가율과 출력으로 계산한 증가율이 다릅니다. 원본 반올림/조건을 확인하세요.');
  body.specification={gainPercent:optional[16],referenceRearIrradiancePercent:optional[22],powerBifacialityPercent:optional[23],bifacialityTolerancePercent:optional[24],testConditions:cells[25],sourceFile:cells[26],sourcePages:[...new Set(pages)],sourceKind:'text'};
  return {line,cells,body,errors,warnings,calculatedGainPercent:Number.isFinite(calculated)?calculated:null};
 }
 function parse(text){
  if(typeof text!=='string'||new TextEncoder().encode(text).length>80000)throw Error('텍스트는 UTF-8 기준 80KB 이하로 붙여넣으세요.');
  let clean=text.replace(/^\uFEFF/,'').trim();
  if(/^```/.test(clean))clean=clean.replace(/^```(?:text|tsv)?\s*\r?\n/i,'').replace(/\r?\n```$/,'');
  const lines=clean.split(/\r?\n/).filter(line=>line.trim());
  const supplied=(lines.shift()||'').split('\t').map(value=>value.trim());
  if(supplied.length!==28||supplied.some((value,i)=>value!==headers[i]))throw Error('헤더를 포함한 탭 구분 28개 열을 그대로 붙여넣으세요. 공백 정렬 표나 CSV는 지원하지 않습니다.');
  if(!lines.length||lines.length>50)throw Error('모델은 한 번에 1~50개를 입력하세요.');
  return lines.map((line,i)=>{
   const cells=line.split('\t').map(value=>value.trim());
   if(cells.length!==28)throw Error((i+2)+'행의 열 수가 '+cells.length+'개입니다. 각 모델은 28개 열이어야 합니다.');
   return read(cells,i+2);
  });
 }
 function serialize(rows){return [headers.join('\t'),...rows.map(row=>(Array.isArray(row)?row:row.cells).join('\t'))].join('\n');}
 return {headers,fields,identity,parse,serialize};
});
