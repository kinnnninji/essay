import { issueSignedToken } from "@vercel/blob";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { MAX_IMAGE_BYTES, MAX_PDF_BYTES } from "@/lib/upload-config";

// 클라이언트가 Vercel Blob에 파일을 직접 업로드할 수 있도록 서명된(presigned) 업로드 URL만 발급합니다.
// 파일 내용은 이 라우트를 거치지 않습니다 (Vercel 서버리스 함수의 요청 본문 용량 제한 회피).
// 이 프로젝트의 Blob 스토어는 정적 BLOB_READ_WRITE_TOKEN 대신 OIDC(BLOB_STORE_ID)로 인증되므로,
// 로컬 서명 방식인 handleUpload 대신 presigned 방식을 사용합니다.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadPresignedBody;

  try {
    const jsonResponse = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname, clientPayload) => {
        const isPdf = clientPayload === "pdf";
        const allowedContentTypes = [
          "image/jpeg",
          "image/png",
          "application/pdf",
        ];
        const maximumSizeInBytes = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;

        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          allowedContentTypes,
          maximumSizeInBytes,
        });

        return {
          token,
          urlOptions: {
            allowedContentTypes,
            maximumSizeInBytes,
            addRandomSuffix: true,
          },
        };
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
