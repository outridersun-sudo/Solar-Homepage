'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = require('./calculator-data/modules.json');
const directory = path.resolve(process.env.MODULE_DATA_DIR || path.join(__dirname, '..', 'uploads', 'modules'));
const filename = path.join(directory, 'catalog.json');
const problem = (message, status = 400) => Object.assign(new Error(message), {status});
const identity = text => text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '');
const numeric = {
  p:[1,2000], voc:[1,200], vmp:[1,200], isc:[0.01,100], imp:[0.01,100],
  maxV:[100,3000], betaVoc:[-2,-0.001], alphaIsc:[-1,1], gammaPower:[-2,0],
  maxSeriesFuse:[1,100], bnpi:[1,3000], bnpiVoc:[1,200], bnpiVmp:[1,200],
  bnpiIsc:[0.01,150], bnpiImp:[0.01,150], eff:[1,50]
};
function records() {
  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(data)) throw Error('Invalid module catalog');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function getCatalog() {
  const result = structuredClone(base);
  for (const row of records()) {
    if (!Object.hasOwn(result, row.manufacturer)) Object.defineProperty(result, row.manufacturer, {value:{}, enumerable:true});
    const series = result[row.manufacturer];
    if (!Object.hasOwn(series, row.series)) Object.defineProperty(series, row.series, {value:[], enumerable:true});
    series[row.series].push(row.module);
  }
  return result;
}
function list() {
  return Object.entries(getCatalog()).flatMap(([manufacturer, groups]) =>
    Object.entries(groups).flatMap(([series, modules]) => modules.map(module => ({manufacturer, series, ...module}))));
}
function validate(body, pages = 100) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('모듈 정보를 확인하세요.');
  const blocked=(code,message)=>Object.assign(problem(message,422),{code});
  if(body.bifacialStatus==='monofacial')throw blocked('MONOFACIAL','단면 제품: 양면 모듈만 등록할 수 있습니다.');
  if(body.bifacialStatus!=='bifacial' || typeof body.bifacialEvidence!=='string' || !body.bifacialEvidence.trim() ||
    body.bifacialEvidence.length>1000 || /[\x00-\x1f\x7f]/u.test(body.bifacialEvidence) ||
    !Number.isSafeInteger(body.evidencePage) || body.evidencePage<1 || body.evidencePage>pages) {
    throw blocked('BIFACIAL_UNCONFIRMED','양면 여부 미확인: PDF의 유효한 페이지 번호와 양면 제품임을 확인한 근거를 입력하세요.');
  }
  const text = (key, required = false, max = 150) => {
    const value = body[key] ?? '';
    if (typeof value !== 'string' || value.trim().length > max || /[\x00-\x1f\x7f]/u.test(value) ||
      (required && !value.trim()) || ['__proto__','constructor','prototype'].includes(value.trim())) throw problem(key + ' 항목을 확인하세요.');
    return value.trim().normalize('NFKC');
  };
  const manufacturer = text('manufacturer', true), series = text('series', true), name = text('name', true);
  const mode=body.rearSpecMode || 'bnpi';
  if(!['bnpi','gain10','bstc'].includes(mode))throw blocked('BIFACIAL_SPECS_MISSING','양면 사양 부족: 적용 기준을 확인하세요.');
  if(mode==='gain10' && body.substituteConfirmed!==true)throw blocked('BIFACIAL_SPECS_MISSING','양면 사양 부족: 발전 증가율 10% 사양의 대체 적용에 동의해야 합니다.');
  const module = {name,rearSpecMode:mode};
  if(body.specification)module.specification=structuredClone(body.specification);
  for (const [key, [min,max]] of Object.entries(numeric)) {
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw blocked('BIFACIAL_SPECS_MISSING','양면 사양 부족: 필수 STC·선택한 양면 사양 또는 온도·보호 정격이 누락되었거나 유효하지 않습니다. '+key+' 값과 단위를 확인하세요.');
    module[key] = value;
  }
  if (module.vmp >= module.voc || module.imp > module.isc || module.bnpiVmp >= module.bnpiVoc ||
    module.bnpiImp > module.bnpiIsc || module.maxV < module.voc || module.maxSeriesFuse < module.isc ||
    Math.abs(module.p - module.vmp * module.imp) / module.p > .08 ||
    Math.abs(module.bnpi - module.bnpiVmp * module.bnpiImp) / module.bnpi > .08 ||
    module.bnpi <= module.p || module.bnpiIsc <= module.isc || module.bnpiImp <= module.imp) {
    throw blocked('BIFACIAL_SPECS_MISSING','양면 사양 부족: 전압·전류·출력 관계 또는 퓨즈 정격을 확인하세요. 출력은 Vmp × Imp와 일치해야 하며 선택한 양면 사양의 출력·전류는 STC보다 커야 합니다.');
  }
  if(mode==='gain10' && Math.abs(module.bnpi/module.p-1.1)>.005)throw blocked('BIFACIAL_SPECS_MISSING','양면 사양 부족: 대체 출력은 제조사의 발전 증가율 10% 사양이어야 합니다.');
  for (const key of ['cells','weight','type','warranty']) module[key] = text(key, false, 200) || '미기재';
  module.temp = `${module.gammaPower} | ${module.betaVoc} | ${module.alphaIsc} %/℃`;
  module.iscCoefficientUnconfirmed = module.alphaIsc < 0;
  if (body.reviewed !== true) throw problem('원본 PDF와 필수 사양을 대조한 뒤 검토 완료를 선택하세요.');
  return {manufacturer, series, module, evidence:{status:'bifacial',page:body.evidencePage,text:body.bifacialEvidence.trim(),rearSpecMode:mode,rearIrradiancePercent:mode==='bnpi'?13.5:null,gainPercent:mode==='gain10'?10:null}};
}
function addMany(entries) {
  const rows=entries.map(({body,source})=>validate(body,source.pages));
  fs.mkdirSync(directory,{recursive:true});
  const lockPath=path.join(directory,'.catalog.lock');
  let lock;
  try{lock=fs.openSync(lockPath,'wx',0o600);}
  catch(error){if(error.code==='EEXIST')throw problem('다른 등록을 처리 중입니다. 잠시 후 다시 시도하세요.',409);throw error;}
  const temporary=filename+'.'+crypto.randomUUID()+'.tmp';
  try{
    const identities=new Set(list().map(row=>identity(row.manufacturer)+'\0'+identity(row.name)));
    for(const row of rows){
      const key=identity(row.manufacturer)+'\0'+identity(row.module.name);
      if(identities.has(key))throw problem('동일한 제조사·모델명이 이미 등록되어 처리할 수 없습니다. 기존 사양은 변경되지 않았습니다.',409);
      identities.add(key);
    }
    const stored=rows.map((row,i)=>{
      const source=entries[i].source;
      row.module.source=source.filename+' (관리자 검토 완료)';
      if(source.kind==='text')row.evidence.sourceKind='text';
      return {...row,pdfId:source.id,originalName:source.filename,supplements:source.supplements||[],...(source.kind==='text'?{sourceKind:'text',importCells:source.importCells}:{}),createdAt:new Date().toISOString()};
    });
    fs.writeFileSync(temporary,JSON.stringify([...records(),...stored],null,2),{mode:0o600});
    fs.renameSync(temporary,filename);
    return rows;
  }finally{fs.rmSync(temporary,{force:true});fs.closeSync(lock);fs.rmSync(lockPath,{force:true});}
}
module.exports={getCatalog,list,validate,addMany,directory,numeric};
