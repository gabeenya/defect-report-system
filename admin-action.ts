// Supabase Edge Function: admin-action
// 역할: 매장코드 생성/조회와 관리자 기능을 service role 권한으로 수행한다.
//       (anon key로는 stores/admins 테이블 조회·쓰기, subcontractors 쓰기 불가 — RLS로 차단됨)
//
// 보안 원칙: 브라우저(anon key)는 DB·Storage에 직접 접근하지 못함 (RLS/Storage 정책 전면 차단).
//            모든 조회·저장은 이 함수가 매장코드 또는 관리자 계정을 검증한 뒤 service role로 수행.
//
//   - 공개 action (로그인 불필요):
//       register_store : 매장 사용자가 직접 매장코드 생성
//   - 매장 action (매장코드 검증, payload.store_code):
//       lookup_store   : 매장코드로 접속 (매장 정보 + 수급사 목록 반환)
//       store_history  : 이 매장의 발송 이력
//       store_upload_urls : 요청서·사진 업로드용 1회용 서명 URL 발급 (이 매장 폴더로만)
//       store_submit   : 발송 이력 저장 (업로드 경로가 이 매장 폴더인지 검증)
//       store_doc_url  : 이 매장 요청서 PDF 열람용 60초 서명 URL
//   - 관리자 action (마스터 + 일반 관리자, 조회 전용):
//       verify, list_stores, list_submissions, list_subcontractors, admin_doc_url
//   - 마스터 전용 action (수정 권한):
//       update_store, bulk_create_stores(엑셀 일괄 생성), save_subcontractor, update_submission,
//       list_admins, create_admin, delete_admin
//
// 로그인:
//   마스터 관리자 = 아이디 ADMIN_ID(기본값 "master") + 비밀번호 ADMIN_PASSWORD
//   일반 관리자   = admins 테이블 계정 (마스터가 생성, 비밀번호는 PBKDF2 해시로 저장)
//
// 필요 환경변수 (Supabase 대시보드 > Edge Functions > Secrets 에서 등록):
//   ADMIN_PASSWORD   - 마스터 관리자 비밀번호 (index.html에는 존재하지 않음)
//   ADMIN_ID         - (선택) 마스터 관리자 아이디. 비워두면 "master"
//   ALLOWED_ORIGINS  - (선택) 호출을 허용할 사이트 주소(쉼표 구분). 비워두면 https://gabeenya.github.io
//   ALLOWED_EMAIL_DOMAINS - (선택) 매장 담당자 이메일로 허용할 회사 도메인(쉼표 구분). 비워두면 eland.co.kr
//                    → 외부인이 매장코드를 만들어 회사 이름으로 메일을 보내고 회신을 가로채는 것 방지
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - Supabase가 자동 주입
//
// 무차별 대입 방지: 매장코드/관리자 로그인 실패가 IP당 15분에 10회를 넘으면 15분간 차단 (auth_failures 테이블)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_PASSWORD = (Deno.env.get("ADMIN_PASSWORD") ?? "").trim();
const ADMIN_ID = (Deno.env.get("ADMIN_ID") ?? "").trim() || "master";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// index.html의 BRANDS와 동일하게 유지
const BRANDS = ["애슐리퀸즈","델리바이애슐리","리미니","자연별곡","피자몰","로운","프랑제리","프랜차이즈","카페"];
const STORE_CODE_RE = /^[A-Z0-9-]{5,20}$/;
const STORE_CODE_RULE = "매장코드는 영문, 숫자, 하이픈(-) 조합 5~20자로 입력해 주십시오.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_EMAIL_DOMAINS = ((Deno.env.get("ALLOWED_EMAIL_DOMAINS") ?? "").trim() || "eland.co.kr")
  .split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
function isCompanyEmail(email: string) {
  const domain = email.split("@").pop()!.toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}
const COMPANY_EMAIL_RULE = `매장 담당자 이메일은 회사 이메일(${ALLOWED_EMAIL_DOMAINS.map((d) => "@" + d).join(", ")})만 사용할 수 있습니다.`;

