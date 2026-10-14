async function notifyAsRequest(request) {
  console.log('\n========== 정식 A/S 접수 알림 (개발용) ==========');
  console.log('접수번호:', request.requestNumber);
  console.log('제품 구분:', request.productType);
  console.log('모델명:', request.modelName);
  console.log('담당자에게 관리자 화면 확인 요청 / 실제 문자 미발송');
  console.log('================================================\n');
  return { mode: 'console', sent: false };
}
module.exports = { notifyAsRequest };
