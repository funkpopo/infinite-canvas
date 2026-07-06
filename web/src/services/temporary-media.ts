const LITTERBOX_ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";
const TEMPORARY_MEDIA_TTL = "1h";
const UPLOAD_TIMEOUT_MS = 60000;

export async function uploadTemporaryPublicMedia(file: Blob, filename = "reference.png") {
    const formData = new FormData();
    formData.set("reqtype", "fileupload");
    formData.set("time", TEMPORARY_MEDIA_TTL);
    formData.set("fileToUpload", file, filename);

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(LITTERBOX_ENDPOINT, { method: "POST", body: formData, signal: controller.signal });
        const text = (await response.text()).trim();
        if (!response.ok) throw new Error(`上传参考图失败：${response.status}`);
        if (!/^https?:\/\//i.test(text)) throw new Error(`上传参考图失败：${text}`);
        return text;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("上传参考图超时");
        throw error instanceof Error ? error : new Error("上传参考图失败");
    } finally {
        clearTimeout(timer);
    }
}
