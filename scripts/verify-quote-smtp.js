'use strict';
require('dotenv').config();
const {readConfig}=require('../server/quote-mail');
(async()=>{
  const config=readConfig();
  const transport=require('nodemailer').createTransport(config.smtp);
  try {
    await transport.verify();
    console.log('SMTP 연결·인증 확인 완료. 메일은 발송하지 않았습니다.');
    console.log('발신 주소:',config.from);
    console.log('수신 주소:',config.to.join(', '));
    console.log('발신 주소 허용 및 실제 수신 여부는 홈페이지에서 별도로 확인하세요.');
  } finally { transport.close(); }
})().catch(error=>{
  const safeCodes=new Set(['EAUTH','ECONNECTION','ETIMEDOUT','ESOCKET','EDNS','ETLS','ECONNREFUSED','ENOTFOUND']);
  console.error('SMTP 확인 실패:',safeCodes.has(error.code)?error.code:'설정 또는 연결을 확인하세요.');
  if (error.status===503) console.error(error.message);
  process.exitCode=1;
});
