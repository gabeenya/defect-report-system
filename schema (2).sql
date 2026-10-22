-- ============================================================
-- 결과물 하자 개선 요청서 자동 발송 시스템 - DB 스키마
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- ============================================================

-- 1. 매장 테이블 (매장코드로 접속)
create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  store_code text unique not null,        -- 매장 접속 코드 (예: SF-0921)
  store_name text not null,               -- 매장명 (예: 스타필드시티 부천점)
  brand text not null,                    -- 브랜드 (고정 목록 중 선택)
  manager_name text not null,             -- 매장 담당자명
  manager_email text not null,            -- 매장 담당자 이메일 (Reply-To로 사용)
  created_at timestamptz not null default now()
);

-- 2. 수급사(협력업체) 테이블
create table if not exists subcontractors (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,             -- 수급인 회사명
  site_manager_name text not null,        -- 현장대리인명
  email text not null,                    -- 수급사 수신 이메일
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. 발송 이력(하자개선요청서 제출 기록) 테이블
create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  subcontractor_id uuid not null references subcontractors(id),
  work_date date not null,                -- 수행일자
  work_location text not null,            -- 수행장소 (매장명 자동기재)
  work_type text not null,                -- 수행작업
  defect_description text not null,       -- 하자 개선 요청사항
  photo_urls text[] default '{}',         -- 첨부 사진 Storage 경로 (최대 5장)
  document_url text,                      -- 생성된 요청서(.docx) Storage 경로
  email_status text not null default 'pending', -- pending | sent | failed
  email_error text,                       -- 발송 실패 시 에러 메시지
  created_at timestamptz not null default now()
);

-- ============================================================
-- RLS 설정: 매장코드 로그인 방식 특성상 anon key로 접근하므로
-- 최소한의 정책만 허용 (내부망/사내 전용 도구 전제)
-- ============================================================
alter table stores enable row level security;
alter table subcontractors enable row level security;
alter table submissions enable row level security;

create policy "stores_select" on stores for select using (true);
create policy "stores_insert" on stores for insert with check (true);

create policy "subcontractors_all" on subcontractors for all using (true) with check (true);

create policy "submissions_select" on submissions for select using (true);
create policy "submissions_insert" on submissions for insert with check (true);
create policy "submissions_update" on submissions for update using (true);

-- ============================================================
-- Storage 버킷 (대시보드 > Storage 에서 생성해도 됨)
-- 버킷명: defect-reports (Private 권장 — Edge Function이 service role로 접근)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('defect-reports', 'defect-reports', false)
on conflict (id) do nothing;

create policy "defect-reports_insert" on storage.objects
  for insert with check (bucket_id = 'defect-reports');

create policy "defect-reports_select" on storage.objects
  for select using (bucket_id = 'defect-reports');

-- ============================================================
-- [보안 패치] anon key로 stores/subcontractors 직접 쓰기 차단
-- 매장코드 생성, 수급사 등록/수정은 이제 admin-action Edge Function
-- (service role, 비밀번호는 서버 환경변수로만 검증)을 통해서만 가능.
-- 이미 위 schema를 실행한 상태라면 이 블록만 SQL Editor에서 추가 실행.
-- ============================================================
drop policy if exists "stores_insert" on stores;
drop policy if exists "subcontractors_all" on subcontractors;

create policy "subcontractors_select" on subcontractors for select using (true);

-- ============================================================
-- [보안 패치 2] 메일 발송 상태는 send-defect-email Edge Function(service role)만 변경
-- anon key로 email_status를 'pending'으로 되돌려 재발송시키는 것 차단.
-- 이미 위 schema를 실행한 상태라면 이 블록만 SQL Editor에서 추가 실행.
-- ============================================================
drop policy if exists "submissions_update" on submissions;

