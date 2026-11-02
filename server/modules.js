'use strict';
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const catalog = require('./module-catalog');
const pdf = require('./module-pdf');
const directory = path.join(catalog.directory, 'imports');
const imports = new Map();
const upload = multer({storage:multer.diskStorage({
  destination:(req,file,done) => done(null,directory),
  filename:(req,file,done) => done(null,crypto.randomUUID()+'.pdf')
}), limits:{files:1,fileSize:20*1024*1024,fields:1,parts:2,fieldSize:20}}).single('file');
function owned(req) {
  const item = imports.get(req.params.id || req.body?.importId);
  if (!item || item.owner !== req.adminSession.id || item.expires < Date.now()) throw Object.assign(new Error('PDF 업로드가 만료되었습니다. 파일을 다시 선택하세요.'),{status:410});
  return item;
}
function originalName(value) {
  const decoded = Buffer.from(value,'latin1').toString('utf8');
  if (!decoded.includes('\uFFFD')) value = decoded;
  return value.replaceAll('\\','/').split('/').pop().replace(/[\x00-\x1f\x7f]/g,'').slice(0,200);
}
module.exports = function registerModules(app) {
  const cleanup = setInterval(() => {
    for (const [id,item] of imports) if (item.expires < Date.now() && !item.busy) {
      imports.delete(id); fs.rm(item.path,{force:true}).catch(() => {});
    }
  },60000);
  cleanup.unref();
  app.get('/api/admin/modules', (req,res,next) => { try {res.json({rows:catalog.list()});} catch(error) {next(error);} });
  app.post('/api/admin/modules/import', async (req,res,next) => {
    try {
      if (imports.size >= 30) return res.status(429).json({message:'업로드가 많습니다. 기존 작업을 완료한 뒤 시도하세요.'});
      await fs.mkdir(directory,{recursive:true});
      upload(req,res,async error => {
        try {
          if (error) throw Object.assign(new Error('20MB 이하의 PDF 파일 하나를 선택하세요.'),{status:400});
          if (!req.file || !/\.pdf$/i.test(req.file.originalname)) throw Object.assign(new Error('PDF 파일을 선택하세요.'),{status:400});
          const handle = await fs.open(req.file.path,'r');
          const signature = Buffer.alloc(5);
          try {await handle.read(signature,0,5,0);} finally {await handle.close();}
          if (signature.toString() !== '%PDF-') throw Object.assign(new Error('유효한 PDF 파일이 아닙니다.'),{status:400});
          const id = crypto.randomUUID();
          const item = {id,path:req.file.path,filename:originalName(req.file.originalname),owner:req.adminSession.id,expires:Date.now()+3600000,busy:true};
          imports.set(id,item);
          // Keep the valid upload when extraction fails so another page can be tried.
          try {
            const result = await pdf.extract(item.path,Number(req.body.page || 1));
            item.pages=result.pages;item.analysis=result;
            res.json({...result,importId:id,filename:item.filename});
          } catch (failure) {
            res.status(failure.status || 500).json({message:failure.message,importId:id,filename:item.filename});
          } finally {item.busy=false;}
        } catch(failure) {
          if (req.file) await fs.rm(req.file.path,{force:true}).catch(()=>{});
          next(failure);
        }
      });
    } catch(error) {next(error);}
  });
  app.post('/api/admin/modules/import/:id/extract', async (req,res,next) => {
    let item, acquired=false;
    try {
      item = owned(req);
      if (item.busy) return res.status(409).json({message:'분석 중입니다. 잠시 기다려 주세요.'});
      item.busy=true; acquired=true;
      const result=await pdf.extract(item.path,Number(req.body.page));item.pages=result.pages;item.analysis=result;
      res.json({...result,importId:item.id,filename:item.filename});
    } catch(error) {next(error);} finally {if(acquired) item.busy=false;}
  });
  app.delete('/api/admin/modules/import/:id', async (req,res,next) => {
    try {
      const item=owned(req);
      if(item.busy) return res.status(409).json({message:'분석이 끝난 뒤 취소하세요.'});
      imports.delete(item.id); await fs.rm(item.path,{force:true}); res.json({ok:true});
    } catch(error) {next(error);}
  });
  app.post('/api/admin/modules', async (req,res,next) => {
    try {
      const item=owned(req);
      if (item.busy) return res.status(409).json({message:'분석이 끝난 뒤 등록하세요.'});
      if(!item.pages)return res.status(422).json({code:'BIFACIAL_UNCONFIRMED',message:'양면 여부 미확인: PDF 페이지를 정상적으로 분석한 뒤 확인 근거를 입력하세요.'});
      const candidate=item.analysis?.models?.find(model=>model.id===req.body?.modelId);
      if(!candidate)return res.status(422).json({code:'BIFACIAL_UNCONFIRMED',message:'양면 여부 미확인: PDF에서 판정 가능한 모델을 선택하세요.'});
      if(!candidate.registration?.allowed)return res.status(422).json({code:candidate.registration?.code || 'BIFACIAL_UNCONFIRMED',message:candidate.registration?.message || '양면 여부 미확인'});
      const mode=candidate.registration.mode;
      const rear=mode==='gain10'?candidate.substitute10:candidate.fields;
      const body={...req.body,bifacialStatus:'bifacial',evidencePage:item.analysis.page,bifacialEvidence:'PDF '+item.analysis.page+'페이지의 '+candidate.id+' / '+(mode==='gain10'?'발전 증가율 10% 사양':'STC 및 BNPI 사양')+' 자동 확인',reviewed:true,rearSpecMode:mode,substituteConfirmed:mode==='gain10'};
      for(const key of ['bnpi','bnpiVoc','bnpiVmp','bnpiIsc','bnpiImp'])body[key]=rear[key];
      catalog.validate(body,item.pages);
      const sourceId=crypto.randomUUID();
      const target=path.join(catalog.directory,sourceId+'.pdf');
      // Synchronous operations keep duplicate detection and import consumption together.
      require('node:fs').copyFileSync(item.path,target,require('node:fs').constants.COPYFILE_EXCL);
      let row;
      try {row=catalog.add(body,{id:sourceId,filename:item.filename,pages:item.pages});}
      catch(error) {require('node:fs').rmSync(target,{force:true}); throw error;}
      imports.delete(item.id);
      await fs.rm(item.path,{force:true}).catch(()=>{});
      res.status(201).json({message:'모듈을 등록했습니다. 계산기를 새로 열면 선택할 수 있습니다.',row});
    } catch(error) {next(error);}
  });
  app.use('/api/admin/modules',(error,req,res,next) => {
    if (!error.status) return next(error);
    res.status(error.status).json({message:error.message,...(error.code?{code:error.code}:{})});
  });
};
