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

여기까지 하면 **매장코드 생성(매장 사용자 셀프) · 수급사 관리 · 하자 작성 · 문서(.pdf) 자동생성 · 발송이력**까지 전부 동작해.
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

메일 제목은 `[브랜드명][매장명] 하자개선요청서` 형식으로, 매장코드에 등록된 브랜드·매장명이 자동으로 들어감 (send-defect-email.ts의 `mailSubject`).

## 4-1. 관리자 기능 보안 패치 (admin-action 배포) — 필수

기존에는 관리자 비밀번호가 `index.html`에 하드코딩되어 있었고, `stores`/`subcontractors` 테이블에 anon key로 누구나 직접 쓸 수 있었음(RLS가 전체 허용). 아래 작업으로 비밀번호를 서버(Edge Function 환경변수)로 옮기고, 매장코드 생성·수급사 등록/수정은 서버에서 비밀번호를 검증한 뒤에만 수행되도록 막음.

1. `schema (2).sql` 맨 아래 "[보안 패치]" 블록을 SQL Editor에서 실행 (`stores_insert`, `subcontractors_all` 정책 삭제 + `subcontractors_select`만 재생성)
2. Edge Function 배포:
   ```
   npx supabase functions deploy admin-action
   ```
3. Supabase 대시보드 **Edge Functions > admin-action > Secrets** 에서 등록:
   - `ADMIN_PASSWORD` — 마스터 관리자 비밀번호 (12자 이상, 영문·숫자·특수문자 조합 권장)
4. 배포 후 관리자 화면 로그인/전체 매장 목록/전체 발송 이력/수급사 등록·수정이 모두 이 비밀번호로 서버에서 검증됨

## 4-2. 매장코드 셀프 생성 + 발송 이력 엑셀 다운로드 (업데이트)

- **매장코드 생성**: 첫 화면의 "매장코드가 없어요 · 새로 만들기"에서 매장 사용자가 직접 생성 (관리자 비밀번호 불필요). 코드를 비워두면 자동생성, 직접 입력 시 영문/숫자/하이픈 3~20자, 중복이면 거절.
- **관리자**: "전체 매장코드 목록"에서 모든 매장의 코드·담당자·이메일·생성일 확인 (코드를 잊은 매장 안내용).
- **엑셀 다운로드**: 관리자 > 전체 발송 이력 > "엑셀 다운로드 (.xlsx)" — 제출일시, 매장, 수급사, 수행 내용, 발송상태/실패사유 전체 포함.

배포 순서 (순서 중요):
1. `admin-action` Edge Function을 최신 `admin-action.ts`로 재배포 (`npx supabase functions deploy admin-action` 또는 대시보드에서 코드 교체)
2. `index.html` 을 GitHub에 업로드
3. `schema (2).sql` 맨 아래 "[보안 패치 3]" 블록을 SQL Editor에서 실행 → 매장 목록(=모든 매장코드)을 관리자만 볼 수 있게 됨

## 4-3. 마스터/일반 관리자 · 수정 기능 · 모바일 앱 설치 (업데이트)

- **관리자 로그인**: 아이디 + 비밀번호
  - 마스터 관리자: 아이디 `master` (Secrets에 `ADMIN_ID`를 등록하면 그 값으로 변경), 비밀번호는 기존 `ADMIN_PASSWORD`
  - 일반 관리자: 마스터가 관리자 메뉴 > **관리자 계정 관리**에서 생성/삭제
- **권한**
  - 마스터: 매장코드·매장 정보 수정, 수급사 추가/수정, 발송 이력 수정, 관리자 계정 관리 + 모든 조회
  - 일반 관리자: 조회·엑셀 다운로드 + 소속 브랜드 매장 수정·일괄 생성, 수급사 추가·수정 (4-4 참고)
- **발송 이력 수정**: 수급사·수행일자·장소·작업·요청사항·발송상태(발송완료/발송실패) 정정. 이미 발송된 메일과 PDF는 바뀌지 않음
- **사진 첨부**: "사진 촬영" / "앨범에서 선택" 버튼 분리
- **모바일 앱(PWA)**: 첫 화면의 "앱으로 설치하기" 안내에 따라 홈 화면에 추가하면 앱처럼 실행

배포 순서:
1. `schema (2).sql` 맨 아래 "[추가 4]" 블록(admins 테이블)을 SQL Editor에서 실행
2. `admin-action` Edge Function을 최신 코드로 재배포
3. GitHub에 `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` 폴더 반영

## 4-4. 일반 관리자 소속 브랜드 (업데이트)

