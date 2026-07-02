import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LITTERBOX_ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";
const TEMPORARY_MEDIA_TTL = "1h";
const UPLOAD_TIMEOUT_MS = 60000;

export async function POST(request: NextRequest) {
    const file = (await request.formData()).get("file");
    if (!(file instanceof File)) return Response.json({ code: 1, msg: "Missing file" }, { status: 400 });

    const formData = new FormData();
    formData.set("reqtype", "fileupload");
    formData.set("time", TEMPORARY_MEDIA_TTL);
    formData.set("fileToUpload", file, file.name || "reference.png");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(LITTERBOX_ENDPOINT, { method: "POST", body: formData, signal: controller.signal });
        const text = (await response.text()).trim();
        if (!response.ok) return Response.json({ code: 1, msg: `上传参考图失败：${response.status}` }, { status: response.status });
        if (!/^https?:\/\//i.test(text)) return Response.json({ code: 1, msg: `上传参考图失败：${text}` }, { status: 502 });
        return Response.json({ code: 0, data: { url: text }, url: text });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return Response.json({ code: 1, msg: "上传参考图超时" }, { status: 504 });
        return Response.json({ code: 1, msg: error instanceof Error ? error.message : "上传参考图失败" }, { status: 502 });
    } finally {
        clearTimeout(timer);
    }
}
