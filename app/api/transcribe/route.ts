import Anthropic from "@anthropic-ai/sdk";
import { del } from "@vercel/blob";
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  formatBytes,
} from "@/lib/upload-config";

// 이 파일은 서버에서만 실행됩니다. ANTHROPIC_API_KEY는 여기서만 읽으며,
// 브라우저로 전달되거나 응답/로그에 포함되지 않습니다.
export const runtime = "nodejs";
export const maxDuration = 300;

// 사용할 모델. .env.local에 ANTHROPIC_MODEL을 지정하면 그 값이 우선합니다.
const DEFAULT_MODEL = "claude-sonnet-5";
// 긴 답안(여러 쪽 PDF)도 잘리지 않도록 넉넉하게 잡습니다.
const MAX_OUTPUT_TOKENS = 16000;

const SYSTEM_PROMPT = `당신은 한국어 손글씨 논술 답안지를 정확하게 옮겨 적는 전사(transcription) 전문가입니다.
첨부된 이미지 또는 PDF에 손으로 쓴 내용을 그대로 텍스트로 옮기세요.
목표는 문서 분석이나 정리가 아니라, 손글씨 답안의 정확한 텍스트 전사입니다.

[반드시 지켜야 할 원칙]
1. 요약하지 마세요. 손글씨 내용을 처음부터 끝까지 빠짐없이 옮깁니다.
2. 교정하지 마세요. 맞춤법, 띄어쓰기, 문법, 표현이 틀려 보여도 쓰인 그대로 옮기고, 문장을 다듬거나 바꾸지 마세요.
3. 필자가 나눈 문단과 줄바꿈을 최대한 유지하세요. 새 문단을 시작한 곳(들여쓰기, 의도적으로 줄을 바꾼 곳)에서는 줄을 바꿉니다. 다만 종이의 오른쪽 끝에 닿아서 자연스럽게 다음 줄로 넘어간 것뿐이라면 줄바꿈을 넣지 말고 문장을 이어서 쓰세요.
4. 답안지의 칸(원고지 칸, 줄, 괘선, 격자 등)을 표로 인식하지 마세요. 표, 마크다운 표, 격자 형태로 출력하지 말고 글자만 읽어서 이어 쓰세요.
5. 사람이 실제로 읽는 자연스러운 순서로 옮기세요. 기본은 위에서 아래, 왼쪽에서 오른쪽입니다. 여백의 추가 글, 화살표, 삽입 기호(∨, ∧ 등)가 있으면 필자가 의도한 위치에 넣어 읽는 순서를 따릅니다.
6. 숫자, 괄호, 문장부호, 기호, 제시문 번호(예: (가), (나), [A], ①, 1), ㄱ. ㄴ.)를 보이는 그대로 정확하게 옮기세요. 괄호나 기호의 종류를 임의로 바꾸지 마세요.
7. 확실하지 않은 글자를 추측해서 만들어내지 마세요. 읽을 수 없거나 확신할 수 없는 글자는 그 자리에 [판독불가]라고 표시하세요. 한두 글자만 불확실하다면 그 글자만 [판독불가]로 쓰고 나머지는 그대로 옮깁니다. 문맥상 그럴듯한 단어를 지어내서 채우지 마세요.
8. 이미지에 없는 내용을 추가하지 마세요. 제목, 머리말, 설명, 번역, 요약, 평가, 쪽 표시를 임의로 넣지 않습니다.
9. 필자가 줄을 그어 지운 글자는 옮기지 않습니다.
10. 인쇄된 양식 문구(안내문, 칸 번호, 글자 수 눈금, 인쇄된 쪽 번호 등)는 답안이 아니므로 옮기지 않고, 손으로 쓴 내용만 옮깁니다.

[출력 형식]
- 출력에는 전사된 텍스트만 포함하세요.
- 인사말, 설명, 요약, 주석, "다음은 전사 결과입니다" 같은 문구, 코드 블록(\`\`\`), 마크다운 서식을 절대 넣지 마세요.
- 여러 쪽이면 쪽 순서대로 이어서 옮기되, 쪽 구분 표시는 넣지 마세요.
- 읽을 수 있는 손글씨가 전혀 없으면 아무것도 출력하지 마세요.`;

