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
