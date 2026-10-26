'use strict';
const crypto = require('node:crypto');
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SUCCESS = '견적문의가 정상적으로 처리되었습니다. 담당자가 확인 후 연락드리겠습니다.';

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function readConfig(env = process.env) {
  const host = (env.SMTP_HOST || '').trim();
  const user = (env.SMTP_USER || '').trim();
  const pass = env.SMTP_PASS || '';
  if (!host || !user || !pass) throw problem('SMTP_HOST, SMTP_USER, SMTP_PASS 설정을 확인하세요.', 503);
  if (!/^[a-z0-9.-]+$/i.test(host)) throw problem('SMTP_HOST에는 URL이나 포트 없이 서버 이름만 입력하세요.', 503);
  const port = Number(env.SMTP_PORT || 587);
  const secureText = String(env.SMTP_SECURE ?? (port === 465 ? 'true' : 'false')).trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['true','false'].includes(secureText)) throw problem('SMTP_PORT 또는 SMTP_SECURE 설정을 확인하세요.', 503);
  const secure = secureText === 'true';
  if (port === 465 && !secure) throw problem('465 포트는 SMTP_SECURE=true로 설정하세요.', 503);
  if (port === 587 && secure) throw problem('587 STARTTLS 포트는 SMTP_SECURE=false로 설정하세요.', 503);
  const from = (env.MAIL_FROM || 'dschoi@ci-fy.com').trim();
  const to = [...new Set((env.MAIL_TO || 'kbs@ci-fy.com,dschoi@ci-fy.com,syshin@ci-fy.com').split(',').map(x=>x.trim().toLowerCase()))];
  if (!EMAIL.test(from) || !to.length || to.length > 10 || to.some(x=>!EMAIL.test(x))) throw problem('MAIL_FROM 또는 MAIL_TO 이메일 주소를 확인하세요.', 503);
  return { from, to, smtp: { host, port, secure, auth:{user,pass},
    requireTLS:!secure, tls:{minVersion:'TLSv1.2'},
    connectionTimeout:10000, greetingTimeout:10000, socketTimeout:30000,
    disableFileAccess:true, disableUrlAccess:true } };
}

