import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type UploadPhoto = {
  id: string;
  status: "pending" | "processing" | "done" | "error" | "unread";
};
export type UploadSession = {
  id: string;
  inspectionId: string;
  name: string;
  size: number;
  sha256: string;
  pointId: string | null;
  planId: string | null;
  recordPurpose?: "inspection" | "presentation" | "verification";
  offset: number;
  chunkBytes: number;
  status: "receiving" | "finalizing" | "completed" | "expired";
  error: string | null;
  photo: UploadPhoto | null;
};
export type UploadEntry = {
  id: string;
  name: string;
  size: number;
  sha256: string | null;
  pointId: string | null;
  planId: string | null;
  recordPurpose?: "inspection" | "presentation" | "verification";
  targetLabel: string;
  state:
    | "waiting"
    | "checking"
    | "uploading"
    | "saving"
    | "stored"
    | "failed"
    | "needs-file";
  progress: number;
  error: string;
  photo: UploadPhoto | null;
};
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
const base = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const storageKey = "plantpilot-upload-queue-v1";

export function readUploadQueue(): UploadEntry[] {
  try {
    const rows = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (row) =>
          row &&
          typeof row.id === "string" &&
          /^[a-f0-9-]{36}$/.test(row.id) &&
          typeof row.name === "string" &&
          Number.isSafeInteger(row.size) &&
          row.size > 0,
      )
      .map((row) => ({
        ...row,
        state: row.state === "stored" ? "stored" : "needs-file",
        error:
          row.state === "stored"
            ? ""
            : "저장 상태를 확인한 뒤, 아직 저장되지 않은 사진은 원래 파일을 다시 선택하세요.",
      }));
  } catch {
    return [];
  }
}
export function persistUploadQueue(rows: UploadEntry[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

export async function uploadRequest(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<UploadSession> {
  let response;
  try {
    response = await fetch(`${base}/api/upload-sessions${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UploadError(
      "연결이 끊겼거나 응답이 늦어졌습니다. 저장 상태 확인 후 같은 항목을 다시 시도하세요.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new UploadError(
      "저장 응답을 확인하지 못했습니다. 같은 항목의 저장 상태를 확인하세요.",
      response.status,
    );
  }
  if (!response.ok)
    throw new UploadError(
      typeof data?.error === "string"
        ? data.error
        : "사진을 저장하지 못했습니다. 해당 항목을 다시 시도하세요.",
      response.status,
    );
  return data as UploadSession;
}

export async function fingerprint(
  file: File,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  const hash = sha256.create();
  const reader = file.stream().getReader();
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      hash.update(part.value);
      length += part.value.byteLength;
      progress(Math.round((length / file.size) * 100));
    }
    return bytesToHex(hash.digest());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function transferFile(
  entry: UploadEntry,
  file: File,
  signal: AbortSignal,
  update: (patch: Partial<UploadEntry>) => void,
  restart = false,
) {
  update({ state: "checking", progress: 0, error: "" });
  const hash = await fingerprint(file, signal, (progress) =>
    update({ progress }),
  );
  if (file.size !== entry.size || (entry.sha256 && hash !== entry.sha256))
    throw new UploadError(
      "원래 선택한 사진과 내용이 다릅니다. 원래 파일을 다시 선택하거나 새 사진으로 추가하세요.",
    );
  update({ sha256: hash });
  let session = await uploadRequest(
    "",
    {
      method: "POST",
      body: JSON.stringify({
        id: entry.id,
        name: entry.name,
        size: file.size,
        sha256: hash,
        pointId: entry.pointId,
        planId: entry.planId,
        recordPurpose: entry.recordPurpose ?? "inspection",
      }),
    },
    signal,
  );
  if (session.status === "completed") return session;
  if (restart)
    session = await uploadRequest(
      `/${entry.id}/restart`,
      { method: "POST", body: JSON.stringify({ sha256: hash }) },
      signal,
    );
  if (session.status === "expired")
    throw new UploadError(
      session.error ||
        "임시 전송이 만료됐습니다. 같은 파일로 처음부터 다시 전송하세요.",
      410,
    );
  update({
    state: "uploading",
    progress: Math.round((session.offset / file.size) * 100),
  });
  while (session.status === "receiving" && session.offset < file.size) {
    signal.throwIfAborted();
    const offset = session.offset;
    const part = file.slice(
      offset,
      Math.min(file.size, offset + session.chunkBytes),
    );
    const bytes = new Uint8Array(await part.arrayBuffer());
    session = await uploadRequest(
      `/${entry.id}/chunks?offset=${offset}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Chunk-SHA256": bytesToHex(sha256(bytes)),
        },
        body: part,
      },
      signal,
    );
    if (session.offset <= offset)
      throw new UploadError(
        "전송 위치가 갱신되지 않았습니다. 저장 상태를 확인하고 다시 시도하세요.",
      );
    update({ progress: Math.round((session.offset / file.size) * 100) });
  }
  update({ state: "saving", progress: 100 });
  return uploadRequest(`/${entry.id}/complete`, { method: "POST" }, signal);
}
