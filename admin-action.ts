// Supabase Edge Function: admin-action
// 역할: 매장코드 생성/조회와 관리자 기능을 service role 권한으로 수행한다.
//       (anon key로는 stores/admins 테이블 조회·쓰기, subcontractors 쓰기 불가 — RLS로 차단됨)
//
//   - 공개 action (로그인 불필요):
//       register_store : 매장 사용자가 직접 매장코드 생성
//       lookup_store   : 매장코드로 접속 (코드가 정확히 일치하는 매장 1건만 반환)
//   - 관리자 action (마스터 + 일반 관리자, 조회 전용):
//       verify, list_stores, list_submissions
//   - 마스터 전용 action (수정 권한):
//       update_store, save_subcontractor, update_submission,
//       list_admins, create_admin, delete_admin
//
// 로그인:
//   마스터 관리자 = 아이디 ADMIN_ID(기본값 "master") + 비밀번호 ADMIN_PASSWORD
//   일반 관리자   = admins 테이블 계정 (마스터가 생성, 비밀번호는 PBKDF2 해시로 저장)
//
// 필요 환경변수 (Supabase 대시보드 > Edge Functions > Secrets 에서 등록):
//   ADMIN_PASSWORD   - 마스터 관리자 비밀번호 (index.html에는 존재하지 않음)
//   ADMIN_ID         - (선택) 마스터 관리자 아이디. 비워두면 "master"
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - Supabase가 자동 주입

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_PASSWORD = (Deno.env.get("ADMIN_PASSWORD") ?? "").trim();
const ADMIN_ID = (Deno.env.get("ADMIN_ID") ?? "").trim() || "master";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// index.html의 BRANDS와 동일하게 유지
const BRANDS = ["애슐리퀸즈","델리바이애슐리","리미니","자연별곡","피자몰","로운","프랑제리","프랜차이즈","카페"];
const STORE_CODE_RE = /^[A-Z0-9-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_ID_RE = /^[a-zA-Z0-9._-]{3,30}$/;
const EDITABLE_STATUS = ["sent", "failed"]; // 'pending'으로 되돌리면 재발송 대상이 되므로 제외

// 브라우저(GitHub Pages)에서 호출하므로 CORS 허용 헤더 필수.
// 없으면 브라우저가 preflight(OPTIONS)에서 요청을 막아버림.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function text(body: string, status: number) {
  return new Response(body, { status, headers: corsHeaders });
}
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
// 자동생성 코드는 영문 약어 + 숫자 4자리 (한글이 들어가면 입력이 불편하고 파일 경로에도 쓸 수 없음)
const BRAND_PREFIX: Record<string, string> = {
  "애슐리퀸즈": "AQ", "델리바이애슐리": "DA", "리미니": "RM", "자연별곡": "JB", "피자몰": "PM",
  "로운": "RW", "프랑제리": "FR", "프랜차이즈": "FC", "카페": "CF",
};
function genStoreCode(brand: string) {
  return (BRAND_PREFIX[brand] || "EL") + "-" + Math.floor(1000 + Math.random() * 9000);
}

// 매장 정보 입력값 검증 (생성/수정 공통). 오류 메시지 또는 null 반환
// deno-lint-ignore no-explicit-any
function validateStoreFields(f: any) {
  if (!BRANDS.includes(f.brand)) return "브랜드를 목록에서 선택해 주십시오.";
  if (!f.store_name || !f.manager_name || !f.manager_email) return "필수 항목을 모두 입력해 주십시오.";
  if (f.store_name.length > 100 || f.manager_name.length > 50) return "입력값이 너무 깁니다.";
  if (!EMAIL_RE.test(f.manager_email)) return "이메일 형식이 올바르지 않습니다.";
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
    return text("매장코드는 영문, 숫자, 하이픈(-) 조합 3~20자로 입력해 주십시오.", 400);
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
    return text("매장코드는 영문, 숫자, 하이픈(-) 조합 3~20자로 입력해 주십시오.", 400);
  }
  if (fields.store_code === current.store_code.toUpperCase()) fields.store_code = current.store_code;

  const { error } = await supabaseAdmin.from("stores").update(fields).eq("id", id);
  if (error?.code === "23505") return text("이미 사용 중인 매장코드입니다. 다른 코드를 입력해 주십시오.", 409);
  if (error) throw new Error(error.message);
  return json({ ok: true });
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return text("Method not allowed", 405);
  }

  try {
    const { action, login_id, password, payload } = await req.json();

    // ---------- 공개 action ----------
    if (action === "register_store") {
      return await registerStore(payload);
    }

    if (action === "lookup_store") {
      const code = str(payload?.store_code);
      if (!code) return text("매장코드를 입력해 주십시오.", 400);
      const { data, error } = await supabaseAdmin
        .from("stores")
        .select("id, store_code, store_name, brand, manager_name")
        .eq("store_code", code)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return text("존재하지 않는 매장코드입니다.", 404);
      return json({ ok: true, store: data });
    }

    // ---------- 관리자 action (로그인 필요) ----------
    const admin = await authenticate(str(login_id), String(password ?? ""));
    if (!admin) {
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

    // ---------- 마스터 전용 action ----------
    const MASTER_ACTIONS: Record<string, (p: unknown) => Promise<Response>> = {
      update_store: updateStore,
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
  } catch (err) {
    return text(String(err.message || err), 500);
  }
});
