'use strict';
const {Worker} = require('node:worker_threads');
const {normalizeInput, INVERTERS} = require('./calculator-engine');
const {store:moduleStore} = require('./module-store');
module.exports = app => {
  let active = 0;
  const clients = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of clients) if (now - value.start > 60000) clients.delete(key);
  }, 60000);
  cleanup.unref();

  // 기존 public/data 파일은 다른 화면이 사용할 수 있어 삭제하지 않습니다.
  // 계산기는 아래 API를 사용하고, 계산 알고리즘은 public 밖에서만 실행합니다.
  app.get('/api/calculator/catalog', (req, res) => {
    res.set('Cache-Control','no-store');
    try {res.json({modules:moduleStore.catalog(), inverters:INVERTERS});}
    catch(error){res.status(503).json({message:error.message});}
  });
  app.post('/api/calculator/calculate', (req, res) => {
    res.set('Cache-Control','no-store');
    let catalog;
    try { catalog=moduleStore.catalog();normalizeInput(req.body,catalog); }
    catch (error) { return res.status(error.status||400).json({message:error.message}); }
    const key = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    let client = clients.get(key);
    if (!client || now - client.start > 60000) {
      if (clients.size >= 10000) return res.status(503).json({message:'잠시 후 다시 계산해 주세요.'});
      client = {start:now,count:0}; clients.set(key,client);
    }
    if (++client.count > 30) return res.status(429).json({message:'계산 요청이 많습니다. 1분 뒤 다시 실행하세요.'});
    if (active >= 2) return res.status(503).json({message:'다른 계산을 처리 중입니다. 잠시 후 다시 실행하세요.'});
    active++;
    let worker;
    try {
      worker = new Worker(require.resolve('./calculator-engine'), {
        workerData:{calculatorJob:true,input:req.body,catalog}, resourceLimits:{maxOldGenerationSizeMb:128}
      });
    } catch (error) {
      active--;
      return res.status(503).json({message:'계산 처리를 시작하지 못했습니다.'});
    }
    let done = false;
    const finish = (status, body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (!res.destroyed && !res.writableEnded) res.status(status).json(body);
    };
    const timer = setTimeout(() => finish(503,{message:'계산 시간이 초과되었습니다. 조건을 확인하고 다시 실행하세요.'}),30000);
    worker.once('message', data => data.error
      ? finish(400,{message:data.error}) : finish(200,data.result));
    worker.once('error', () => finish(500,{message:'서버 계산에 실패했습니다.'}));
    worker.once('exit', () => { active--; finish(500,{message:'서버 계산이 중단되었습니다.'}); });
    res.once('close', () => finish(499,{message:'요청 연결이 종료되었습니다.'}));
  });
};