function validateQuote(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('입력 형식을 확인해 주세요.');
  const allowed = new Set(['source','company','contact','phone','email','deliveryRegion','deliveryDate','request','recommendation','products','privacyAgreed']);
  if (Object.keys(body).some(key=>!allowed.has(key))) throw problem('지원하지 않는 입력 항목이 있습니다.');
  function text(value, max, multiline = false) {
    if (value == null) return '';
    if (typeof value !== 'string') throw problem('입력 형식을 확인해 주세요.');
    const result = value.trim();
    if (result.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(result)) throw problem('입력 내용의 길이와 문자를 확인해 주세요.');
    return result;
  }
  const data = {
    company:text(body.company,120), contact:text(body.contact,60),
    phone:text(body.phone,32), email:text(body.email,254),
    deliveryRegion:text(body.deliveryRegion,150), deliveryDate:text(body.deliveryDate,10),
    source:body.source ?? null,
    request:text(body.request,8000,true), recommendation:body.recommendation ?? false,
    privacyAgreed:body.privacyAgreed, products:[]
  };
  if (!data.contact) throw problem('담당자명을 입력해 주세요.');
  if (data.source !== null && !['direct','calculator'].includes(data.source)) throw problem('견적 요청 경로를 확인해 주세요.');
  if (!data.phone && !data.email) throw problem('연락처 또는 이메일 중 하나를 입력해 주세요.');
  const digits = data.phone.replace(/\D/g,'');
  if (data.phone && (!/^[+\d\s()\-]+$/.test(data.phone) || digits.length < 8 || digits.length > 16)) throw problem('연락 가능한 전화번호를 입력해 주세요.');
  if (data.email && !EMAIL.test(data.email)) throw problem('이메일 주소를 확인해 주세요.');
  if (data.privacyAgreed !== true) throw problem('개인정보 수집·이용에 동의해 주세요.');
  if (typeof data.recommendation !== 'boolean') throw problem('제품 추천 요청 값을 확인해 주세요.');
  if (data.deliveryDate) {
    const date = new Date(data.deliveryDate + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.deliveryDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== data.deliveryDate) throw problem('희망 납기일을 확인해 주세요.');
  }
  const products = body.products ?? [];
  if (!Array.isArray(products) || products.length > 30) throw problem('제품은 최대 30개 행까지 입력할 수 있습니다.');
  for (const item of products) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !['module','inverter'].includes(item.kind)) throw problem('제품 구분을 확인해 주세요.');
    const productFields = ['kind','manufacturer','model','power','quantity','selectionStatus','selectedModelLabel','selectedFuseA','selectedFuseV'];
    if (Object.keys(item).some(key=>!productFields.includes(key))) throw problem('제품 입력 항목을 확인해 주세요.');
    const product = {kind:item.kind,manufacturer:text(item.manufacturer,120),model:text(item.model,150)};
    for (const [key,max] of [['power',100000],['quantity',1000000]]) {
      const value = item[key] ?? null;
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || (key === 'quantity' && !Number.isInteger(value)))) throw problem('제품 용량 또는 수량을 확인해 주세요.');
      product[key] = value;
    }
    const hasSelection = ['selectionStatus','selectedModelLabel','selectedFuseA','selectedFuseV'].some(key=>Object.prototype.hasOwnProperty.call(item,key));
    if (hasSelection) {
      if (item.kind !== 'inverter' || !['selected','unavailable','unconfirmed','unused'].includes(item.selectionStatus)) throw problem('퓨즈 선정 상태를 확인해 주세요.');
      product.selectionStatus = item.selectionStatus;
      if (item.selectionStatus === 'selected') {
        const label = text(item.selectedModelLabel,180);
        const current = item.selectedFuseA;
        const voltage = item.selectedFuseV;
        if (!product.model || !label || !Number.isFinite(current) || current <= 0 || current > 1000 ||
            !Number.isFinite(voltage) || voltage <= 0 || voltage > 3000 ||
            label !== product.model.replace(/-K\d+(?:A)?$/, '') + '-K' + current + 'A') throw problem('퓨즈 선정 표기와 정격을 확인해 주세요.');
        product.selectedModelLabel = label;
        product.selectedFuseA = current;
        product.selectedFuseV = voltage;
      } else if (['selectedModelLabel','selectedFuseA','selectedFuseV'].some(key=>item[key] != null)) {
        throw problem('퓨즈 선정 상태와 정격이 일치하지 않습니다.');
      }
    }
    data.products.push(product);
  }
  // 구형 계산기 연계 화면도 호환한다. source는 표시용이며 접근 권한 판단에는 사용하지 않는다.
  data.source ??= data.products.some(product=>product.selectionStatus) || /^\[계산기\s*연계/.test(data.request) ? 'calculator' : 'direct';
  return data;
}

function mailText(data, requestId, receivedAt) {
  const lines = ['천일테크윈 태양광 제품 견적문의', '요청 식별자: ' + requestId,
    '서버 접수 시각(한국): ' + receivedAt.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}),
    '접수 구분: ' + (data.source === 'calculator' ? '계산기 견적 연계' : '직접 견적 요청'), '', '[담당자 정보]',
    '회사명: ' + (data.company || '미입력'), '담당자명: ' + data.contact,
    '연락처: ' + (data.phone || '미입력'), '이메일: ' + (data.email || '미입력'), '', '[요청 제품]',
    '제품 추천 요청: ' + (data.recommendation ? '예' : '아니오')];
  if (!data.products.length) lines.push('제품 정보 미입력 · 상담 시 확인');
  data.products.forEach((p,i)=>{
    lines.push((i+1)+'. '+(p.kind==='module'?'태양광 모듈':'태양광 인버터')+' / '+(p.manufacturer||'제조사 미정')+' / '+(p.selectedModelLabel||p.model||'모델 미정')+' / '+(p.power===null?'용량 미정':p.power+(p.kind==='module'?'W':'kW'))+' / '+(p.quantity===null?'수량 미정':p.quantity+(p.kind==='module'?'장':'대')));
    if (p.selectionStatus === 'selected') lines.push('   제품 기본 모델: '+p.model, '   선정 퓨즈: '+p.selectedFuseV+'V / '+p.selectedFuseA+'A (계산기 참고 선정)');
    else if (p.selectionStatus) lines.push('   퓨즈 선정: '+({unavailable:'선정 불가',unconfirmed:'자료 확인 필요',unused:'연결 모듈 없음'}[p.selectionStatus]));
  });
  if (data.products.some(product=>product.selectionStatus === 'selected')) lines.push('', '※ KxxA는 선정 퓨즈 정격을 반영한 계산기 표시명입니다. 제품 기본 모델과 구분하여 확인해 주세요.');
  lines.push('', '[납품 및 요청사항]', '납품 지역: '+(data.deliveryRegion||'미입력'), '희망 납기일: '+(data.deliveryDate||'미입력'), '요청사항: '+(data.request||'없음'), '', '개인정보 수집·이용: 동의', '첨부파일: 사용하지 않음');
  return lines.join('\n');
}

