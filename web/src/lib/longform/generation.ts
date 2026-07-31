import { composeShotPrompt } from "@/lib/longform/script";
import { extractVideoFrame, concatVideos } from "@/lib/media/ffmpeg-frames";
import { requestGeneration, requestImageQuestion } from "@/services/api/image";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, type VideoFrameOptions } from "@/services/api/video";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { LongformMediaRef, LongformProject, LongformShot } from "@/types/longform";
import { SCRIPT_TO_SHOTS_SYSTEM, buildScriptToShotsUserMessage, parseLlmShotResponse } from "@/lib/longform/script";

export async function structureScriptWithLlm(config: AiConfig, project: Pick<LongformProject, "scriptRaw" | "styleBible" | "characterBible">, onDelta?: (text: string) => void) {
    const answer = await requestImageQuestion(
        config,
        [
            { role: "system", content: SCRIPT_TO_SHOTS_SYSTEM },
            { role: "user", content: buildScriptToShotsUserMessage({ script: project.scriptRaw, styleBible: project.styleBible, characterBible: project.characterBible }) },
        ],
        onDelta || (() => undefined),
    );
    return parseLlmShotResponse(answer);
}

export async function mediaRefToReferenceImage(media: LongformMediaRef, name = "frame.jpg"): Promise<ReferenceImage> {
    const dataUrl = await imageToDataUrl({ url: media.url, storageKey: media.storageKey });
    if (!dataUrl) throw new Error("无法读取帧图片");
    return {
        id: media.storageKey || name,
        name,
        type: media.mimeType || "image/jpeg",
        dataUrl,
        url: media.url,
        storageKey: media.storageKey,
    };
}

export async function blobToMediaRef(blob: Blob, prefix: "image" | "video"): Promise<LongformMediaRef> {
    if (prefix === "image") {
        const uploaded = await uploadImage(blob);
        return { storageKey: uploaded.storageKey, url: uploaded.url, width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType };
    }
    const uploaded = await uploadMediaFile(blob, "video");
    return { storageKey: uploaded.storageKey, url: uploaded.url, width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType };
}

export async function resolveShotVideoBlob(shot: LongformShot) {
    if (!shot.video) throw new Error("镜头尚未生成视频");
    if (shot.video.storageKey) {
        const blob = await getMediaBlob(shot.video.storageKey);
        if (blob) return blob;
    }
    if (shot.video.url) {
        const response = await fetch(shot.video.url);
        if (!response.ok) throw new Error("读取镜头视频失败");
        return response.blob();
    }
    throw new Error("镜头视频不可用");
}

export async function extractShotFrame(shot: LongformShot, position: "first" | "last"): Promise<LongformMediaRef> {
    const blob = await resolveShotVideoBlob(shot);
    const frame = await extractVideoFrame(blob, position);
    return blobToMediaRef(frame, "image");
}

function buildImageConfig(config: AiConfig, project?: Pick<LongformProject, "aspectRatio">): AiConfig {
    return {
        ...config,
        model: config.imageModel || config.model,
        count: "1",
        ...(project?.aspectRatio ? { size: project.aspectRatio } : {}),
    };
}

/** 仅生成镜头首帧图，不触发出视频。 */
export async function generateShotFirstFrame(config: AiConfig, project: LongformProject, shot: LongformShot, signal?: AbortSignal): Promise<LongformMediaRef> {
    const prompt = composeShotPrompt(project.styleBible, project.characterBible, shot) || shot.prompt || shot.action;
    if (!prompt.trim()) throw new Error("请先填写镜头动作或提示词");
    const imageConfig = buildImageConfig(config, project);
    const images = await requestGeneration(imageConfig, prompt, { signal });
    const first = images[0] as { dataUrl?: string; storageKey?: string; url?: string; width?: number; height?: number; mimeType?: string };
    if (!first?.dataUrl && !first?.storageKey && !first?.url) throw new Error("首帧生成失败");
    const dataUrl = first.dataUrl || (first.storageKey ? await resolveImageUrl(first.storageKey) : first.url) || "";
    if (!dataUrl) throw new Error("首帧没有可用图片");
    if (first.storageKey) {
        return { storageKey: first.storageKey, url: first.url || dataUrl, width: first.width, height: first.height, mimeType: first.mimeType };
    }
    return blobToMediaRef(await dataUrlToBlob(dataUrl), "image");
}

