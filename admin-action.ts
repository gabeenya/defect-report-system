// Supabase Edge Function: admin-action
// 역할: 매장코드 생성/조회와 관리자 기능을 service role 권한으로 수행한다.
//       (anon key로는 stores 테이블 조회·쓰기, subcontractors 쓰기 불가 — RLS로 차단됨)
//
//   - 공개 action (비밀번호 불필요):
//       register_store : 매장 사용자가 직접 매장코드 생성
//       lookup_store   : 매장코드로 접속 (코드가 정확히 일치하는 매장 1건만 반환)
//   - 관리자 action (ADMIN_PASSWORD 검증 후 수행):
//       verify, list_stores, list_submissions, save_subcontractor
//
// 필요 환경변수 (Supabase 대시보드 > Edge Functions > Secrets 에서 등록):
//   ADMIN_PASSWORD   - 관리자 비밀번호 (index.html에는 더 이상 존재하지 않음)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - Supabase가 자동 주입

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")!;

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// index.html의 BRANDS와 동일하게 유지
const BRANDS = ["애슐리퀸즈","델리바이애슐리","리미니","자연별곡","피자몰","로운","프랑제리","프랜차이즈","카페"];
const STORE_CODE_RE = /^[A-Z0-9-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// 자동생성 코드는 영문 약어 + 숫자 4자리 (한글이 들어가면 입력이 불편하고 파일 경로에도 쓸 수 없음)
const BRAND_PREFIX: Record<string, string> = {
  "애슐리퀸즈": "AQ", "델리바이애슐리": "DA", "리미니": "RM", "자연별곡": "JB", "피자몰": "PM",
  "로운": "RW", "프랑제리": "FR", "프랜차이즈": "FC", "카페": "CF",
};
function genStoreCode(brand: string) {
  return (BRAND_PREFIX[brand] || "EL") + "-" + Math.floor(1000 + Math.random() * 9000);
}

// deno-lint-ignore no-explicit-any
async function registerStore(payload: any) {
  const brand = String(payload?.brand ?? "").trim();
  const store_name = String(payload?.store_name ?? "").trim();
  const manager_name = String(payload?.manager_name ?? "").trim();
  const manager_email = String(payload?.manager_email ?? "").trim();
  const customCode = String(payload?.store_code ?? "").trim().toUpperCase();

  if (!BRANDS.includes(brand)) return text("브랜드를 목록에서 선택해 주십시오.", 400);
  if (!store_name || !manager_name || !manager_email) return text("필수 항목을 모두 입력해 주십시오.", 400);
  if (store_name.length > 100 || manager_name.length > 50) return text("입력값이 너무 깁니다.", 400);
  if (!EMAIL_RE.test(manager_email)) return text("이메일 형식이 올바르지 않습니다.", 400);
  if (customCode && !STORE_CODE_RE.test(customCode)) {
    return text("매장코드는 영문, 숫자, 하이픈(-) 조합 3~20자로 입력해 주십시오.", 400);
  }

  // 직접 지정한 코드는 1회만 시도, 자동생성은 중복 시 몇 번 재시도
  const attempts = customCode ? 1 : 5;
  for (let i = 0; i < attempts; i++) {
    const store_code = customCode || genStoreCode(brand);
    const { data, error } = await supabaseAdmin
      .from("stores")
      .insert({ store_code, store_name, brand, manager_name, manager_email })
      .select("id, store_code, store_name, brand, manager_name")
      .single();
    if (!error) return json({ ok: true, store: data });
    if (error.code !== "23505") throw new Error(error.message); // 23505 = unique 위반
    if (customCode) return text("이미 사용 중인 매장코드입니다. 다른 코드를 입력해 주십시오.", 409);
  }
  return text("매장코드 자동 발급에 실패했습니다. 다시 시도해 주십시오.", 500);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return text("Method not allowed", 405);
  }

  try {
    const { action, password, payload } = await req.json();

    // ---------- 공개 action ----------
    if (action === "register_store") {
      return await registerStore(payload);
    }

    if (action === "lookup_store") {
      const code = String(payload?.store_code ?? "").trim();
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

    // ---------- 관리자 action ----------
    if (password !== ADMIN_PASSWORD) {
      return text("비밀번호가 올바르지 않습니다.", 401);
    }

    if (action === "verify") {
      return json({ ok: true });
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

    if (action === "save_subcontractor") {
      const { id, ...fields } = payload;
      const { error } = id
        ? await supabaseAdmin.from("subcontractors").update(fields).eq("id", id)
        : await supabaseAdmin.from("subcontractors").insert(fields);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    return text("알 수 없는 요청입니다.", 400);
  } catch (err) {
    return text(String(err.message || err), 500);
  }
});
