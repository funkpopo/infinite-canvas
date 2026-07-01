import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEDIA_PROXY_TIMEOUT_MS = 60000;

export async function GET(request: NextRequest) {
    const target = request.nextUrl.searchParams.get("url") || "";
    if (!target) return new Response("Missing url", { status: 400 });

    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return new Response("Invalid url", { status: 400 });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return new Response("Unsupported media url", { status: 400 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_PROXY_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        const body = await response.arrayBuffer();
        const headers = responseHeaders(response.headers);
        const mimeType = sniffImageMimeType(new Uint8Array(body.slice(0, 16)));
        if (mimeType) headers.set("content-type", mimeType);
        return new Response(body, {
            status: response.status,
            headers,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return new Response("Media proxy timeout", { status: 504 });
        return new Response(error instanceof Error ? error.message : "Media proxy error", { status: 502 });
    } finally {
        clearTimeout(timer);
    }
}

function sniffImageMimeType(bytes: Uint8Array) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    return "";
}

function responseHeaders(headers: Headers) {
    const result = new Headers();
    ["content-type", "content-length", "cache-control", "etag", "last-modified"].forEach((key) => {
        const value = headers.get(key);
        if (value) result.set(key, value);
    });
    return result;
}
