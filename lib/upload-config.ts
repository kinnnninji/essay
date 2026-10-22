// 업로드 제한 값. 서버(API 라우트)와 클라이언트(UI)가 함께 사용합니다.
// 비밀 값은 넣지 마세요. 이 파일은 브라우저 번들에도 포함됩니다.

/** 이미지 1장당 최대 용량 (Claude API의 이미지 5MB 제한) */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * PDF 최대 용량.
 * Claude API 요청 전체 한도(32MB)와 base64 인코딩(약 33% 증가)을 고려한 값입니다.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** <input type="file">의 accept 값 */
export const ACCEPT_ATTR = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";

/** 바이트 수를 사람이 읽기 쉬운 문자열로 변환 (예: 5MB, 1.3MB) */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}