-- ============================================================
-- [보안 패치 3] 매장코드 셀프 생성 + 매장 목록은 관리자만 조회
-- 매장 사용자가 직접 매장코드를 만들 수 있게 되면서, 매장코드가 곧 접속 비밀번호 역할.
-- anon key로 stores 전체를 select 하면 모든 매장코드가 노출되므로 차단하고,
-- 매장 접속(코드 1건 조회)·매장코드 생성은 admin-action Edge Function의
-- 공개 action(lookup_store / register_store)으로, 전체 목록은 관리자 action으로만 가능.
-- ※ 반드시 admin-action 최신 버전을 먼저 배포한 뒤 이 블록을 실행할 것
--   (먼저 실행하면 기존 화면에서 매장코드 접속이 안 됨)
-- ============================================================
drop policy if exists "stores_select" on stores;

-- ============================================================
-- [추가 4] 일반 관리자 계정 테이블
-- 마스터 관리자는 Edge Function Secrets(ADMIN_PASSWORD, 아이디 기본값 master)로 로그인.
-- 일반 관리자 계정은 마스터가 관리자 화면에서 생성/삭제하며, 조회만 가능 (수정 권한 없음).
-- 비밀번호는 PBKDF2 해시로만 저장. anon key로는 접근 불가 (정책 없음 = 전면 차단,
-- admin-action Edge Function이 service role로만 접근).
-- ============================================================
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  login_id text unique not null,
  name text not null,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now()
);
alter table admins enable row level security;

-- ============================================================
-- [보안 패치 5-A] 로그인 실패 기록 테이블 (무차별 대입 방지용) — 언제 실행해도 안전
-- admin-action이 매장코드/관리자 로그인 실패를 IP별로 기록하고, 15분 10회 초과 시 차단.
-- ============================================================
create table if not exists auth_failures (
  id bigserial primary key,
  key text not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_failures_key_time on auth_failures (key, created_at);
alter table auth_failures enable row level security;

-- ============================================================
-- [보안 패치 5-B] 브라우저(anon key)의 DB·Storage 직접 접근 전면 차단
-- 이후 모든 조회·저장·파일 업로드/다운로드는 admin-action Edge Function이
-- 매장코드 또는 관리자 계정을 검증한 뒤에만 수행 (service role).
-- ※ 반드시 admin-action·send-defect-email 재배포 + 새 index.html 반영 후 실행할 것
--   (먼저 실행하면 기존 화면에서 하자 제출/이력 조회가 안 됨)
-- ============================================================
drop policy if exists "stores_select" on stores;
drop policy if exists "stores_insert" on stores;
drop policy if exists "subcontractors_select" on subcontractors;
drop policy if exists "subcontractors_all" on subcontractors;
drop policy if exists "submissions_select" on submissions;
drop policy if exists "submissions_insert" on submissions;
drop policy if exists "submissions_update" on submissions;
drop policy if exists "defect-reports_insert" on storage.objects;
drop policy if exists "defect-reports_select" on storage.objects;

alter table stores enable row level security;
alter table subcontractors enable row level security;
alter table submissions enable row level security;
alter table admins enable row level security;

-- 버킷: 비공개 유지 + 파일 크기 10MB 제한 + PDF/JPEG만 허용
update storage.buckets
   set public = false,
       file_size_limit = 10485760,
       allowed_mime_types = array['application/pdf', 'image/jpeg']
 where id = 'defect-reports';

-- 확인용: 아래 조회 결과에 public 스키마 정책이 하나도 없고, storage에도 defect-reports 관련 정책이 없어야 정상
-- select schemaname, tablename, policyname from pg_policies where schemaname in ('public', 'storage');

-- ============================================================
-- [추가 6] 일반 관리자 소속 브랜드
-- 일반 관리자는 소속 브랜드의 매장 목록·발송 이력·문서만 조회 가능.
-- 브랜드가 비어 있는 기존 계정은 아무것도 보이지 않으므로, 마스터가 관리자 계정 관리 화면에서 지정할 것.
-- ※ admin-action 재배포 전에 먼저 실행할 것 (새 코드가 이 컬럼을 조회함)
-- ============================================================
alter table admins add column if not exists brand text;
