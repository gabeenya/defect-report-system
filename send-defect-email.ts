// Supabase Edge Function: send-defect-email
// 역할: Storage에 저장된 하자개선요청서(.pdf)를 첨부하여
//       SMTP(Gmail, 네이버 메일 등)로 수급사에게 메일 발송
//
// 보안: 클라이언트는 submission_id만 보냄. 수신자(등록된 수급사 이메일),
//       Reply-To(매장 담당자 이메일), 제목, 첨부 문서는 전부 서버가 DB에서 결정.
//       email_status가 'pending'인 건만 1회 발송 (재발송/임의 발송 차단).
//
// 필요 환경변수 (Supabase 대시보드 > Edge Functions > Secrets 에서 등록):
//   SMTP_HOST     - 메일 서버 주소 (Gmail: smtp.gmail.com / 네이버: smtp.naver.com)
//   SMTP_USER     - 발신 계정 전체 아이디 (Gmail: user@gmail.com / 네이버: user@naver.com)
//   SMTP_PASSWORD - Gmail: 2단계 인증 후 발급한 "앱 비밀번호" (일반 로그인 비밀번호 아님)
//                   네이버: 2단계 인증을 켰다면 네이버 "앱 비밀번호", 아니면 로그인 비밀번호
//                   (네이버 메일 환경설정 > POP3/IMAP 설정에서 SMTP 사용을 켜둬야 함)
//   SMTP_FROM     - (선택) 발신자로 표시할 주소. 비워두면 SMTP_USER 사용
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - Supabase가 자동 주입

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// Secrets 입력 시 앞뒤 공백이 섞여 들어가는 경우가 있어 trim
const SMTP_HOST = (Deno.env.get("SMTP_HOST") ?? "").trim();
const SMTP_USER = (Deno.env.get("SMTP_USER") ?? "").trim();
const SMTP_PASSWORD = (Deno.env.get("SMTP_PASSWORD") ?? "").trim();
const SMTP_FROM = (Deno.env.get("SMTP_FROM") ?? "").trim() || SMTP_USER;

// 발송 메일 제목: "[브랜드명][매장명] 하자개선요청서" (매장 정보는 DB의 매장 기준)
function mailSubject(brand: string, storeName: string) {
  return `[${brand || "이랜드이츠"}]${storeName ? `[${storeName}]` : ""} 하자개선요청서`;
}

// "2026-10-12" → "2026년 10월 12일"
function formatKoreanDate(ymd: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : ymd;
}

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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 한글 제목을 RFC 2047 Base64 encoded-word로 직접 인코딩.
// denomailer는 한글 제목을 Q 인코딩하면서 공백·줄바꿈을 그대로 넣어 수신측에서 제목이 깨짐.
// 앞에 공백을 붙이면 denomailer가 ASCII 문자열로 보고 재인코딩하지 않음 (헤더 값 앞 공백은 무시됨).
// encoded-word 하나는 75자 이하여야 하므로, 글자 단위로 끊어 여러 개로 나눔 (사이 공백은 수신측에서 무시됨).
function encodeHeaderUtf8(text: string): string {
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (!chunk.length) return;
    words.push("=?UTF-8?B?" + btoa(String.fromCharCode(...chunk)) + "?=");
    chunk = [];
  };
  for (const ch of text) {
    const bytes = encoder.encode(ch);
    if (chunk.length + bytes.length > 45) flush(); // 45바이트 → base64 60자 + 12자 = 72자
    chunk.push(...bytes);
  }
  flush();
  return " " + words.join(" ");
}

function textResponse(body: string, status: number) {
  return new Response(body, { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return textResponse("Method not allowed", 405);
  }

  let submissionId: string | undefined;
  try {
    ({ submission_id: submissionId } = await req.json());
  } catch {
    return textResponse("잘못된 요청", 400);
  }
  if (!submissionId) {
    return textResponse("필수 파라미터 누락", 400);
  }

  // 1) 'pending' 건만 'sending'으로 선점 → 동시/중복 호출로 두 번 발송되는 것 방지
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("submissions")
    .update({ email_status: "sending" })
    .eq("id", submissionId)
    .eq("email_status", "pending")
    .select("id, work_date, document_url, stores(brand, store_name, manager_name, manager_email), subcontractors(email)")
    .maybeSingle();
  if (claimErr) return textResponse("조회 실패: " + claimErr.message, 500);
  if (!claimed) return textResponse("발송 대기 상태인 요청서가 아님", 409);

  try {
    // deno-lint-ignore no-explicit-any
    const row = claimed as any;
    const to: string | undefined = row.subcontractors?.email;
    const replyTo: string | undefined = row.stores?.manager_email;
    const documentPath: string | undefined = row.document_url;
    if (!to || !documentPath) throw new Error("수신 이메일 또는 문서 정보 없음");
    // 공용 발신 주소로 회신이 오지 않도록 Reply-To(매장 담당자)가 없으면 발송하지 않음
    if (!replyTo) throw new Error("매장 담당자 이메일 없음 (회신 주소 미지정으로 발송 중단)");
    const brand: string = row.stores?.brand || "";
    const storeName: string = row.stores?.store_name || "";
    const managerName: string = row.stores?.manager_name || "";
    const workDate = formatKoreanDate(row.work_date);

    // 2) Storage에서 문서 다운로드 (service role — 정책 우회)
    const { data: fileData, error: dlErr } = await supabaseAdmin
      .storage.from("defect-reports").download(documentPath);
    if (dlErr) throw new Error("문서 다운로드 실패: " + dlErr.message);
    const base64 = arrayBufferToBase64(await fileData.arrayBuffer());
    // 메일 라이브러리가 첨부 파일명을 인코딩하지 않으므로 한글/공백 없는 영문 파일명 사용
    const fileName = `ElandEats_DefectReport_${row.work_date || ""}.pdf`;

    // 3) SMTP로 메일 발송 (공용 계정 발신, Reply-To는 매장 담당자)
    const client = new SMTPClient({
      connection: {
        hostname: SMTP_HOST,
        port: 465,
        tls: true,
        auth: {
          username: SMTP_USER,
          password: SMTP_PASSWORD,
        },
      },
    });

    await client.send({
      from: SMTP_FROM,
      to,
      replyTo,
      subject: encodeHeaderUtf8(mailSubject(brand, storeName)),
      content:
        "안녕하세요, 주식회사 이랜드이츠입니다.\n\n" +
        `첨부된 서류는 ${brand} ${storeName}에서 ${workDate}에 수행된 귀하의 업무상 하자에 대한 개선 요청서입니다.\n` +
        "확인 후 계약에 따른 성실한 회신 및 개선 진행 바랍니다.\n\n" +
        "※ 본 메일은 발신 전용 주소에서 자동 발송되었으며, 본 메일에 회신하거나 문의할 경우 " +
        `담당 매장(${storeName} ${managerName}, ${replyTo})으로 전달됩니다.`,
      attachments: [
        {
          filename: fileName,
          content: base64,
          encoding: "base64",
          contentType: "application/pdf",
        },
      ],
    });

    await client.close();

    await supabaseAdmin.from("submissions")
      .update({ email_status: "sent", email_error: null })
      .eq("id", submissionId);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = String((err as Error).message || err);
    await supabaseAdmin.from("submissions")
      .update({ email_status: "failed", email_error: msg })
      .eq("id", submissionId);
    return textResponse(msg, 500);
  }
});
