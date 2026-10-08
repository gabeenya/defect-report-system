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

const SMTP_HOST = Deno.env.get("SMTP_HOST")!;
const SMTP_USER = Deno.env.get("SMTP_USER")!;
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD")!;
const SMTP_FROM = Deno.env.get("SMTP_FROM") || SMTP_USER;

const MAIL_SUBJECT = "[이랜드이츠] 하자개선 요청서"; // 발송 메일 제목 고정값

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
    .select("id, document_url, stores(manager_email), subcontractors(email)")
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

    // 2) Storage에서 문서 다운로드 (service role — 정책 우회)
    const { data: fileData, error: dlErr } = await supabaseAdmin
      .storage.from("defect-reports").download(documentPath);
    if (dlErr) throw new Error("문서 다운로드 실패: " + dlErr.message);
    const base64 = arrayBufferToBase64(await fileData.arrayBuffer());
    const fileName = documentPath.split("/").pop() || "하자개선요청서.pdf";

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
      replyTo: replyTo || undefined,
      subject: MAIL_SUBJECT,
      content:
        "첨부된 결과물 하자 개선 요청서를 확인 부탁드립니다.\n\n" +
        "본 메일은 시스템에서 자동 발송되었습니다. 회신은 담당 매장으로 발송됩니다.",
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