const USER_PROMPT =
  "첨부한 손글씨 논술 답안을 위 원칙에 따라 전사하세요. 전사된 텍스트만 출력하세요.";

type DetectedFile =
  | { kind: "image"; mediaType: "image/jpeg" | "image/png" }
  | { kind: "pdf" };

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

/** 확장자나 MIME 값은 조작될 수 있으므로 파일의 첫 바이트(매직 넘버)로 실제 형식을 판별합니다. */
function detectFileType(buffer: Buffer): DetectedFile | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { kind: "image", mediaType: "image/jpeg" };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { kind: "image", mediaType: "image/png" };
  }
  // PDF 헤더(%PDF-)는 파일 앞 1KB 안에 있으면 유효한 PDF로 취급합니다.
  if (buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    return { kind: "pdf" };
  }
  return null;
}

/** 업로드는 클라이언트가 Vercel Blob에 직접 하므로, 이 서버가 받는 건 그 URL뿐입니다.
 *  임의의 외부 URL을 서버가 대신 요청하지 않도록(SSRF 방지) 우리 Blob 스토어 도메인인지 확인합니다. */
function isOwnBlobUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".public.blob.vercel-storage.com")
    );
  } catch {
    return false;
  }
}

function shorten(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 모델이 지시를 어기고 코드 블록으로 감싼 경우를 대비해 바깥 ``` 표시만 제거합니다. */
function cleanTranscript(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) {
    text = fenced[1].trimEnd();
  }
  return text;
}

function toErrorResponse(error: unknown, model: string) {
  if (error instanceof Anthropic.APIConnectionError) {
    console.error("[transcribe] Claude API 연결 오류:", error.name);
    return errorResponse(
      "Claude API 서버에 연결하지 못했거나 응답 시간이 초과되었습니다. 네트워크 상태를 확인하고 잠시 후 다시 시도해 주세요.",
      504,
    );
  }

  if (error instanceof Anthropic.APIError) {
    console.error(
      "[transcribe] Claude API 오류:",
      error.status,
      error.name,
      shorten(error.message),
    );

    if (error.message.toLowerCase().includes("credit balance")) {
      return errorResponse(
        "Anthropic API 크레딧이 부족합니다. Anthropic 콘솔에서 결제/크레딧 상태를 확인해 주세요.",
        402,
      );
    }

    switch (error.status) {
      case 400:
        return errorResponse(
          `Claude가 이 파일을 처리하지 못했습니다. 파일이 손상되었거나, 이미지 해상도 또는 PDF 페이지 수(최대 100쪽)가 제한을 넘었을 수 있습니다. (${shorten(error.message)})`,
          400,
        );
      case 401:
        return errorResponse(
          "서버에 설정된 Claude API 키가 올바르지 않거나 만료되었습니다. .env.local의 ANTHROPIC_API_KEY를 확인한 뒤 서버를 다시 시작해 주세요.",
          500,
        );
      case 403:
        return errorResponse(
          "이 API 키에는 Claude API 사용 권한이 없습니다. Anthropic 콘솔에서 키의 권한을 확인해 주세요.",
          500,
        );
      case 404:
        return errorResponse(
          `사용하려는 Claude 모델(${model})을 찾을 수 없습니다. .env.local의 ANTHROPIC_MODEL 값을 확인해 주세요.`,
          500,
        );
      case 413:
        return errorResponse(
          "파일이 Claude API가 허용하는 요청 크기를 넘었습니다. 더 작은 파일로 다시 시도해 주세요.",
          413,
        );
      case 429:
        return errorResponse(
          "요청이 많아 Claude API 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
          429,
        );
      default:
        if (error.status !== undefined && error.status >= 500) {
          return errorResponse(
            "Claude 서버가 일시적으로 혼잡하거나 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
            503,
          );
        }
        return errorResponse(
          `Claude API 호출 중 오류가 발생했습니다. (${shorten(error.message)})`,
          502,
        );
    }
  }

  console.error(
    "[transcribe] 예상하지 못한 오류:",
    error instanceof Error ? error.name : typeof error,
  );
  return errorResponse(
    "전사 중 예상하지 못한 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
    500,
  );
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[transcribe] ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.");
    return errorResponse(
      "서버에 Claude API 키가 설정되어 있지 않습니다. .env.local에 ANTHROPIC_API_KEY를 설정한 뒤 서버를 다시 시작해 주세요.",
      500,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "업로드한 데이터를 읽지 못했습니다. 파일을 다시 선택해 주세요.",
      400,
    );
  }

  const blobUrl =
    body && typeof body === "object" && "blobUrl" in body
      ? (body as { blobUrl: unknown }).blobUrl
      : undefined;

  if (!isOwnBlobUrl(blobUrl)) {
    return errorResponse(
      "업로드된 파일이 없습니다. JPEG, PNG 또는 PDF 파일을 선택해 주세요.",
      400,
    );
  }

  // 파일 자체(클라이언트→Vercel Blob)는 이미 업로드되어 있으므로, 서버는 전사를 위해
  // 그 내용만 가져옵니다. 전사 후에는 아래 finally에서 Blob을 삭제해 남겨두지 않습니다.
  let buffer: Buffer;
  try {
    const blobResponse = await fetch(blobUrl);
    if (!blobResponse.ok) {
      return errorResponse(
        "업로드한 파일을 불러오지 못했습니다. 파일을 다시 선택해 주세요.",
        400,
      );
    }
    buffer = Buffer.from(await blobResponse.arrayBuffer());
  } catch {
    return errorResponse(
      "업로드한 파일을 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.",
      502,
    );
  }

  try {
    if (buffer.length === 0) {
      return errorResponse("빈 파일입니다. 다른 파일을 선택해 주세요.", 400);
    }
    if (buffer.length > MAX_PDF_BYTES) {
      return errorResponse(
        `파일 용량이 너무 큽니다 (${formatBytes(buffer.length)}). 이미지는 최대 ${formatBytes(MAX_IMAGE_BYTES)}, PDF는 최대 ${formatBytes(MAX_PDF_BYTES)}까지 업로드할 수 있습니다.`,
        413,
      );
    }

    const detected = detectFileType(buffer);
    if (!detected) {
      return errorResponse(
        "지원하지 않는 파일 형식입니다. JPEG, PNG, PDF 파일만 업로드할 수 있습니다.",
        415,
      );
    }
    if (detected.kind === "image" && buffer.length > MAX_IMAGE_BYTES) {
      return errorResponse(
        `이미지 용량이 너무 큽니다 (${formatBytes(buffer.length)}). 이미지는 최대 ${formatBytes(MAX_IMAGE_BYTES)}까지 업로드할 수 있습니다. 해상도를 줄이거나 압축한 뒤 다시 시도해 주세요.`,
        413,
      );
    }

    return await transcribe(buffer, detected);
  } finally {
    del(blobUrl).catch((error) => {
      console.error("[transcribe] Blob 삭제 실패:", error);
    });
  }
}

async function transcribe(
  buffer: Buffer,
  detected: DetectedFile,
): Promise<Response> {
  const base64 = buffer.toString("base64");
  const fileBlock =
    detected.kind === "pdf"
      ? {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: base64,
          },
        }
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: detected.mediaType,
            data: base64,
          },
        };

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  try {
    // API 키는 SDK가 서버 환경 변수(ANTHROPIC_API_KEY)에서 직접 읽습니다.
    const client = new Anthropic({ maxRetries: 2 });

    // 긴 출력에서도 연결이 끊기지 않도록 스트리밍으로 받고, 완성된 메시지만 사용합니다.
    const message = await client.messages
      .stream({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [fileBlock, { type: "text" as const, text: USER_PROMPT }],
          },
        ],
      })
      .finalMessage();

    const stopReason: string | null = message.stop_reason;
    if (stopReason === "refusal") {
      return errorResponse(
        "Claude가 이 파일의 전사를 처리하지 않았습니다. 다른 파일로 다시 시도해 주세요.",
        422,
      );
    }

    let raw = "";
    for (const block of message.content) {
      if (block.type === "text") {
        raw += block.text;
      }
    }

    return Response.json({
      text: cleanTranscript(raw),
      truncated: stopReason === "max_tokens",
    });
  } catch (error) {
    return toErrorResponse(error, model);
  }
}