/** 选出需要出首帧的镜头：默认只补缺失；force 时全部重出。 */
export function selectShotsForFirstFrame(shots: LongformShot[], mode: "missing" | "all" = "missing") {
    const sorted = [...shots].sort((a, b) => a.index - b.index);
    if (mode === "all") return sorted.filter((shot) => Boolean((shot.action || shot.prompt || shot.scene).trim()));
    return sorted.filter((shot) => !shot.firstFrame && Boolean((shot.action || shot.prompt || shot.scene).trim()));
}

/** 选出可出视频的镜头：有提示词，且（建议）已有首帧或允许纯文生。 */
export function selectShotsForVideo(shots: LongformShot[], mode: "missing" | "framed" = "framed") {
    const sorted = [...shots].sort((a, b) => a.index - b.index);
    return sorted.filter((shot) => {
        if (shot.status === "ready" && shot.video) return false;
        if (!(shot.prompt || shot.action || shot.scene).trim()) return false;
        if (mode === "framed") return Boolean(shot.firstFrame);
        return true;
    });
}

async function dataUrlToBlob(dataUrl: string) {
    if (dataUrl.startsWith("data:")) {
        const response = await fetch(dataUrl);
        return response.blob();
    }
    if (/^https?:\/\//i.test(dataUrl)) {
        const response = await fetch(dataUrl);
        return response.blob();
    }
    // bare base64
    const response = await fetch(`data:image/png;base64,${dataUrl}`);
    return response.blob();
}

function buildVideoConfig(config: AiConfig, project: LongformProject, shot: LongformShot): AiConfig {
    return {
        ...config,
        model: config.videoModel || config.model,
        size: project.aspectRatio || config.size,
        vquality: project.resolution || config.vquality,
        videoSeconds: String(shot.durationSec || 5),
        videoFrameRate: String(project.fps || 24),
        videoNegativePrompt: shot.negativePrompt || config.videoNegativePrompt,
        videoSeed: shot.seed != null ? String(shot.seed) : config.videoSeed,
        agnesVideoMode: shot.firstFrame && shot.lastFrame ? "keyframes" : "ti2vid",
    };
}

export async function generateShotVideo(config: AiConfig, project: LongformProject, shot: LongformShot, options?: { signal?: AbortSignal; onStatus?: (text: string) => void }): Promise<LongformMediaRef> {
    const prompt = composeShotPrompt(project.styleBible, project.characterBible, shot) || shot.prompt;
    if (!prompt.trim()) throw new Error("请先填写镜头提示词");
    const videoConfig = buildVideoConfig(config, project, shot);
    const frames: VideoFrameOptions = {};
    if (shot.firstFrame) frames.firstFrame = await mediaRefToReferenceImage(shot.firstFrame, "first-frame.jpg");
    if (shot.lastFrame) frames.lastFrame = await mediaRefToReferenceImage(shot.lastFrame, "last-frame.jpg");
    options?.onStatus?.("提交视频任务…");
    const task = await createVideoGenerationTask(videoConfig, prompt, [], [], [], { signal: options?.signal, ...frames });
    const delayMs = task.provider === "seedance" || task.provider === "agnes" ? 5000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        options?.onStatus?.(`生成中（${attempt + 1}）…`);
        const state = await pollVideoGenerationTask(videoConfig, task, { signal: options?.signal });
        if (state.status === "completed") {
            const uploaded = await storeGeneratedVideo(state.result);
            return { storageKey: uploaded.storageKey, url: uploaded.url, width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType };
        }
        if (state.status === "failed") throw new Error(state.error);
        await delay(delayMs, options?.signal);
    }
    throw new Error("镜头视频生成超时");
}

export async function assembleProjectVideos(project: LongformProject): Promise<LongformMediaRef> {
    const ready = [...project.shots].sort((a, b) => a.index - b.index).filter((shot) => shot.status === "ready" && shot.video);
    if (ready.length < 1) throw new Error("至少需要 1 个已完成镜头才能拼接");
    const clips: Blob[] = [];
    for (const shot of ready) {
        clips.push(await resolveShotVideoBlob(shot));
    }
    const output = await concatVideos(clips);
    return blobToMediaRef(output, "video");
}

export async function resolveMediaDisplayUrl(media?: LongformMediaRef) {
    if (!media) return "";
    if (media.storageKey) {
        if (media.storageKey.startsWith("image:")) return resolveImageUrl(media.storageKey, media.url || "");
        return resolveMediaUrl(media.storageKey, media.url || "");
    }
    return media.url || "";
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