- 마스터가 일반 관리자를 만들 때 **소속 브랜드**를 반드시 선택. 이후 목록에서 브랜드 변경 가능
- 일반 관리자는 소속 브랜드의 **매장 목록·발송 이력·엑셀·문서만** 조회 (서버에서도 차단)
- 일반 관리자도 **소속 브랜드 매장에 한해** 매장 정보·매장코드 수정, 엑셀 일괄 생성 가능. **수급사 추가·수정은 브랜드 무관하게 가능** (수급사는 전 브랜드 공용). 발송 이력 수정·관리자 계정 관리는 마스터 전용
- 관리자 아이디로 이메일 주소 형태도 사용 가능 (대소문자 구분)
- 브랜드가 지정되지 않은 기존 일반 관리자 계정은 아무것도 보이지 않음 → 마스터가 지정

배포 순서 (순서 중요):
1. `schema (2).sql` 맨 아래 "[추가 6]" 블록을 SQL Editor에서 실행
2. `admin-action` Edge Function을 최신 코드로 재배포
3. GitHub에 `index.html`, `guide.html` 반영

## 5. 보안 구조 및 운영 수칙 (전사 배포 전 필수)

### 구조
- **브라우저 → DB/Storage 직접 접근 없음**: anon key(공개 키)로는 어떤 테이블·파일도 조회/저장 불가 (RLS·Storage 정책 전면 차단)
- **매장**: 매 요청마다 서버(admin-action)가 매장코드를 검증. 자기 매장 이력·문서만 조회 가능
- **파일 업로드**: 서버가 해당 매장 폴더용 1회용 업로드 주소를 발급. 파일은 PDF/JPEG, 10MB 이하만 허용
- **문서 열람**: 서버가 권한 확인 후 60초짜리 임시 주소 발급
- **무차별 대입 방지**: 매장코드·관리자 로그인 실패가 IP당 15분 10회를 넘으면 15분 차단
- **호출 허용 사이트 제한(CORS)**: `https://gabeenya.github.io`만 허용 (다른 주소로 서비스하면 Secrets `ALLOWED_ORIGINS`에 추가)
- **화면 보안**: 외부 스크립트 버전 고정 + 위변조 검증(SRI), 콘텐츠 보안 정책(CSP), 30분 미사용 시 자동 로그아웃
- **사칭 방지**: 매장 담당자 이메일(=수급사 회신 주소)은 회사 도메인만 허용 (기본 `eland.co.kr`, 다른 회사 도메인도 쓰면 Secrets `ALLOWED_EMAIL_DOMAINS`에 쉼표로 추가). 첨부 파일은 서버가 실제 PDF/JPEG인지 확인한 뒤에만 저장·발송
- **개인정보 최소화**: 사진은 업로드 전 다시 저장해 촬영 위치(GPS) 등 메타데이터 제거

### 배포 순서 (보안 패치 5)
1. Supabase Secrets의 `ADMIN_PASSWORD`를 새 강력한 비밀번호로 변경 (이전 비밀번호는 공개 저장소 기록에 남아 있음)
2. SQL Editor에서 "[보안 패치 5-A]" 블록 실행
3. `admin-action`, `send-defect-email` 재배포
4. `index.html` 반영 (GitHub 푸시)
5. SQL Editor에서 "[보안 패치 5-B]" 블록 실행

### 운영 수칙
- GitHub·Supabase·발신 메일(네이버) 계정 모두 2단계 인증 사용, 접근 권한자 최소화
- 저장소는 공개 상태이므로 비밀번호·키 등 비밀값은 절대 코드/README에 쓰지 말고 Supabase Secrets에만 등록
- 매장코드는 매장 접속 비밀번호 역할 — 외부 공유 금지, 유출 의심 시 마스터가 관리자 화면에서 코드 변경
- 퇴사·이동한 관리자 계정은 즉시 삭제, 매장 담당자 변경 시 매장 정보 수정
- 개인정보(담당자명·이메일, 현장대리인 정보, 사진)의 보관 기간과 파기 절차는 사내 개인정보 담당 부서와 협의해 정할 것

## 참고
- 사진은 최대 5장, 문서(.pdf) 내부에 자동 삽입됨 (화면에 보이는 양식 그대로 캡처해 PDF로 변환하는 방식 — 한글 폰트 문제 없음)
- 관리자 화면 **전체 발송 이력**에서 모든 매장의 제출 건과 문서를 조회/다운로드 가능
- 보안 패치 5 이후 브라우저(anon key)는 DB·Storage에 직접 접근할 수 없음. 모든 데이터 접근은 Edge Function이 매장코드/관리자 계정을 검증한 뒤 수행 (아래 5번 참고)
