import { extractVideoFrame, concatVideos } from "@/lib/media/ffmpeg-frames";
import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, type VideoFrameOptions } from "@/services/api/video";
import { getMediaBlob, proxiedMediaUrl, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { LongformCharacter, LongformMediaRef, LongformProject, LongformScene, LongformShot, LongformShotDraft } from "@/types/longform";
import { charactersToBibleText, composeGenerationPrompt, normalizeDurationSec, parseStoryboardFromJsonText, resolveProjectCharacters, resolveShotCharacters } from "@/lib/longform/script";

/**
 * LLM 辅助撰写：按用户自己的要求润色/扩写剧本正文。
 * 结构化分镜请用「解析导入」（LLM 解析任意格式剧本）。
 */
export async function assistWriteLongform(
    config: AiConfig,
    input: {
        /** 用户自己的撰写要求，可空则仅润色已有文稿 */
        instruction?: string;
        scriptRaw?: string;
        styleBible?: string;
        characters?: LongformProject["characters"];
        scenes?: LongformProject["scenes"];
    },
    onDelta?: (text: string) => void,
) {
    const instruction = (input.instruction || "").trim() || "请根据已有素材润色并扩写为可直接使用的长片剧本/分镜文案，人物出场写清楚。";
    const chunks: string[] = [instruction, "直接输出正文，不要解释写作过程。"];
    if (input.styleBible?.trim()) chunks.push(`风格参考：\n${input.styleBible.trim()}`);
    const characterText = input.characters?.length ? charactersToBibleText(input.characters) : "";
    if (characterText) chunks.push(`角色参考：\n${characterText}`);
    if (input.scenes?.length) chunks.push(`场景参考：\n${input.scenes.map((item) => `${item.name}: ${item.description}`).join("\n")}`);
    if (input.scriptRaw?.trim()) chunks.push(`现有文稿：\n${input.scriptRaw.trim()}`);
    if (chunks.length <= 2 && !input.scriptRaw?.trim()) {
        throw new Error("请先填写撰写要求或现有文稿");
    }
    return requestImageQuestion(config, [{ role: "user", content: chunks.join("\n\n") }], onDelta || (() => undefined));
}

/**
 * 用 LLM 将任意格式剧本解析为结构化分镜（不再做本地 Markdown/JSON/纯文本启发式解析）。
 */
export async function parseLongformScriptWithLlm(
    config: AiConfig,
    input: {
        scriptRaw: string;
        styleBible?: string;
        characters?: LongformProject["characters"];
        scenes?: LongformProject["scenes"];
    },
): Promise<{
    styleBible?: string;
    characters: LongformCharacter[];
    scenes: LongformScene[];
    shots: LongformShotDraft[];
}> {
    const raw = input.scriptRaw.trim();
    if (!raw) throw new Error("请先粘贴剧本或分镜文本");

    const contextParts: string[] = [];
    if (input.styleBible?.trim()) contextParts.push(`已有风格圣经（可沿用或微调）：\n${input.styleBible.trim()}`);
    const characterText = input.characters?.length ? charactersToBibleText(input.characters) : "";
    if (characterText) contextParts.push(`已有角色表（可合并补全）：\n${characterText}`);
    if (input.scenes?.length) contextParts.push(`已有场景表（优先复用同名场景）：\n${input.scenes.map((item) => `${item.name}: ${item.description}`).join("\n")}`);

    const schemaHint = [
        "请把下面的剧本/分镜文案解析为结构化 JSON，供长片分镜表使用。",
        "接受任意格式：纯叙述、对白剧本、大纲、Markdown、JSON、表格等，按叙事自然切镜，不要漏镜，也不要为前言/大纲单独造空镜。",
        "只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏。",
        '格式：{"styleBible":"全片风格","characters":[{"name":"姓名","appearance":"稳定外貌与服装"}],"scenes":[{"name":"唯一场景名","description":"空间结构、陈设、色彩、时间与光线"}],"shots":[{"title":"镜头标题","sceneName":"场景表中的名称","scene":"本镜环境补充","action":"主体与动作","dialogue":"对白可选","camera":"景别、机位与构图","durationSec":5,"prompt":"画质与必要补充要求","characterNames":["出场角色名"]}]}',
        "规则：shots 至少 1 条；durationSec 为 1–18 的整数，缺省 5；相同地点必须复用同一个 sceneName；characterNames 只填画面中实际出现的人物；appearance 与 description 只写稳定、可见、可复现的特征。",
        "生图信息按主体、场景/环境、风格、光照、构图、质量要求拆入对应字段，不要把全部信息堆进 prompt，也不要臆造原文没有的专有外貌或陈设。",
    ].join("\n");

    const userContent = [schemaHint, ...contextParts, `剧本原文：\n${raw}`].join("\n\n");
    const answer = await requestImageQuestion(config, [{ role: "user", content: userContent }], () => undefined);
    const structured = parseStoryboardFromJsonText(answer, { existingCharacters: input.characters, existingScenes: input.scenes });
    if (!structured?.shots.length) {
        throw new Error("模型未返回有效分镜 JSON，请重试或精简剧本后再解析");
    }
    return structured;
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

/** 本镜出场角色的参考图（有图才带），用于出首帧/视频保持人物一致。 */
export async function collectShotCharacterReferences(project: LongformProject, shot: LongformShot): Promise<ReferenceImage[]> {
    const characters = resolveShotCharacters(resolveProjectCharacters(project), shot);
    const refs: ReferenceImage[] = [];
    const seen = new Set<string>();
    for (const item of characters) {
        const media = item.reference;
        if (!media?.storageKey && !media?.url) continue;
        const key = media.storageKey || media.url || "";
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const name = `${(item.name || "character").trim() || "character"}.jpg`;
        refs.push(await mediaRefToReferenceImage(media, name));
    }
    return refs;
}

/** 本镜人物 + 绑定场景参考图，供图生图和多图合成保持一致。 */
export async function collectShotReferences(project: LongformProject, shot: LongformShot): Promise<ReferenceImage[]> {
    const refs = await collectShotCharacterReferences(project, shot);
    const scene = project.scenes?.find((item) => item.id === shot.sceneId);
    if (scene?.reference?.storageKey || scene?.reference?.url) refs.push(await mediaRefToReferenceImage(scene.reference, `${scene.name || "scene"}.jpg`));
    const seen = new Set<string>();
    return refs.filter((item) => {
        const key = item.storageKey || item.url || item.dataUrl;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export async function blobToMediaRef(blob: Blob, prefix: "image" | "video"): Promise<LongformMediaRef> {
    if (prefix === "image") {
        const uploaded = await uploadImage(blob);
        return { storageKey: uploaded.storageKey, url: uploaded.url, width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType };
    }
    const uploaded = await uploadMediaFile(blob, "video");
    return { storageKey: uploaded.storageKey, url: uploaded.url, width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType };
}

/** 远程 URL（含 Agnes platform-outputs）经同源代理入库，避免浏览器 CORS。 */
export async function storeImageSourceAsMediaRef(source: string | Blob): Promise<LongformMediaRef> {
    const uploaded = await uploadImage(source);
    return { storageKey: uploaded.storageKey, url: uploaded.url, width: uploaded.width, height: uploaded.height, mimeType: uploaded.mimeType };
}

export async function resolveShotVideoBlob(shot: LongformShot) {
    if (!shot.video) throw new Error("镜头尚未生成视频");
    if (shot.video.storageKey) {
        const blob = await getMediaBlob(shot.video.storageKey);
        if (blob) return blob;
    }
    if (shot.video.url) {
        const response = await fetch(proxiedMediaUrl(shot.video.url));
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

/** 仅生成镜头首帧图，不触发出视频。风格/本镜角色圣经强制注入；有角色参考图时走图生图。 */
export async function generateShotFirstFrame(config: AiConfig, project: LongformProject, shot: LongformShot, signal?: AbortSignal): Promise<LongformMediaRef> {
    const prompt = composeGenerationPrompt(project, shot, "image");
    if (!prompt.trim()) throw new Error("请先填写镜头动作或提示词");
    const imageConfig = buildImageConfig(config, project);
    const references = await collectShotReferences(project, shot);
    const editPrompt = references.length
        ? [
            "[改变要求] 根据本镜动作生成新的电影首帧",
            `[新风格 / 场景] ${project.styleBible}; ${shot.scene}`,
            `[需要添加或移除的元素] ${shot.action}`,
            "[需要保留的元素] 参考图中的人物身份、外貌、服装，以及场景空间结构、陈设与色彩必须保持一致",
            prompt,
        ].join("\n")
        : prompt;
    const images = references.length
        ? await requestEdit(imageConfig, editPrompt, references, undefined, { signal })
        : await requestGeneration(imageConfig, prompt, { signal });
    const first = images[0] as { dataUrl?: string; storageKey?: string; url?: string; width?: number; height?: number; mimeType?: string };
    if (!first?.dataUrl && !first?.storageKey && !first?.url) throw new Error("首帧生成失败");
    if (first.storageKey) {
        return {
            storageKey: first.storageKey,
            url: first.url || (await resolveImageUrl(first.storageKey)) || "",
            width: first.width,
            height: first.height,
            mimeType: first.mimeType,
        };
    }
    const source = first.dataUrl || first.url || "";
    if (!source) throw new Error("首帧没有可用图片");
    // uploadImage 对远程 URL 走 /agnes-outputs 等代理，避免 platform-outputs CORS
    return storeImageSourceAsMediaRef(source);
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

function buildVideoConfig(config: AiConfig, project: LongformProject, shot: LongformShot): AiConfig {
    // 严格按本镜 durationSec，默认 5s；不读全局 config.videoSeconds，避免整批被设成 18s
    const durationSec = normalizeDurationSec(shot.durationSec);
    return {
        ...config,
        model: config.videoModel || config.model,
        size: project.aspectRatio || config.size,
        vquality: project.resolution || config.vquality,
        videoSeconds: String(durationSec),
        videoFrameRate: String(project.fps || 24),
        videoNegativePrompt: shot.negativePrompt || config.videoNegativePrompt,
        videoSeed: shot.seed != null ? String(shot.seed) : config.videoSeed,
        agnesVideoMode: shot.firstFrame && shot.lastFrame ? "keyframes" : "ti2vid",
    };
}

export async function generateShotVideo(config: AiConfig, project: LongformProject, shot: LongformShot, options?: { signal?: AbortSignal; onStatus?: (text: string) => void }): Promise<LongformMediaRef> {
    const prompt = composeGenerationPrompt(project, shot, "video");
    if (!prompt.trim()) throw new Error("请先填写镜头提示词");
    const videoConfig = buildVideoConfig(config, project, shot);
    const frames: VideoFrameOptions = {};
    if (shot.firstFrame) frames.firstFrame = await mediaRefToReferenceImage(shot.firstFrame, "first-frame.jpg");
    if (shot.lastFrame) frames.lastFrame = await mediaRefToReferenceImage(shot.lastFrame, "last-frame.jpg");
    // 无首帧时直接带人物与场景参考；有首帧时以已融合一致性参考的首帧为主。
    const shotRefs = shot.firstFrame ? [] : await collectShotReferences(project, shot);
    options?.onStatus?.("提交视频任务…");
    const task = await createVideoGenerationTask(videoConfig, prompt, shotRefs, [], [], { signal: options?.signal, ...frames });
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
    return media.url ? proxiedMediaUrl(media.url) : "";
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
