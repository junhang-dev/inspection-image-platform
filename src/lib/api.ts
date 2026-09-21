export async function requestJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const changesData = !["GET", "HEAD"].includes(
    (options.method || "GET").toUpperCase(),
  );
  const nextStep = changesData
    ? " 저장된 목록에서 반영 여부를 확인한 후 다시 시도하세요."
    : " 연결 상태를 확인하고 다시 시도하세요.";
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10000),
      headers: {
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
  } catch (cause) {
    throw new Error(
      ((cause as Error).name === "TimeoutError"
        ? "서버 응답이 지연되고 있습니다."
        : "서버에 연결할 수 없습니다.") + nextStep,
    );
  }
  if (response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    throw new Error(
      `서버 처리 중 문제가 발생했습니다. (${response.status})${nextStep}`,
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    void response.body?.cancel().catch(() => {});
    throw new Error(
      `서버 응답 형식을 확인할 수 없습니다. (${response.status})${nextStep}`,
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("서버 응답을 끝까지 받지 못했습니다." + nextStep);
  }
  if (!response.ok)
    throw new Error(
      typeof data?.error === "string"
        ? data.error
        : "요청을 처리하지 못했습니다." + nextStep,
    );
  return data as T;
}