// 업로드 파일이 실제 PDF/JPEG인지 파일 앞부분(시그니처)으로 확인 — 다른 종류 파일을 위장해 올리는 것 차단
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
async function hasMagic(path: string, magic: number[]) {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
  if (error || !data) return false;
  const head = new Uint8Array(await data.slice(0, magic.length).arrayBuffer());
  return magic.every((b, i) => head[i] === b);
}
const LOGIN_ID_RE = /^[a-zA-Z0-9._-]{3,30}$/;
const EDITABLE_STATUS = ["sent", "failed"]; // 'pending'으로 되돌리면 재발송 대상이 되므로 제외
const BUCKET = "defect-reports";
const MAX_PHOTOS = 5;

// CORS: 허용한 사이트에서만 브라우저 호출 허용 (Access-Control-Allow-Origin은 요청마다 붙임)
const ALLOWED_ORIGINS = ((Deno.env.get("ALLOWED_ORIGINS") ?? "").trim() || "https://gabeenya.github.io")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const corsHeaders = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Vary": "Origin",
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function text(body: string, status: number) {
  return new Response(body, { status, headers: corsHeaders });
}

/* ---------------- 무차별 대입(brute force) 방지 ---------------- */
const FAIL_WINDOW_MIN = 15;
const FAIL_LIMIT = 10;

function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}
async function isLocked(key: string) {
  const since = new Date(Date.now() - FAIL_WINDOW_MIN * 60_000).toISOString();
  const { count } = await supabaseAdmin
    .from("auth_failures").select("id", { count: "exact", head: true })
    .eq("key", key).gte("created_at", since);
  return (count ?? 0) >= FAIL_LIMIT;
}
async function recordFailure(key: string) {
  await supabaseAdmin.from("auth_failures").insert({ key });
  // 오래된 기록 정리 (하루 지난 것)
  await supabaseAdmin.from("auth_failures").delete()
    .lt("created_at", new Date(Date.now() - 86_400_000).toISOString());
}
const LOCKED_MSG = `로그인 시도가 너무 많습니다. ${FAIL_WINDOW_MIN}분 후 다시 시도해 주십시오.`;
// deno-lint-ignore no-explicit-any
function str(v: any) {
  return String(v ?? "").trim();
}

/* ---------------- 비밀번호 해시 (PBKDF2-SHA256) ---------------- */
const PBKDF2_ITERATIONS = 100_000;

function toHex(buf: ArrayBuffer | Uint8Array) {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password: string, saltHex: string) {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256,
  );
  return toHex(bits);
}
function newSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}
// 길이 노출 없는 비교
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Admin = { role: "master" | "admin"; login_id: string; name: string };

async function authenticate(loginId: string, password: string): Promise<Admin | null> {
  if (!loginId || !password) return null;
  if (loginId === ADMIN_ID) {
    return ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD)
      ? { role: "master", login_id: ADMIN_ID, name: "마스터 관리자" }
      : null;
  }
  const { data } = await supabaseAdmin
    .from("admins")
    .select("login_id, name, password_hash, password_salt")
    .eq("login_id", loginId)
    .maybeSingle();
  if (!data) return null;
  const hash = await hashPassword(password, data.password_salt);
  return safeEqual(hash, data.password_hash)
    ? { role: "admin", login_id: data.login_id, name: data.name }
    : null;
}

