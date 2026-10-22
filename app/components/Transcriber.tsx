"use client";

import { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
  ACCEPT_ATTR,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  formatBytes,
} from "@/lib/upload-config";

type FileKind = "image" | "pdf";
type Preview = { url: string; kind: FileKind };
type TranscribeResponse = {
  text?: string;
  truncated?: boolean;
  error?: string;
};

function detectKind(file: File): FileKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    file.type === "image/jpeg" ||
    file.type === "image/png" ||
    /\.(jpe?g|png)$/.test(name)
  ) {
    return "image";
  }
  return null;
}

function validateFile(
  file: File,
): { ok: true; kind: FileKind } | { ok: false; message: string } {
  const kind = detectKind(file);
  if (!kind) {
    return {
      ok: false,
      message: `지원하지 않는 파일 형식입니다 (${file.name}). JPEG, PNG, PDF 파일만 업로드할 수 있습니다.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, message: "빈 파일입니다. 다른 파일을 선택해 주세요." };
  }
  const limit = kind === "pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limit) {
    return {
      ok: false,
      message: `파일 용량이 너무 큽니다 (${formatBytes(file.size)}). ${
        kind === "pdf" ? "PDF" : "이미지"
      }는 최대 ${formatBytes(limit)}까지 업로드할 수 있습니다.`,
    };
  }
  return { ok: true, kind };
}

function buildDownloadName(originalName: string | undefined): string {
  const base = (originalName ?? "")
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  return `${base || "essay"}_전사.txt`;
}

export default function Transcriber() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [text, setText] = useState("");
  // 가장 최근에 Claude가 돌려준 전사 원본. 사용자가 수정했는지 판단하는 데 씁니다.
  const [transcribed, setTranscribed] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const hasResult = transcribed !== "";
  const hasUnsavedEdits = text.trim() !== "" && text !== transcribed;

  // 미리보기용 blob URL을 교체/언마운트할 때 해제합니다.
  useEffect(() => {
    const url = preview?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview]);

  function acceptFile(selected: File | undefined) {
    if (!selected || isLoading) return;

    const result = validateFile(selected);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (
      hasUnsavedEdits &&
      !window.confirm(
        "직접 수정한 전사 내용이 있습니다. 다른 파일을 선택하면 지금 내용이 사라집니다. 계속할까요?",
      )
    ) {
      return;
    }

    setFile(selected);
    setPreview({ url: URL.createObjectURL(selected), kind: result.kind });
    setText("");
    setTranscribed("");
    setError(null);
    setNotice(null);
  }

  async function handleTranscribe() {
    if (!file || isLoading) return;
    if (
      hasUnsavedEdits &&
      !window.confirm(
        "직접 수정한 전사 내용이 있습니다. 다시 전사하면 지금 내용이 새 결과로 바뀝니다. 계속할까요?",
      )
    ) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);
    setNotice(null);

    try {
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/upload",
        clientPayload: preview?.kind === "pdf" ? "pdf" : "image",
        contentType: file.type || undefined,
        abortSignal: controller.signal,
      });

      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobUrl: blob.url }),
        signal: controller.signal,
      });
      const data = (await response
        .json()
        .catch(() => null)) as TranscribeResponse | null;

      if (!response.ok) {
        setError(
          data?.error ??
            `서버에서 오류가 발생했습니다 (HTTP ${response.status}). 잠시 후 다시 시도해 주세요.`,
        );
        return;
      }

      const result = data?.text ?? "";
      setText(result);
      setTranscribed(result);

      if (result.trim() === "") {
        setNotice(
          "손글씨 텍스트를 찾지 못했습니다. 글씨가 잘 보이는 더 선명한 파일로 다시 시도해 주세요.",
        );
      } else if (data?.truncated) {
        setNotice(
          "답안이 길어서 전사가 중간에 끊겼을 수 있습니다. 결과의 끝부분을 원본과 확인하고, 필요하면 파일을 나누어 다시 시도해 주세요.",
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setNotice("전사를 취소했습니다.");
      } else {
        setError(
          "서버에 연결하지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.",
        );
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  function handleDownload() {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = buildDownloadName(file?.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          손글씨 논술 전사기
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          한국어 손글씨 논술 답안지를 JPEG, PNG, PDF로 올리면 Claude가 내용을
          요약이나 교정 없이 그대로 텍스트로 옮겨 적습니다. 읽을 수 없는 글자는{" "}
          <code className="rounded bg-black/[.06] px-1 py-0.5 font-mono text-[0.9em] dark:bg-white/[.1]">
            [판독불가]
          </code>
          로 표시됩니다. AI가 만든 결과이므로 원본과 대조해 검수한 뒤 저장하세요.
        </p>
      </header>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          if (!isLoading) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          acceptFile(e.dataTransfer.files?.[0]);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-zinc-400 ${
          isDragging
            ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900"
            : "border-zinc-300 hover:border-zinc-500 dark:border-zinc-700 dark:hover:border-zinc-500"
        } ${isLoading ? "pointer-events-none opacity-60" : ""}`}
      >
        <input
          type="file"
          accept={ACCEPT_ATTR}
          disabled={isLoading}
          className="sr-only"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            // 같은 파일을 다시 선택해도 change 이벤트가 발생하도록 초기화합니다.
            e.target.value = "";
            acceptFile(selected);
          }}
        />
        <span className="break-all text-base font-medium">
          {file
            ? file.name
            : "답안지 파일을 여기로 끌어다 놓거나 클릭해서 선택하세요"}
        </span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {file
            ? `${formatBytes(file.size)} · 다른 파일을 선택하려면 다시 클릭하거나 끌어다 놓으세요`
            : `JPEG, PNG (최대 ${formatBytes(MAX_IMAGE_BYTES)}) · PDF (최대 ${formatBytes(MAX_PDF_BYTES)})`}
        </span>
      </label>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleTranscribe}
          disabled={!file || isLoading}
          className="h-11 rounded-full bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLoading ? "전사 중…" : hasResult ? "다시 전사" : "전사 시작"}
        </button>
        {isLoading && (
          <button
            type="button"
            onClick={handleCancel}
            className="h-11 rounded-full border border-zinc-300 px-6 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            취소
          </button>
        )}
      </div>

      {file && preview && (
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">원본</h2>
              <a
                href={preview.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-zinc-600 underline underline-offset-4 hover:text-foreground dark:text-zinc-400"
              >
                새 탭에서 크게 보기
              </a>
            </div>
            <div className="h-[70vh] overflow-auto rounded-xl border border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900">
              {preview.kind === "image" ? (
                // blob: URL은 next/image로 최적화할 수 없으므로 일반 img를 사용합니다.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview.url}
                  alt="업로드한 손글씨 답안 원본"
                  className="block h-auto w-full"
                />
              ) : (
                <iframe
                  src={preview.url}
                  title="업로드한 손글씨 답안 원본 PDF"
                  className="h-full w-full"
                />
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                전사 결과
                <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
                  직접 수정할 수 있어요
                </span>
                {hasResult && text !== transcribed && (
                  <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    수정됨
                  </span>
                )}
              </h2>
              <div className="flex items-center gap-3">
                <span className="text-sm text-zinc-500 dark:text-zinc-400">
                  {text.length.toLocaleString()}자
                </span>
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={text.trim() === "" || isLoading}
                  className="h-9 rounded-full border border-zinc-300 px-4 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  TXT 다운로드
                </button>
              </div>
            </div>
            <div className="relative h-[70vh]" aria-busy={isLoading}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={isLoading}
                spellCheck={false}
                aria-label="전사 결과 (직접 수정 가능)"
                placeholder="‘전사 시작’을 누르면 전사 결과가 여기에 표시됩니다."
                className="h-full w-full resize-none rounded-xl border border-zinc-300 bg-white p-4 text-base leading-7 outline-none transition-colors focus:border-zinc-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-black dark:focus:border-zinc-400"
              />
              {isLoading && (
                <div
                  role="status"
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-white/80 text-center dark:bg-black/80"
                >
                  <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-zinc-100" />
                  <p className="text-sm font-medium">
                    손글씨를 전사하는 중입니다…
                  </p>
                  <p className="px-6 text-xs text-zinc-500 dark:text-zinc-400">
                    분량에 따라 수십 초에서 몇 분까지 걸릴 수 있어요. 이 창을 닫지
                    마세요.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
