# 태양광 모듈 등록 적용 안내 — 20261030 modules-r1

관리자 화면의 ‘기술자료 관리’ 옆에 ‘태양광 모듈 등록’을 추가했습니다.
PDF 업로드 → 모델 선택 → 사양 확인·수정 → 등록 및 계산기 적용 순서입니다.
이 ZIP은 기존 프로젝트에 덮어쓰는 수정 소스입니다. 운영 서버에는 자동 배포하지 않았습니다.

## PC 적용

1. `D:\Works\Solar-Homepage`에서 실행 중인 서버를 Ctrl+C로 종료합니다.
2. 기존 소스를 백업하고 ZIP의 경로를 유지해 같은 프로젝트에 덮어씁니다.
   `public`뿐 아니라 `server`, `server.js`, `package.json`, `package-lock.json`도 반영합니다.
   `.env`와 `uploads`는 덮어쓰거나 삭제하지 않습니다.
3. Node.js **22.13 이상**을 사용합니다. 기존 버전이 낮으면 지원되는 LTS로 업데이트합니다.
4. PowerShell에서 실행합니다.

   ```powershell
   cd D:\Works\Solar-Homepage
   node --version
   npm ci
   node server.js
   ```

5. `http://localhost:3000/admin.html`에서 기존 관리자 계정으로 로그인하고
   ‘태양광 모듈 등록’을 선택합니다. `admin-modules.html`에서 바로 로그인할 수도 있습니다.
6. 기존 화면이 보이면 Ctrl+Shift+R로 새로고침합니다.

## 등록과 수정

- PDF는 최대 20MB, 16페이지입니다. 유료 AI API는 사용하지 않습니다.
- 모델별 STC/BNPI 전기 사양, 온도계수, 시스템 전압, 퓨즈 정격을 추출합니다.
  HD현대 NA·NJ-ES·NR 및 TW 730~750W 사양서로 검증했습니다.
- PDF 배치나 인식 품질에 따라 추출하지 못하는 값은 직접 입력합니다.
  숫자·소수점·온도계수 부호를 원본과 비교한 뒤 확인 체크를 합니다.
- 미리보기는 실제 PDF 페이지를 이미지로 표시합니다. 확대와 원본 다운로드를 지원합니다.
- 제조사·시리즈·모델명, STC/BNPI 사양, BNPI 후면 일사율, Voc/Isc/Pmax 계수,
  시스템 전압, 직렬 퓨즈, 효율은 적용 전 필수 항목입니다.
- Vmpp 온도계수는 기존 계산기 정책에 따라 Voc 계수를 임시 사용합니다.
- **임시 저장**은 계산기에 반영하지 않습니다. 적용 중인 모듈의 수정 내용을
  임시 저장해도 기존 적용값은 유지됩니다.
- **등록 및 계산기 적용**은 즉시 적용합니다. 계산기 화면을 새로고침하면
  제조사·시리즈·모델 목록에 나타나며 서버 재시작은 필요하지 않습니다.
- 기본 목록과 같은 모델명은 ‘기존 사양 갱신’ 확인이 필요합니다.
  다른 등록 기록과 이름이 겹치면 해당 기록을 수정합니다.
- 적용한 제조사·시리즈·모델명은 변경하지 않습니다. 다른 모델은 새로 등록합니다.
- **사용 중지 / 다시 적용**으로 계산기에서 제외하거나 복구합니다.
  중지한 모듈은 이전 화면에서 계산을 요청하더라도 서버가 거부합니다.

## 스캔 PDF의 OCR

텍스트 PDF 추출과 미리보기는 `npm ci`만으로 동작합니다.
스캔 PDF는 **Tesseract와 한국어(kor)·영어(eng) 데이터**가 추가로 필요합니다.
앞쪽 스캔 4페이지까지 OCR하며, 도구가 없거나 읽기 어려우면 직접 입력 안내를 표시합니다.

Ubuntu 서버에서 OCR을 사용할 경우:

```bash
apt-get update
apt-get install -y tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng
```

Windows는 Tesseract와 kor/eng 데이터를 설치하고 PATH에 등록하거나 `.env`에
아래 실행 파일 경로를 설정한 뒤 Node.js를 재시작합니다.

```dotenv
TESSERACT_PATH=C:/Program Files/Tesseract-OCR/tesseract.exe
```

## 저장 위치와 운영 서버

- 모듈 저장용 DB 테이블을 추가하지 않습니다. 로그인은 기존 관리자 인증을 사용합니다.
- 기본 저장 위치: `uploads/module-catalog/`
  - `catalog.json`: 임시 사양·적용 사양·사용 상태·수정 버전
  - `documents/`: 원본 PDF·페이지 미리보기·파일 정보
  - `backups/`: 최근 30개 변경 전 사양 백업
- 잠금과 수정 버전으로 동시 저장 충돌을 차단하고 임시 파일을 원자적으로 교체합니다.
- PDF와 미리보기는 `public` 밖에 있으며 관리자 로그인 없이는 읽을 수 없습니다.
- `.env`의 `MODULE_DATA_DIR`로 다른 경로를 지정할 수 있습니다.
  웹 공개 폴더나 소스 배포로 교체되는 폴더는 사용하지 않습니다.
- 기존 운영 서버 `/opt/solar_homepage`, PM2 `appuser/solar_homepage`에도
  변경 소스 전체와 패키지 파일을 반영합니다. 기존 `ops/update-production.sh`는
  패키지 변경 시 의존성을 설치하고 `uploads`, `.env`, PM2 실행 파일을 유지합니다.
- 기존 사이트 백업 명령은 `uploads`를 제외하므로 **등록 데이터 폴더를 별도로 백업**합니다.
  JSON 백업만으로는 원본 PDF까지 복구할 수 없습니다.
- 기본 경로의 서버 저장 권한이 필요할 경우:

  ```bash
  install -d -o appuser -g "$(id -gn appuser)" -m 700 /opt/solar_homepage/uploads/module-catalog
  ```

## 검증

```bash
node --test --test-isolation=none test/admin-modules.test.js test/calculator.test.js
node test/admin-modules-ui.cjs
node test/calculator-ui.cjs
node test/module-ocr.cjs
```

브라우저 검증에는 Playwright·Chromium, OCR 검증에는 Tesseract·kor/eng 데이터가 필요합니다.
테스트는 임시 폴더와 테스트 계정을 사용하며 운영 계정이나 등록 자료를 변경하지 않습니다.
