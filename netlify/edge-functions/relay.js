const GITHUB_PAGE = "https://code-leafy.github.io/NetLeafy/";
const TIMEOUT_MS = 20_000;

const PRIVATE_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|fc00:|fd[\da-f]{2}:)/i;

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function handler(request, context) {
  try {
    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      return new Response("ok", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    let targetHost = request.headers.get("x-host");

    if (url.pathname === "/" && !targetHost) {
      const upgradeHeader = request.headers.get("upgrade") || "";
      if (upgradeHeader.toLowerCase() !== "websocket") {
        const githubResponse = await fetch(GITHUB_PAGE);
        const githubContent = await githubResponse.text();
        return new Response(githubContent, {
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }
    }

    if (!targetHost) {
      return new Response("Error: x-host header is missing.", { status: 400 });
    }

    let targetUrl;
    if (targetHost.startsWith("http://") || targetHost.startsWith("https://")) {
      targetUrl = `${targetHost}${url.pathname}${url.search}`;
    } else {
      const isSecure =
        !targetHost.includes(":") ||
        targetHost.includes(":443") ||
        /^s\d+\./.test(targetHost);
      const protocol = isSecure ? "https://" : "http://";
      targetUrl = `${protocol}${targetHost}${url.pathname}${url.search}`;
    }

    const parsedTarget = new URL(targetUrl);
    if (PRIVATE_RE.test(parsedTarget.hostname)) {
      return new Response(null, { status: 403 });
    }

    const headers = new Headers();
    let clientIp = null;

    for (const [key, value] of request.headers) {
      const k = key.toLowerCase();
      if (
        STRIP_HEADERS.has(k) ||
        k.startsWith("x-nf-") ||
        k.startsWith("x-netlify-") ||
        k === "x-host"
      )
        continue;
      if (k === "x-real-ip") { clientIp = value; continue; }
      if (k === "x-forwarded-for") { if (!clientIp) clientIp = value; continue; }
      headers.set(k, value);
    }

    clientIp = context.ip ?? clientIp;
    if (clientIp) headers.set("x-forwarded-for", clientIp);

    const method = request.method;

    const upstream = await fetch(targetUrl, {
      method,
      headers,
      redirect: "manual",
      body: method !== "GET" && method !== "HEAD" ? request.body : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (location) {
        try {
          const redirectUrl = new URL(location, targetUrl);
          if (PRIVATE_RE.test(redirectUrl.hostname)) {
            return new Response(null, { status: 403 });
          }
        } catch {
          return new Response(null, { status: 502 });
        }
      }
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers) {
      if (key.toLowerCase() === "transfer-encoding") continue;
      responseHeaders.set(key, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return new Response("Gateway Timeout", { status: 504 });
    }
    return new Response("Bad Gateway: Relay Failed", { status: 502 });
  }
}
