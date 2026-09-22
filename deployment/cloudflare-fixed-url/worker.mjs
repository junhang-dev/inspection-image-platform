const unavailable = () => Response.json(
  { error: "공유 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요." },
  { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
);

export default {
  async fetch(request, env) {
    const publicUrl = new URL(request.url);
    if (!env.PUBLIC_HOSTNAME || !env.SHARED_WEB?.fetch) return unavailable();
    if (publicUrl.hostname !== env.PUBLIC_HOSTNAME || publicUrl.port) {
      return new Response("Unknown host", { status: 421 });
    }
    if (publicUrl.protocol !== "https:") {
      return new Response("HTTPS required", { status: 400 });
    }

    // The VPC binding fixes the real origin to 127.0.0.1:3000.
    // Keep the public Host while selecting the configured HTTP port.
    const targetUrl = new URL(publicUrl);
    targetUrl.protocol = "http:";
    const forwarded = new Request(targetUrl, request);
    const headers = new Headers(forwarded.headers);
    headers.set("Host", env.PUBLIC_HOSTNAME);
    headers.set("X-Forwarded-Host", env.PUBLIC_HOSTNAME);
    headers.set("X-Forwarded-Proto", "https");
    headers.set("X-Forwarded-Port", "443");
    const upstreamRequest = new Request(forwarded, {
      headers,
      redirect: "manual",
    });

    let response;
    try {
      response = await env.SHARED_WEB.fetch(upstreamRequest);
    } catch {
      return unavailable();
    }

    // Preserve a WebSocket upgrade object if the origin uses one.
    if (response.status === 101) return response;
    if (publicUrl.pathname === "/api" || publicUrl.pathname.startsWith("/api/")) {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Cache-Control", "private, no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
    return response;
  },
};
