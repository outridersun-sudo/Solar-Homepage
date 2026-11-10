'use strict';
const {Worker}=require('node:worker_threads');
const {DEFAULTS,normalizeInput}=require('./repowering-engine');
const inverters=require('./calculator-data/calculator-inverters.json').filter(inv=>inv.kw!==350);
module.exports=app=>{
  let active=0;
  const clients=new Map();
  const cleanup=setInterval(()=>{for(const [key,value] of clients)if(Date.now()-value.start>=60000)clients.delete(key);},60000);cleanup.unref();
  app.get('/api/repowering/catalog',(req,res)=>{res.set('Cache-Control','no-store');res.json({inverters,defaults:DEFAULTS});});
  app.post('/api/repowering/calculate',(req,res)=>{
    res.set('Cache-Control','no-store');
    try{normalizeInput(req.body);}catch(e){return res.status(400).json({message:e.message});}
    const key=req.ip||req.socket?.remoteAddress||'unknown',now=Date.now();
    let client=clients.get(key);
    if(!client||now-client.start>=60000){if(clients.size>=10000)return res.status(503).json({message:'잠시 후 다시 계산해 주세요.'});client={start:now,count:0};clients.set(key,client);}
    if(++client.count>30)return res.status(429).json({message:'계산 요청이 많습니다. 1분 후 다시 실행하세요.'});
    if(active>=2)return res.status(503).json({message:'다른 계산을 처리 중입니다. 잠시 후 다시 실행하세요.'});
    let worker;
    try{worker=new Worker(require.resolve('./repowering-engine'),{workerData:{repoweringJob:true,input:req.body},resourceLimits:{maxOldGenerationSizeMb:128}});}catch(e){return res.status(503).json({message:'계산 처리를 시작하지 못했습니다.'});}
    active++;
    let done=false;
    const finish=(status,body)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate().catch(()=>{});if(!res.destroyed&&!res.writableEnded)res.status(status).json(body);};
    const timer=setTimeout(()=>finish(503,{message:'계산 시간이 초과되었습니다. 설비를 구간별로 나누어 검토하세요.'}),30000);
    worker.once('message',data=>data.error?finish(400,{message:data.error}):finish(200,data.result));
    worker.once('error',()=>finish(500,{message:'리파워링 계산에 실패했습니다.'}));
    worker.once('exit',()=>{active--;finish(500,{message:'리파워링 계산이 중단되었습니다.'});});
    res.once('close',()=>finish(499,{message:'요청 연결이 종료되었습니다.'}));
  });
};