function createService({env=process.env,transport,now=()=>Date.now(),logger=console} = {}) {
  let config, configError;
  try { config=readConfig(env); } catch(error) { configError=error; }
  if (config && !transport) transport=require('nodemailer').createTransport(config.smtp);
  const requests = new Map();
  const ttl = 30 * 60 * 1000;
  return async function submit(body, key) {
    const data=validateQuote(body);
    if (!UUID.test(key || '')) throw problem('화면을 새로고침한 뒤 다시 시도해 주세요.');
    if (configError) throw problem('현재 견적문의 전송을 이용할 수 없습니다. 전화로 문의해 주세요.',503);
    for (const [id,entry] of requests) if (!entry.promise && now()-entry.createdAt >= ttl) requests.delete(id);
    const digest=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    let entry=requests.get(key);
    if (entry && entry.digest !== digest) throw problem('이전 요청과 내용이 다릅니다. 내용을 확인한 뒤 다시 제출해 주세요.',409);
    if (!entry) {
      if (requests.size >= 1000) throw problem('현재 요청이 많습니다. 잠시 후 다시 시도해 주세요.',503);
      entry={digest,createdAt:now(),accepted:new Set(),complete:false,promise:null};
      requests.set(key,entry);
    }
    if (entry.complete) return {success:true,message:SUCCESS,duplicate:true};
    if (entry.promise) return entry.promise;
    const job=(async()=> {
      const remaining=config.to.filter(address=>!entry.accepted.has(address));
      try {
        const info=await transport.sendMail({
          from:{name:'천일테크윈 견적문의',address:config.from}, to:remaining,
          replyTo:data.email?{name:data.contact,address:data.email}:undefined,
          envelope:{from:config.from,to:remaining},
          subject:'[천일테크윈 견적문의] '+data.contact,
          text:mailText(data,key,new Date(entry.createdAt)),
          disableFileAccess:true, disableUrlAccess:true
        });
        for (const address of info.accepted || []) {
          const normalized=String(typeof address==='string'?address:address.address||'').toLowerCase();
          if (remaining.includes(normalized)) entry.accepted.add(normalized);
        }
        if (!config.to.every(address=>entry.accepted.has(address))) throw problem('메일 접수를 확인하지 못했습니다. 잠시 후 다시 시도하거나 전화로 문의해 주세요.',502);
        entry.complete=true;
        return {success:true,message:SUCCESS};
      } catch(error) {
        // Do not log customer input, credentials or the raw SMTP error/response.
        const code=String(error.code||'MAIL_SEND_FAILED').replace(/[^A-Z0-9_]/gi,'').slice(0,40);
        logger.error('견적메일 발송 확인 실패:',code);
        throw problem('메일 접수를 확인하지 못했습니다. 잠시 후 다시 시도하거나 전화로 문의해 주세요.',502);
      }
    })();
    entry.promise=job;
    try { return await job; } finally { entry.promise=null; }
  };
}

function registerQuoteMail(app, security, options={}) {
  const submit=createService(options);
  app.post('/api/quote-requests',security.submissionLimit,async(req,res)=> {
    res.set('Cache-Control','no-store');
    try { res.status(200).json(await submit(req.body,req.get('X-Submission-Id'))); }
    catch(error) { res.status(error.status||500).json({success:false,message:error.status?error.message:'견적문의 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.'}); }
  });
}
module.exports=registerQuoteMail;
module.exports.createService=createService;
module.exports.readConfig=readConfig;
module.exports.validateQuote=validateQuote;
module.exports.mailText=mailText;
