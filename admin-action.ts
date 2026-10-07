// Supabase Edge Function: admin-action
// 역할: 관리자 비밀번호를 서버에서 검증하고, 매장코드 생성 / 수급사 등록·수정을
//       service role 권한으로 수행한다.
//       (anon key로는 stores/subcontractors 테이블에 직접 쓰기 불가 — RLS로 차단됨)
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

// 브라우저(GitHub Pages)에서 호출하므로 CORS 허용 헤더 필수.
// 없으면 브라우저가 preflight(OPTIONS)에서 요청을 막아버림.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const { action, password, payload } = await req.json();
    if (password !== ADMIN_PASSWORD) {
      return new Response("비밀번호가 올바르지 않습니다", { status: 401, headers: corsHeaders });
    }

    if (action === "verify") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create_store") {
      const { error } = await supabaseAdmin.from("stores").insert(payload);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "save_subcontractor") {
      const { id, ...fields } = payload;
      const { error } = id
        ? await supabaseAdmin.from("subcontractors").update(fields).eq("id", id)
        : await supabaseAdmin.from("subcontractors").insert(fields);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("알 수 없는 action", { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(String(err.message || err), { status: 500, headers: corsHeaders });
  }
});
