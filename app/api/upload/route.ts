import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { MAX_IMAGE_BYTES, MAX_PDF_BYTES } from "@/lib/upload-config";

// 클라이언트가 Vercel Blob에 파일을 직접 업로드할 수 있도록 업로드 토큰만 발급합니다.
// 파일 내용은 이 라우트를 거치지 않습니다 (Vercel 서버리스 함수의 요청 본문 용량 제한 회피).
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const isPdf = clientPayload === "pdf";
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "application/pdf"],
          maximumSizeInBytes: isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES,
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // 업로드 완료 후 처리는 /api/transcribe 호출 시 수행하므로 별도 작업이 없습니다.
      },
    });

    return Response.json(jsonResponse);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "업로드 토큰 발급 중 오류가 발생했습니다.",
      },
      { status: 400 },
    );
  }
}
