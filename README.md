# Solar-Homepage — 텍스트 등록 정리본 v11

천일테크윈 홈페이지, 태양광 설비 구성 계산기 및 관리자 기능 소스입니다.
태양광 모듈 등록은 **GPT 분석 결과의 28개 열 텍스트 붙여넣기** 방식으로 정리했습니다.

## 적용

전체 ZIP을 새 폴더에 풀어 사용하세요. 기존 폴더에 덮어쓰기만 하면 삭제 대상 파일이 남습니다.
기존 `.env`, `uploads`, 별도 `MODULE_DATA_DIR`의 카탈로그·업로드 자료를 반드시 보존·연결하세요.
절차는 [전체 소스 적용 안내](CLEANUP-README.txt), 삭제 목록은 [REMOVED-FILES.txt](REMOVED-FILES.txt)에 있습니다.

## 실행

Node.js 24 환경에서:

```sh
npm ci
node setup-security.js
npm start
```

`setup-security.js`는 기존 보안 키를 유지하며 없을 때만 로컬 `.env`에 생성합니다.
Windows PowerShell에서 npm.ps1이 차단되면 `npm.cmd ci`, `npm.cmd start`를 사용하세요.
기존 관리자·DB·SMTP 설정은 필요한 기능에 맞게 기존 `.env`를 사용합니다. 비밀값은 저장소에 넣지 마세요.

모듈 등록에는 PDF·이미지 분석 도구가 필요하지 않습니다.
A/S 첨부·기술자료 업로드의 `multer`와 `file-type` 의존성은 계속 사용합니다.

## 모듈 등록

[등록 안내](docs/module-registration.md)와 [28개 열 규격](docs/module-text-import.md)을 참고하세요.
`examples/`에는 3개 제조사의 TSV 형식 예제가 있으며 자동 등록되지는 않습니다.

## 검증

```sh
npm test
npm run test:ui
```

브라우저 검증은 Playwright 및 Chromium이 있는 개발 환경에서 수행합니다.
계산기 UI 테스트의 3000 포트는 비워 두세요. 실제 운영 DB·SMTP에 대한 확인은 별도입니다.

메일 연결 진단은 기존 `npm run verify:quote-mail` 명령으로 실행하며 실제 메일은 발송하지 않습니다.
