# 결과물 하자 개선 요청서 자동 발송 시스템 — 배포 가이드

## 1. Supabase 설정 (대시보드에서 진행, 터미널 불필요)

1. supabase.com 에서 새 프로젝트 생성
2. **SQL Editor** 열고 `schema.sql` 전체 붙여넣기 후 Run
   → stores / subcontractors / submissions 테이블 + `defect-reports` Storage 버킷까지 한 번에 생성됨
3. **Project Settings > API** 에서 `Project URL`, `anon public key` 복사

## 2. index.html 설정값 채우기

파일 상단 `<script>` 부분에서:
```js
const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";   // 1번에서 복사한 URL
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";                  // 1번에서 복사한 anon key
```
관리자 비밀번호는 더 이상 이 파일에 넣지 않음 (4-1번 참고, 서버 쪽 환경변수로만 관리).

## 3. GitHub Pages 배포

1. GitHub 저장소 생성 (예: `defect-report-system`)
2. `index.html` 업로드
3. 저장소 **Settings > Pages** 에서 `main` 브랜치 배포 활성화
4. 발급된 주소(`https://gabeenya.github.io/defect-report-system`)로 모바일 접속 확인

여기까지 하면 **매장코드 생성 · 수급사 관리 · 하자 작성 · 문서(.pdf) 자동생성 · 발송이력**까지 전부 동작해.
메일 발송만 4번 완료 전까지는 "발송 실패"로 기록되고, 문서 자체는 이력에서 다운로드 가능해.

## 4. 메일 발송 연동 (Gmail 또는 네이버 메일, IT팀 승인 불필요)

회사 메일 주소를 쓸 수 없는 경우를 대비해, 마이크로소프트 Graph API(IT팀 자격증명 필요) 대신 **일반 메일 계정의 SMTP**로 발송하도록 구성되어 있음. Gmail, 네이버 메일 둘 다 가능 — 아래 Secrets 값만 다르게 넣으면 됨.

### 4-A. Gmail로 할 경우

1. 발신용 Gmail 계정 준비 (예: `elandeats.defect@gmail.com`)
2. **2단계 인증** 켜기 — [myaccount.google.com/security](https://myaccount.google.com/security)
3. **앱 비밀번호** 발급 — [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) 에서 앱 이름 아무거나 입력 → 생성된 16자리 비밀번호 복사 (평소 로그인 비밀번호와 다름, 한 번만 보여줌)
4. Secrets에 등록할 값:
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_USER` = Gmail 주소
   - `SMTP_PASSWORD` = 발급받은 16자리 앱 비밀번호

### 4-B. 네이버 메일로 할 경우

1. 발신용 네이버 계정 준비
2. 네이버 메일 접속 → **환경설정 > POP3/IMAP 설정** 탭 → **POP3/SMTP 사용**을 "사용함"으로 변경 → 저장
3. 네이버 계정에 2단계 인증(OTP)을 켜둔 상태라면 **네이버 아이디 > 보안설정 > 앱 비밀번호**에서 앱 비밀번호 발급 (안 켜놨으면 로그인 비밀번호 그대로 사용 가능)
4. Secrets에 등록할 값:
   - `SMTP_HOST` = `smtp.naver.com`
   - `SMTP_USER` = 네이버 아이디 전체 (예: `elandeats.defect@naver.com`)
   - `SMTP_PASSWORD` = 로그인 비밀번호 또는 2번에서 발급받은 앱 비밀번호

### 공통 배포 단계

1. Supabase 대시보드 → **Edge Functions** → **Deploy a new function** (또는 Create) → 이름 `send-defect-email` 입력 → 코드 편집창에 `send-defect-email.ts` 내용 전체 붙여넣기 → **Deploy**
2. 함수의 **Secrets** 탭에서 위 4-A 또는 4-B의 값 등록 (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`)
3. 완료되면 이후 제출 건부터 자동 메일 발송 정상 동작 (기존 "발송 실패" 건은 이력 화면에서 문서만 재확인/수동발송 필요)

메일 제목은 `[이랜드이츠] 하자개선 요청서`로 고정되어 있음 (index.html의 `MAIL_SUBJECT` 값).

## 4-1. 관리자 기능 보안 패치 (admin-action 배포) — 필수

기존에는 관리자 비밀번호가 `index.html`에 하드코딩되어 있었고, `stores`/`subcontractors` 테이블에 anon key로 누구나 직접 쓸 수 있었음(RLS가 전체 허용). 아래 작업으로 비밀번호를 서버(Edge Function 환경변수)로 옮기고, 매장코드 생성·수급사 등록/수정은 서버에서 비밀번호를 검증한 뒤에만 수행되도록 막음.

1. `schema (2).sql` 맨 아래 "[보안 패치]" 블록을 SQL Editor에서 실행 (`stores_insert`, `subcontractors_all` 정책 삭제 + `subcontractors_select`만 재생성)
2. Edge Function 배포:
   ```
   npx supabase functions deploy admin-action
   ```
3. Supabase 대시보드 **Edge Functions > admin-action > Secrets** 에서 등록:
   - `ADMIN_PASSWORD` — 관리자 비밀번호 (예전 `2496`을 그대로 쓰거나 새 값으로 변경)
4. 배포 후 관리자 화면 로그인/매장코드 생성/수급사 등록·수정이 모두 이 비밀번호로 서버에서 검증됨

## 참고
- 사진은 최대 5장, 문서(.pdf) 내부에 자동 삽입됨 (화면에 보이는 양식 그대로 캡처해 PDF로 변환하는 방식 — 한글 폰트 문제 없음)
- 관리자 화면 **전체 발송 이력**에서 모든 매장의 제출 건과 문서를 조회/다운로드 가능
- `submissions`/`stores` 테이블의 select와 `submissions` insert는 여전히 anon key로 열려있음 (매장코드 조회·하자 제출은 로그인 없는 내부망 전용 도구 특성상 의도된 동작). 더 강한 접근 통제(매장별 계정 로그인 등)가 필요하면 알려줘, Supabase Auth로 교체 가능
