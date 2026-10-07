// Supabase Edge Function: send-defect-email
// 역할: Storage에 저장된 하자개선요청서(.docx)를 첨부하여
//       공용 발신계정으로 Microsoft Graph API를 통해 메일 발송
//
// 필요 환경변수 (Supabase 대시보드 > Edge Functions > Secrets 에서 등록):
//   MS_TENANT_ID      - Azure AD 테넌트 ID
//   MS_CLIENT_ID      - 앱 등록 Client ID
//   MS_CLIENT_SECRET  - 앱 등록 Client Secret
//   SENDER_EMAIL      - 공용 발신계정 이메일 (예: defect-report@company.com)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - Supabase가 자동 주입

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TENANT_ID = Deno.env.get("MS_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("MS_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET")!;
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL")!;

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

async function getGraphToken(): Promise<string> {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(url, { method: "POST", body });
  if (!res.ok) throw new Error("Graph 토큰 발급 실패: " + (await res.text()));
  const json = await res.json();
  return json.access_token;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const { to, reply_to, subject, document_path } = await req.json();
    if (!to || !subject || !document_path) {
      return new Response("필수 파라미터 누락", { status: 400, headers: corsHeaders });
    }

    // 1) Storage에서 문서 다운로드 (service role — 정책 우회)
    const { data: fileData, error: dlErr } = await supabaseAdmin
      .storage.from("defect-reports").download(document_path);
    if (dlErr) throw new Error("문서 다운로드 실패: " + dlErr.message);
    const buf = await fileData.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const fileName = document_path.split("/").pop() || "하자개선요청서.docx";

    // 2) Graph API 토큰 발급
    const token = await getGraphToken();

    // 3) 메일 발송 (공용계정 발신, Reply-To는 매장 담당자)
    const mailPayload = {
      message: {
        subject,
        body: {
          contentType: "Text",
          content:
            "첨부된 결과물 하자 개선 요청서를 확인 부탁드립니다.\n\n" +
            "본 메일은 시스템에서 자동 발송되었습니다. 회신은 담당 매장으로 발송됩니다.",
        },
        toRecipients: [{ emailAddress: { address: to } }],
        replyTo: reply_to ? [{ emailAddress: { address: reply_to } }] : [],
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: fileName,
            contentBytes: base64,
          },
        ],
      },
      saveToSentItems: true,
    };

    const sendRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${SENDER_EMAIL}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mailPayload),
      }
    );

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      throw new Error("메일 발송 실패: " + errText);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(String((err as Error).message || err), { status: 500, headers: corsHeaders });
  }
});
