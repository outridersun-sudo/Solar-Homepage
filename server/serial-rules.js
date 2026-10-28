/* Same validator is embedded in public/as-request.html. No DB lookup here. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.SolisSerialRules=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const months=['1','2','3','4','5','6','7','8','9','A','B','C'];
  const labels={model:'모델코드(1~6번째)',fuse:'퓨즈 구분(7번째)',year:'생산 연도(8~9번째)',month:'생산 월(10번째)',day:'생산 일자(11~12번째)',sequence:'생산 순번(13~16번째)'};
  function inspect(source,compact){
    const parts={},errors=[];
    for(const field of Object.keys(labels))parts[field]=typeof source[field]==='string'?(compact?source[field].trim():source[field]).toUpperCase():'';
    const issue=(field,rule)=>errors.push({field,message:labels[field]+': '+rule+' 수정해 주세요.'});
    if(!/^[A-Z0-9]{6}$/.test(parts.model))issue('model','영문·숫자 6자리로');
    if(!/^[A-F]$/.test(parts.fuse))issue('fuse','A·B·C·D·E·F 중 하나로');
    const yearOK=(compact?/^\d{1,2}$/:/^\d{2}$/).test(parts.year);
    if(!yearOK)issue('year','연도의 뒤 두 자리 숫자로');
    const monthOK=months.includes(parts.month);
    if(!monthOK)issue('month','1~9 또는 A(10월)·B(11월)·C(12월)로');
    const dayOK=(compact?/^\d{1,2}$/:/^\d{2}$/).test(parts.day)&&Number(parts.day)>=1&&Number(parts.day)<=31;
    if(!dayOK)issue('day','01~31 범위의 숫자로');
    else if(yearOK&&monthOK){
      const last=new Date(Date.UTC(2000+Number(parts.year),months.indexOf(parts.month)+1,0)).getUTCDate();
      if(Number(parts.day)>last)issue('day','해당 연도·월에 존재하는 날짜(01~'+String(last).padStart(2,'0')+')로');
    }
    if(!(compact?/^\d{1,4}$/:/^\d{4}$/).test(parts.sequence)||Number(parts.sequence)<1||Number(parts.sequence)>9999)issue('sequence','0001~9999 범위의 숫자로');
    const valid=errors.length===0;
    if(valid){parts.year=parts.year.padStart(2,'0');parts.day=parts.day.padStart(2,'0');parts.sequence=parts.sequence.padStart(4,'0');}
    return{valid,parts,errors,serial:valid?parts.model+parts.fuse+parts.year+parts.month+parts.day+parts.sequence:'',message:errors.map(error=>error.message).join('\n')};
  }
  function validate(value){
    const serial=typeof value==='string'?value.trim().toUpperCase():'';
    if(serial.length!==16){const message='시리얼 번호(S/N): 16자리로 수정해 주세요. 현재 '+serial.length+'자리입니다.';return{valid:false,serial,parts:null,errors:[{field:'serial',message}],message};}
    const parts={model:serial.slice(0,6),fuse:serial[6],year:serial.slice(7,9),month:serial[9],day:serial.slice(10,12),sequence:serial.slice(12)};
    const result=inspect(parts,false);return{...result,serial:result.valid?result.serial:serial};
  }
  return Object.freeze({validate,validateParts:parts=>inspect(parts||{},true)});
});
