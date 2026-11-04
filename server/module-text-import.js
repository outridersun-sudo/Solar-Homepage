'use strict';
const format=require('../public/js/module-text-format');
const catalog=require('./module-catalog');
function inspect(text){
 const rows=format.parse(text),known=new Set(catalog.list().map(row=>format.identity(row.manufacturer,row.name))),counts=new Map();
 for(const row of rows){const key=format.identity(row.body.manufacturer,row.body.name);counts.set(key,(counts.get(key)||0)+1);}
 for(const row of rows){
  const key=format.identity(row.body.manufacturer,row.body.name);
  if(known.has(key))row.errors.push({column:2,message:'동일한 제조사·모델명이 이미 등록되어 있습니다.'});
  if(counts.get(key)>1)row.errors.push({column:2,message:'붙여넣은 자료 안에서 제조사·모델명이 중복됩니다.'});
  if(!row.errors.length)try{catalog.validate({...row.body,reviewed:true,substituteConfirmed:true},Math.max(...row.body.specification.sourcePages));}catch(error){row.errors.push({column:null,message:error.message});}
 }
 return rows;
}
module.exports=function(app){
 app.post('/api/admin/modules/text/validate',(req,res,next)=>{
  try{res.json({headers:format.headers,rows:inspect(req.body?.text)});}catch(error){res.status(error.status||400).json({message:error.message});}
 });
 app.post('/api/admin/modules/text/register',(req,res,next)=>{
  try{
   if(req.body?.reviewed!==true||req.body?.acceptedModes!==true)return res.status(400).json({message:'원본 대조 완료와 양면 적용 방식 동의를 직접 확인하세요.'});
   const rows=inspect(req.body.text);
   if(rows.some(row=>row.errors.length))return res.status(422).json({message:'등록할 모델의 오류를 먼저 수정하세요. 아무 모델도 저장하지 않았습니다.',rows});
   const entries=rows.map(row=>({body:{...row.body,reviewed:true,substituteConfirmed:true},source:{id:null,kind:'text',filename:row.body.specification.sourceFile,pages:Math.max(...row.body.specification.sourcePages),importCells:row.cells}}));
   const saved=catalog.addMany(entries);
   res.status(201).json({message:saved.length+'개 모델을 등록했습니다. 계산기를 새로고침하면 선택할 수 있습니다.',rows:saved});
  }catch(error){res.status(error.status||500).json({message:error.message});}
 });
};
module.exports.inspect=inspect;
