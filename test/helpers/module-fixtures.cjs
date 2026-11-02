'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
function pdf(objects) {
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let length=chunks[0].length;
  for(let i=0;i<objects.length;i++){offsets.push(length);const chunk=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),Buffer.from(objects[i]),Buffer.from('\nendobj\n')]);chunks.push(chunk);length+=chunk.length;}
  chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
const lines=['Manufacturer: Test Solar','Series: TEST Series','Model: TEST-650','STC','Rated power (Pmax) 650 W','Open circuit voltage (Voc) 50 V','Maximum power voltage (Vmp) 40 V','Short circuit current (Isc) 17 A','Maximum power current (Imp) 16.25 A','Module efficiency 23 %','Maximum system voltage 1500 V','Maximum series fuse 30 A','Temperature coefficient Voc -0.25 %/C','Temperature coefficient Isc 0.04 %/C','Temperature coefficient Pmax -0.29 %/C'];
function textPDF() {
  const content='BT /F1 13 Tf 40 750 Td 28 TL '+lines.map((s,i)=>(i?'T* ':'')+'('+s.replace(/[()\\]/g,'\\$&')+') Tj').join('\n')+' ET';
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`]);
}
function scannedPDF(jpeg,width=1600,height=2000) {
  const content='q 612 0 0 792 0 0 cm /Im0 Do Q';
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]),`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
}
function testApp() {
  process.env.ADMIN_USERNAME='module-test-admin';
  const password=crypto.randomBytes(24).toString('hex'),salt=crypto.randomBytes(16).toString('hex');
  process.env.ADMIN_PASSWORD_HASH=salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
  const express=require('express'),app=express();
  app.use(express.json());
  // Only the DB-backed login rate limiter is replaced. Session, password,
  // authorization, Origin and CSRF code are the production implementation.
  app.locals.security={loginLimit:(req,res,next)=>next()};
  require('../../server/admin')(app,{query:()=>{throw Error('Unexpected database access');}});
  require('../../server/calculator')(app);
  app.use(express.static(path.join(__dirname,'../../public')));
  app.use((error,req,res,next)=>res.status(error.status||500).json({message:error.message}));
  return {app,password};
}
const moduleBody={manufacturer:'Test Solar',series:'TEST Series',name:'TEST-650',p:650,voc:50,vmp:40,isc:17,imp:16.25,eff:23,maxV:1500,betaVoc:-.25,alphaIsc:.04,gammaPower:-.29,maxSeriesFuse:30,bnpi:650,bnpiVoc:50,bnpiVmp:40,bnpiIsc:17,bnpiImp:16.25,reviewed:true};
module.exports={textPDF,scannedPDF,testApp,moduleBody};