/* ---------------- 매장 ---------------- */
// 자동생성 코드는 영문 약어 + 무작위 6자리 (추측 방지. 헷갈리는 0/O, 1/I 제외)
const BRAND_PREFIX: Record<string, string> = {
  "애슐리퀸즈": "AQ", "델리바이애슐리": "DA", "리미니": "RM", "자연별곡": "JB", "피자몰": "PM",
  "로운": "RW", "프랑제리": "FR", "프랜차이즈": "FC", "카페": "CF",
};
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genStoreCode(brand: string) {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return (BRAND_PREFIX[brand] || "EL") + "-" + Array.from(rand, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

// 매장코드를 대소문자 구분 없이 조회 (먼저 만든 매장 순).
// LIKE 와일드카드(% _ \, PostgREST의 *)가 들어간 코드는 패턴으로 해석되지 않도록 정확히 일치만 검색
// deno-lint-ignore no-explicit-any
async function findStoresByCode(code: string, columns: string): Promise<any[]> {
  const base = supabaseAdmin.from("stores").select(columns).order("created_at", { ascending: true }).limit(5);
  const { data, error } = /[%_*\\]/.test(code)
    ? await base.eq("store_code", code)
    : await base.ilike("store_code", code);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// 대소문자만 다른 코드도 중복으로 취급 (excludeId: 수정 중인 매장 자신은 제외)
async function isStoreCodeTaken(code: string, excludeId?: string) {
  const rows = await findStoresByCode(code, "id");
  return rows.some((r) => r.id !== excludeId);
}

// 매장 정보 입력값 검증 (생성/수정 공통). 오류 메시지 또는 null 반환
// deno-lint-ignore no-explicit-any
function validateStoreFields(f: any) {
  if (!BRANDS.includes(f.brand)) return "브랜드를 목록에서 선택해 주십시오.";
  if (!f.store_name || !f.manager_name || !f.manager_email) return "필수 항목을 모두 입력해 주십시오.";
  if (f.store_name.length > 100 || f.manager_name.length > 50) return "입력값이 너무 깁니다.";
  if (!EMAIL_RE.test(f.manager_email)) return "이메일 형식이 올바르지 않습니다.";
  if (!isCompanyEmail(f.manager_email)) return COMPANY_EMAIL_RULE;
  return null;
}

// deno-lint-ignore no-explicit-any
async function registerStore(payload: any) {
  const fields = {
    brand: str(payload?.brand),
    store_name: str(payload?.store_name),
    manager_name: str(payload?.manager_name),
    manager_email: str(payload?.manager_email),
  };
  const customCode = str(payload?.store_code).toUpperCase();

  const invalid = validateStoreFields(fields);
  if (invalid) return text(invalid, 400);
  if (customCode && !STORE_CODE_RE.test(customCode)) {
    return text(STORE_CODE_RULE, 400);
  }
  if (customCode && await isStoreCodeTaken(customCode)) {
    return text("이미 사용 중인 매장코드입니다. 다른 코드를 입력해 주십시오.", 409);
  }

  // 직접 지정한 코드는 1회만 시도, 자동생성은 중복 시 몇 번 재시도
  const attempts = customCode ? 1 : 5;
  for (let i = 0; i < attempts; i++) {
    const store_code = customCode || genStoreCode(fields.brand);
    const { data, error } = await supabaseAdmin
      .from("stores")
      .insert({ store_code, ...fields })
      .select("id, store_code, store_name, brand, manager_name")
      .single();
    if (!error) return json({ ok: true, store: data });
    if (error.code !== "23505") throw new Error(error.message); // 23505 = unique 위반
    if (customCode) return text("이미 사용 중인 매장코드입니다. 다른 코드를 입력해 주십시오.", 409);
  }
  return text("매장코드 자동 발급에 실패했습니다. 다시 시도해 주십시오.", 500);
}

// deno-lint-ignore no-explicit-any
async function updateStore(payload: any) {
  const id = str(payload?.id);
  if (!id) return text("수정할 매장이 지정되지 않았습니다.", 400);
  const fields = {
    brand: str(payload?.brand),
    store_name: str(payload?.store_name),
    manager_name: str(payload?.manager_name),
    manager_email: str(payload?.manager_email),
    store_code: str(payload?.store_code).toUpperCase(),
  };
  const invalid = validateStoreFields(fields);
  if (invalid) return text(invalid, 400);

  const { data: current } = await supabaseAdmin.from("stores").select("store_code").eq("id", id).maybeSingle();
  if (!current) return text("존재하지 않는 매장입니다.", 404);
  // 예전에 발급된 코드(한글 포함 등)는 그대로 두는 경우 허용, 바꿀 때만 형식 검사
  if (fields.store_code !== current.store_code.toUpperCase() && !STORE_CODE_RE.test(fields.store_code)) {
    return text(STORE_CODE_RULE, 400);
  }
  if (fields.store_code === current.store_code.toUpperCase()) fields.store_code = current.store_code;
  if (await isStoreCodeTaken(fields.store_code, id)) {
    return text("이미 사용 중인 매장코드입니다. 다른 코드를 입력해 주십시오.", 409);
  }

  const { error } = await supabaseAdmin.from("stores").update(fields).eq("id", id);
  if (error?.code === "23505") return text("이미 사용 중인 매장코드입니다. 다른 코드를 입력해 주십시오.", 409);
  if (error) throw new Error(error.message);
  return json({ ok: true });
}

// 엑셀 일괄 생성: 모든 행을 먼저 검증하고, 하나라도 오류가 있으면 아무것도 만들지 않음 (행별 오류 반환)
const BULK_MAX_ROWS = 300;
// deno-lint-ignore no-explicit-any
async function bulkCreateStores(payload: any) {
  const input = Array.isArray(payload?.stores) ? payload.stores : [];
  if (!input.length) return text("등록할 매장이 없습니다.", 400);
  if (input.length > BULK_MAX_ROWS) return text(`한 번에 최대 ${BULK_MAX_ROWS}개 매장까지 등록할 수 있습니다.`, 400);

  // 기존 코드는 대소문자 구분 없이 중복 검사 (한 번에 최대 1000건씩 조회되므로 나눠서 전부 가져옴)
  const taken = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("stores").select("store_code")
      .order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    (data ?? []).forEach((r) => taken.add(String(r.store_code).toUpperCase()));
    if (!data || data.length < 1000) break;
  }

  const errors: { row: number; message: string }[] = [];
  const fileCodes = new Map<string, number>(); // 파일 안 중복 검사용 (코드 → 행 번호)
  // deno-lint-ignore no-explicit-any
  const rows = input.map((r: any, i: number) => {
    const row = parseInt(r?.row) || i + 2;
    const fields = {
      brand: str(r?.brand),
      store_name: str(r?.store_name),
      manager_name: str(r?.manager_name),
      manager_email: str(r?.manager_email),
    };
    const code = str(r?.store_code).toUpperCase();
    const invalid = validateStoreFields(fields) ||
      (code && !STORE_CODE_RE.test(code) ? STORE_CODE_RULE : null) ||
      (code && taken.has(code) ? `이미 사용 중인 매장코드입니다. (${code})` : null) ||
      (code && fileCodes.has(code) ? `파일 안에서 매장코드가 중복됩니다. (${fileCodes.get(code)}행과 같음)` : null);
    if (invalid) errors.push({ row, message: invalid });
    if (code && !fileCodes.has(code)) fileCodes.set(code, row);
    return { code, fields };
  });
  if (errors.length) return json({ ok: false, errors });

  // 자동생성 코드는 기존 코드·파일 내 코드와 겹치지 않게 발급
  const used = new Set([...taken, ...fileCodes.keys()]);
  const records = rows.map(({ code, fields }: { code: string; fields: Record<string, string> }) => {
    let store_code = code;
    if (!store_code) {
      do store_code = genStoreCode(fields.brand); while (used.has(store_code));
      used.add(store_code);
    }
    return { store_code, ...fields };
  });

  // 한 번의 insert = 전부 성공 또는 전부 실패
  const { data, error } = await supabaseAdmin
    .from("stores")
    .insert(records)
    .select("store_code, store_name, brand, manager_name, manager_email");
  if (error?.code === "23505") return text("그사이 같은 매장코드가 등록되었습니다. 다시 업로드해 주십시오.", 409);
  if (error) throw new Error(error.message);
  return json({ ok: true, stores: data });
}

/* ---------------- 수급사 ---------------- */
// deno-lint-ignore no-explicit-any
async function saveSubcontractor(payload: any) {
  const id = str(payload?.id);
  const fields = {
    company_name: str(payload?.company_name),
    site_manager_name: str(payload?.site_manager_name),
    email: str(payload?.email),
    updated_at: new Date().toISOString(),
  };
  if (!fields.company_name || !fields.site_manager_name || !fields.email) {
    return text("필수 항목을 모두 입력해 주십시오.", 400);
  }
  if (!EMAIL_RE.test(fields.email)) return text("이메일 형식이 올바르지 않습니다.", 400);
  const { error } = id
    ? await supabaseAdmin.from("subcontractors").update(fields).eq("id", id)
    : await supabaseAdmin.from("subcontractors").insert(fields);
  if (error) throw new Error(error.message);
  return json({ ok: true });
}

/* ---------------- 발송 이력 ---------------- */
// deno-lint-ignore no-explicit-any
async function updateSubmission(payload: any) {
  const id = str(payload?.id);
  if (!id) return text("수정할 발송 이력이 지정되지 않았습니다.", 400);
  const fields = {
    subcontractor_id: str(payload?.subcontractor_id),
    work_date: str(payload?.work_date),
    work_location: str(payload?.work_location),
    work_type: str(payload?.work_type),
    defect_description: str(payload?.defect_description),
    email_status: str(payload?.email_status),
  };
  if (Object.values(fields).some((v) => !v)) return text("필수 항목을 모두 입력해 주십시오.", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.work_date)) return text("수행일자 형식이 올바르지 않습니다.", 400);
  if (!EDITABLE_STATUS.includes(fields.email_status)) return text("발송상태 값이 올바르지 않습니다.", 400);

  const { data: current } = await supabaseAdmin.from("submissions").select("email_status").eq("id", id).maybeSingle();
  if (!current) return text("존재하지 않는 발송 이력입니다.", 404);
  if (current.email_status === "sending") return text("메일 발송 중인 건은 수정할 수 없습니다.", 409);

  const update: Record<string, unknown> = { ...fields };
  if (fields.email_status === "sent") update.email_error = null; // 발송완료로 정정하면 실패사유 제거
  const { error } = await supabaseAdmin.from("submissions").update(update).eq("id", id);
  if (error) throw new Error(error.message);
  return json({ ok: true });
}

/* ---------------- 관리자 계정 ---------------- */
async function listAdmins() {
  const { data, error } = await supabaseAdmin
    .from("admins")
    .select("id, login_id, name, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return json({ ok: true, admins: data });
}

// deno-lint-ignore no-explicit-any
async function createAdmin(payload: any) {
  const login_id = str(payload?.login_id);
  const name = str(payload?.name);
  const password = String(payload?.password ?? "");
  if (!login_id || !name || !password) return text("필수 항목을 모두 입력해 주십시오.", 400);
  if (!LOGIN_ID_RE.test(login_id)) return text("아이디는 영문, 숫자, 마침표(.), 밑줄(_), 하이픈(-) 조합 3~30자로 입력해 주십시오.", 400);
  if (login_id === ADMIN_ID) return text("사용할 수 없는 아이디입니다.", 400);
  if (name.length > 50) return text("이름이 너무 깁니다.", 400);
  if (password.length < 8) return text("비밀번호는 8자 이상으로 입력해 주십시오.", 400);

  const password_salt = newSalt();
  const password_hash = await hashPassword(password, password_salt);
  const { error } = await supabaseAdmin.from("admins").insert({ login_id, name, password_hash, password_salt });
  if (error?.code === "23505") return text("이미 사용 중인 아이디입니다.", 409);
  if (error) throw new Error(error.message);
  return json({ ok: true });
}

// deno-lint-ignore no-explicit-any
async function deleteAdmin(payload: any) {
  const id = str(payload?.id);
  if (!id) return text("삭제할 계정이 지정되지 않았습니다.", 400);
  const { error } = await supabaseAdmin.from("admins").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return json({ ok: true });
}

/* ---------------- 매장 (매장코드로 인증) ---------------- */
type Store = { id: string; store_code: string; store_name: string; brand: string; manager_name: string };

async function authenticateStore(code: string): Promise<Store | null> {
  if (!code) return null;
  const rows = await findStoresByCode(code, "id, store_code, store_name, brand, manager_name");
  // 대소문자만 다른 예전 코드가 여러 개면: 정확히 일치 > 대문자 일치 > 먼저 만든 매장 순
  return rows.find((r) => r.store_code === code)
    || rows.find((r) => r.store_code === code.toUpperCase())
    || rows[0]
    || null;
}

async function listSubcontractors() {
  const { data, error } = await supabaseAdmin
    .from("subcontractors")
    .select("id, company_name, site_manager_name, email")
    .order("company_name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function storeHistory(store: Store) {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select("id, work_date, work_type, email_status, document_url, created_at, subcontractors(company_name)")
    .eq("store_id", store.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  // 저장 경로는 내려보내지 않고 문서 유무만 전달
  const history = (data ?? []).map(({ document_url, ...r }) => ({ ...r, has_document: !!document_url }));
  return json({ ok: true, history });
}

// 업로드 경로: <매장 id>/<타임스탬프>_report.pdf, <매장 id>/<타임스탬프>_photo1~5.jpg
// deno-lint-ignore no-explicit-any
async function storeUploadUrls(store: Store, payload: any) {
  const photoCount = Math.min(Math.max(parseInt(payload?.photo_count) || 0, 0), MAX_PHOTOS);
  const stamp = Date.now();
  const paths = [`${store.id}/${stamp}_report.pdf`];
  for (let i = 1; i <= photoCount; i++) paths.push(`${store.id}/${stamp}_photo${i}.jpg`);
  const uploads = [];
  for (const path of paths) {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) throw new Error("업로드 준비 실패: " + error.message);
    uploads.push({ path: data.path, token: data.token });
  }
  return json({ ok: true, document: uploads[0], photos: uploads.slice(1) });
}

// deno-lint-ignore no-explicit-any
async function storeSubmit(store: Store, payload: any) {
  const fields = {
    subcontractor_id: str(payload?.subcontractor_id),
    work_date: str(payload?.work_date),
    work_type: str(payload?.work_type),
    defect_description: str(payload?.defect_description),
  };
  if (Object.values(fields).some((v) => !v)) return text("필수 항목을 모두 입력해 주십시오.", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.work_date)) return text("수행일자 형식이 올바르지 않습니다.", 400);
  if (fields.work_type.length > 200 || fields.defect_description.length > 5000) return text("입력값이 너무 깁니다.", 400);

  // 업로드 경로는 반드시 이 매장 폴더의 정해진 형식이어야 함 (다른 매장/임의 파일 지정 차단)
  const docRe = /^([0-9a-f-]{36})\/(\d+)_report\.pdf$/;
  const photoRe = /^([0-9a-f-]{36})\/(\d+)_photo[1-5]\.jpg$/;
  const document_url = str(payload?.document_path);
  const photo_urls: string[] = Array.isArray(payload?.photo_paths) ? payload.photo_paths.map(str) : [];
  const doc = docRe.exec(document_url);
  const badPath = !doc || doc[1] !== store.id || photo_urls.length > MAX_PHOTOS ||
    !photo_urls.every((p) => {
      const m = photoRe.exec(p);
      return m && m[1] === store.id && m[2] === doc[2];
    });
  if (badPath) return text("첨부 파일 경로가 올바르지 않습니다.", 400);

  // 문서가 실제로 업로드되었는지 확인
  const [folder, fileName] = document_url.split("/");
  const { data: files } = await supabaseAdmin.storage.from(BUCKET).list(folder, { search: fileName });
  if (!files?.some((f) => f.name === fileName)) {
    return text("요청서 파일이 업로드되지 않았습니다. 다시 시도해 주십시오.", 400);
  }
  // 실제 파일 형식 확인: 위장 파일이면 저장소에서 지우고 거부
  const badFiles: string[] = [];
  if (!(await hasMagic(document_url, PDF_MAGIC))) badFiles.push(document_url);
  for (const p of photo_urls) if (!(await hasMagic(p, JPEG_MAGIC))) badFiles.push(p);
  if (badFiles.length) {
    await supabaseAdmin.storage.from(BUCKET).remove([document_url, ...photo_urls]);
    return text("첨부 파일 형식이 올바르지 않습니다. 다시 작성해 주십시오.", 400);
  }

  const { data: sub } = await supabaseAdmin.from("subcontractors").select("id").eq("id", fields.subcontractor_id).maybeSingle();
  if (!sub) return text("수급사를 다시 선택해 주십시오.", 400);

  const { data, error } = await supabaseAdmin.from("submissions").insert({
    ...fields,
    store_id: store.id,
    work_location: `${store.brand} (${store.store_name})`, // 수행장소는 서버가 매장 정보로 기재
    photo_urls,
    document_url,
    email_status: "pending",
  }).select("id").single();
  if (error) throw new Error(error.message);
  return json({ ok: true, submission_id: data.id });
}

async function signedDocUrl(submissionId: string, storeId?: string) {
  if (!/^[0-9a-f-]{36}$/.test(submissionId)) return text("문서를 찾을 수 없습니다.", 404);
  let q = supabaseAdmin.from("submissions").select("document_url").eq("id", submissionId);
  if (storeId) q = q.eq("store_id", storeId); // 매장은 자기 매장 문서만
  const { data } = await q.maybeSingle();
  if (!data?.document_url) return text("문서를 찾을 수 없습니다.", 404);
  const { data: signed, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(data.document_url, 60);
  if (error) throw new Error(error.message);
  return json({ ok: true, url: signed.signedUrl });
}

/* ---------------- 요청 처리 ---------------- */
async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return text("Method not allowed", 405);

  const { action, login_id, password, payload } = await req.json();
  const ip = clientIp(req);

  // ---------- 공개 action ----------
  if (action === "register_store") {
    // 매장코드 대량 생성 방지: IP당 15분에 10건까지
    const regKey = "register:" + ip;
    if (await isLocked(regKey)) return text("매장코드 발급 요청이 너무 많습니다. 잠시 후 다시 시도해 주십시오.", 429);
    const res = await registerStore(payload);
    if (res.ok) await recordFailure(regKey);
    return res;
  }

  // ---------- 매장 action (매장코드 검증) ----------
  if (typeof action === "string" && (action === "lookup_store" || action.startsWith("store_"))) {
    const lockKey = "store:" + ip;
    if (await isLocked(lockKey)) return text(LOCKED_MSG, 429);
    const code = str(payload?.store_code);
    if (!code) return text("매장코드를 입력해 주십시오.", 400);
    const store = await authenticateStore(code);
    if (!store) {
      await recordFailure(lockKey);
      return text("존재하지 않는 매장코드입니다.", 404);
    }
    if (action === "lookup_store") return json({ ok: true, store, subcontractors: await listSubcontractors() });
    if (action === "store_history") return await storeHistory(store);
    if (action === "store_upload_urls") return await storeUploadUrls(store, payload);
    if (action === "store_submit") return await storeSubmit(store, payload);
    if (action === "store_doc_url") return await signedDocUrl(str(payload?.submission_id), store.id);
    return text("알 수 없는 요청입니다.", 400);
  }

  // ---------- 관리자 action (로그인 필요) ----------
  const lockKey = "admin:" + ip;
  if (await isLocked(lockKey)) return text(LOCKED_MSG, 429);
  const admin = await authenticate(str(login_id), String(password ?? ""));
  if (!admin) {
    await recordFailure(lockKey);
    return text("아이디 또는 비밀번호가 올바르지 않습니다.", 401);
  }

  if (action === "verify") {
    return json({ ok: true, admin });
  }

  if (action === "list_stores") {
    const { data, error } = await supabaseAdmin
      .from("stores")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ ok: true, stores: data });
  }

  if (action === "list_submissions") {
    const { data, error } = await supabaseAdmin
      .from("submissions")
      .select("*, stores(store_code, store_name, brand, manager_name, manager_email), subcontractors(company_name, site_manager_name, email)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return json({ ok: true, submissions: data });
  }

  if (action === "list_subcontractors") {
    return json({ ok: true, subcontractors: await listSubcontractors() });
  }

  if (action === "admin_doc_url") {
    return await signedDocUrl(str(payload?.submission_id));
  }

  // ---------- 마스터 전용 action ----------
  const MASTER_ACTIONS: Record<string, (p: unknown) => Promise<Response>> = {
    update_store: updateStore,
    bulk_create_stores: bulkCreateStores,
    save_subcontractor: saveSubcontractor,
    update_submission: updateSubmission,
    list_admins: listAdmins,
    create_admin: createAdmin,
    delete_admin: deleteAdmin,
  };
  if (action in MASTER_ACTIONS) {
    if (admin.role !== "master") return text("마스터 관리자만 수정할 수 있습니다.", 403);
    return await MASTER_ACTIONS[action](payload);
  }

  return text("알 수 없는 요청입니다.", 400);
}

Deno.serve(async (req) => {
  const origin = (req.headers.get("origin") ?? "").replace(/\/$/, "");
  const allowed = ALLOWED_ORIGINS.includes(origin);

  let res: Response;
  if (req.method === "OPTIONS") {
    res = new Response(null, { status: allowed ? 204 : 403, headers: corsHeaders });
  } else {
    try {
      res = await handle(req);
    } catch (err) {
      console.error(err); // 상세 원인은 Supabase 로그에만 남기고 화면에는 일반 메시지
      res = text("요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주십시오.", 500);
    }
  }
  if (allowed) res.headers.set("Access-Control-Allow-Origin", origin);
  return res;
});
