import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

export type FramePosition = "first" | "last" | number;

type ConcatOptions = {
    /** MVP 仅硬切 */
    transitions?: "none";
};

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let busy = Promise.resolve();

async function getFFmpeg() {
    if (ffmpegInstance?.loaded) return ffmpegInstance;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        const ffmpeg = new FFmpeg();
        await ffmpeg.load({
            coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
        });
        ffmpegInstance = ffmpeg;
        return ffmpeg;
    })().catch((error) => {
        loadPromise = null;
        throw error instanceof Error ? error : new Error("ffmpeg.wasm 加载失败");
    });
    return loadPromise;
}

function withFFmpegQueue<T>(task: (ffmpeg: FFmpeg) => Promise<T>) {
    const run = busy.then(async () => {
        const ffmpeg = await getFFmpeg();
        return task(ffmpeg);
    });
    busy = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function extForMime(mime: string, fallback: string) {
    if (mime.includes("webm")) return "webm";
    if (mime.includes("quicktime") || mime.includes("mov")) return "mov";
    if (mime.includes("png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("mp4") || mime.includes("mpeg")) return "mp4";
    return fallback;
}

/**
 * 从视频 Blob 抽取一帧为 JPEG。
 * position: "first" | "last" | 秒数（从片头起）。
 */
export async function extractVideoFrame(file: Blob, position: FramePosition = "first"): Promise<Blob> {
    return withFFmpegQueue(async (ffmpeg) => {
        const inputName = `input.${extForMime(file.type, "mp4")}`;
        const outputName = "frame.jpg";
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        try {
            const args =
                position === "first"
                    ? ["-i", inputName, "-vf", "select=eq(n\\,0)", "-vframes", "1", "-q:v", "2", outputName]
                    : position === "last"
                      ? ["-sseof", "-0.05", "-i", inputName, "-frames:v", "1", "-q:v", "2", outputName]
                      : ["-ss", String(Math.max(0, position)), "-i", inputName, "-frames:v", "1", "-q:v", "2", outputName];
            const code = await ffmpeg.exec(args);
            if (code !== 0) throw new Error(`抽帧失败（ffmpeg exit ${code}）`);
            const data = await ffmpeg.readFile(outputName);
            if (typeof data === "string") throw new Error("抽帧结果异常");
            return new Blob([Uint8Array.from(data)], { type: "image/jpeg" });
        } finally {
            await safeDelete(ffmpeg, inputName, outputName);
        }
    });
}

/** 按顺序硬切拼接多段视频，输出 mp4。 */
export async function concatVideos(clips: Blob[], _options: ConcatOptions = {}): Promise<Blob> {
    if (!clips.length) throw new Error("至少需要一段视频才能拼接");
    if (clips.length === 1) return clips[0];

    return withFFmpegQueue(async (ffmpeg) => {
        const inputNames: string[] = [];
        const listName = "concat.txt";
        const outputName = "output.mp4";
        try {
            for (let index = 0; index < clips.length; index += 1) {
                const name = `clip_${index}.${extForMime(clips[index].type, "mp4")}`;
                inputNames.push(name);
                await ffmpeg.writeFile(name, await fetchFile(clips[index]));
            }
            const listBody = inputNames.map((name) => `file '${name}'`).join("\n");
            await ffmpeg.writeFile(listName, listBody);

            // 优先 demuxer 直拼；失败则统一 re-encode
            let code = await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", outputName]);
            if (code !== 0) {
                await safeDelete(ffmpeg, outputName);
                code = await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", listName, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", outputName]);
            }
            if (code !== 0) throw new Error(`视频拼接失败（ffmpeg exit ${code}）`);
            const data = await ffmpeg.readFile(outputName);
            if (typeof data === "string") throw new Error("拼接结果异常");
            return new Blob([Uint8Array.from(data)], { type: "video/mp4" });
        } finally {
            await safeDelete(ffmpeg, listName, outputName, ...inputNames);
        }
    });
}

/** 预加载 ffmpeg 核心（可在进入长片页时调用）。 */
export function preloadFfmpeg() {
    return getFFmpeg();
}

async function safeDelete(ffmpeg: FFmpeg, ...names: string[]) {
    await Promise.all(
        names.map(async (name) => {
            try {
                await ffmpeg.deleteFile(name);
            } catch {
                // ignore missing files
            }
        }),
    );
}
