import { nanoid } from "nanoid";

import type { LongformShot, LongformShotDraft } from "@/types/longform";

const DURATION_OPTIONS = [3, 5, 10, 18] as const;

export function normalizeDurationSec(value: unknown, fallback = 5) {
    const number = Math.round(Number(value) || fallback);
    if (DURATION_OPTIONS.includes(number as (typeof DURATION_OPTIONS)[number])) return number;
    if (number <= 3) return 3;
    if (number <= 6) return 5;
    if (number <= 12) return 10;
    return 18;
}

export function createEmptyShot(index: number, draft: LongformShotDraft = {}): LongformShot {
    const action = (draft.action || "").trim();
    const scene = (draft.scene || "").trim();
    const title = (draft.title || "").trim() || `镜头 ${index + 1}`;
    const prompt = (draft.prompt || "").trim() || buildShotPromptParts({ scene, action, camera: draft.camera, dialogue: draft.dialogue });
    return {
        id: nanoid(),
        index,
        title,
        scene,
        action,
        dialogue: draft.dialogue?.trim() || undefined,
        camera: draft.camera?.trim() || undefined,
        durationSec: normalizeDurationSec(draft.durationSec),
        prompt,
        negativePrompt: draft.negativePrompt?.trim() || undefined,
        status: "draft",
    };
}

export function buildShotPromptParts(parts: { styleBible?: string; characterBible?: string; scene?: string; action?: string; camera?: string; dialogue?: string; prompt?: string }) {
    const lines: string[] = [];
    if (parts.styleBible?.trim()) lines.push(`风格：${parts.styleBible.trim()}`);
    if (parts.characterBible?.trim()) lines.push(`角色：${parts.characterBible.trim()}`);
    if (parts.scene?.trim()) lines.push(`场景：${parts.scene.trim()}`);
    if (parts.action?.trim()) lines.push(`动作：${parts.action.trim()}`);
    if (parts.camera?.trim()) lines.push(`运镜：${parts.camera.trim()}`);
    if (parts.dialogue?.trim()) lines.push(`对白：${parts.dialogue.trim()}`);
    if (parts.prompt?.trim() && !lines.some((line) => line.includes(parts.prompt!.trim()))) {
        lines.push(parts.prompt.trim());
    }
    return lines.join("\n").trim();
}

export function composeShotPrompt(styleBible: string, characterBible: string, shot: Pick<LongformShot, "scene" | "action" | "camera" | "dialogue" | "prompt">) {
    const base = buildShotPromptParts({
        styleBible,
        characterBible,
        scene: shot.scene,
        action: shot.action,
        camera: shot.camera,
        dialogue: shot.dialogue,
    });
    const custom = shot.prompt.trim();
    if (!custom) return base;
    if (!base) return custom;
    if (custom.includes(shot.action) || custom.includes(shot.scene)) return [styleBible && `风格：${styleBible}`, characterBible && `角色：${characterBible}`, custom].filter(Boolean).join("\n");
    return `${base}\n${custom}`;
}

/** 从 JSON / Markdown / 纯文本解析分镜草稿。 */
export function parseScriptToShotDrafts(raw: string): LongformShotDraft[] {
    const text = raw.trim();
    if (!text) return [];

    const fromJson = tryParseJsonShots(text);
    if (fromJson?.length) return fromJson;

    const fromMarkdown = parseMarkdownShots(text);
    if (fromMarkdown.length) return fromMarkdown;

    return parsePlainParagraphs(text);
}

function tryParseJsonShots(text: string): LongformShotDraft[] | null {
    const candidates = [text, extractJsonBlock(text)].filter(Boolean) as string[];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { shots?: unknown }).shots) ? (parsed as { shots: unknown[] }).shots : null;
            if (!list?.length) continue;
            const drafts = list.map(normalizeDraftObject).filter((item) => item.action || item.prompt || item.scene || item.title);
            if (drafts.length) return drafts;
        } catch {
            // continue
        }
    }
    return null;
}

function extractJsonBlock(text: string) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = text.indexOf("{");
    const startArr = text.indexOf("[");
    const from = start >= 0 && (startArr < 0 || start < startArr) ? start : startArr;
    if (from < 0) return "";
    const endObj = text.lastIndexOf("}");
    const endArr = text.lastIndexOf("]");
    const end = Math.max(endObj, endArr);
    if (end <= from) return "";
    return text.slice(from, end + 1);
}

function normalizeDraftObject(value: unknown): LongformShotDraft {
    if (!value || typeof value !== "object") return {};
    const item = value as Record<string, unknown>;
    return {
        title: str(item.title || item.name || item.shot),
        scene: str(item.scene || item.location || item.setting),
        action: str(item.action || item.description || item.content || item.visual),
        dialogue: str(item.dialogue || item.dialog || item.line),
        camera: str(item.camera || item.shot_type || item.movement),
        durationSec: item.durationSec != null ? Number(item.durationSec) : item.duration != null ? Number(item.duration) : item.seconds != null ? Number(item.seconds) : undefined,
        prompt: str(item.prompt || item.video_prompt),
        negativePrompt: str(item.negativePrompt || item.negative_prompt),
    };
}

function parseMarkdownShots(text: string): LongformShotDraft[] {
    const blocks = text.split(/\n(?=#{1,3}\s+|镜头\s*\d+|Shot\s*\d+|^\d+[\.、]\s+)/i).map((block) => block.trim()).filter(Boolean);
    if (blocks.length < 2 && !/镜头|Shot\s*\d+/i.test(text)) return [];
    const drafts = blocks.map((block) => {
        const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const title = lines[0]?.replace(/^#{1,3}\s+/, "").replace(/^(镜头|Shot)\s*\d+[:：.\s-]*/i, "").trim() || lines[0];
        const fields: Record<string, string> = {};
        const body: string[] = [];
        for (const line of lines.slice(1)) {
            const match = line.match(/^(场景|动作|对白|运镜|提示词|prompt|scene|action|dialogue|camera)\s*[:：]\s*(.+)$/i);
            if (match) {
                fields[match[1].toLowerCase()] = match[2].trim();
            } else {
                body.push(line);
            }
        }
        return {
            title,
            scene: fields["场景"] || fields.scene || "",
            action: fields["动作"] || fields.action || body.join(" "),
            dialogue: fields["对白"] || fields.dialogue || "",
            camera: fields["运镜"] || fields.camera || "",
            prompt: fields["提示词"] || fields.prompt || "",
            durationSec: 5,
        } satisfies LongformShotDraft;
    });
    return drafts.filter((item) => item.action || item.prompt || item.scene);
}

function parsePlainParagraphs(text: string): LongformShotDraft[] {
    const parts = text
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter((part) => part.length > 8);
    if (parts.length >= 2) {
        return parts.map((action, index) => ({ title: `镜头 ${index + 1}`, action, durationSec: 5 }));
    }
    const sentences = text
        .split(/[。！？\n]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 6);
    return sentences.slice(0, 12).map((action, index) => ({ title: `镜头 ${index + 1}`, action, durationSec: 5 }));
}

export const SCRIPT_TO_SHOTS_SYSTEM = `你是影视分镜编剧。把用户给的剧本/梗概拆成可执行的短镜头列表。
硬性要求：
1. 只输出一个 JSON 对象，不要 Markdown 说明。
2. schema:
{
  "styleBible": "整体风格一句话",
  "characterBible": "主要角色外貌服装一句话",
  "shots": [
    {
      "title": "镜头标题",
      "scene": "场景",
      "action": "画面动作（具体可视）",
      "dialogue": "对白可选",
      "camera": "运镜可选",
      "durationSec": 3|5|10|18,
      "prompt": "给视频模型的英文或中文提示词，含画面与运动"
    }
  ]
}
3. 每个镜头时长 3/5/10/18 秒之一，优先 5 秒；总镜数 3–12。
4. action 与 prompt 必须具体，避免空泛形容词。`;

export function buildScriptToShotsUserMessage(input: { script: string; styleBible?: string; characterBible?: string; targetSeconds?: number }) {
    const lines = [`请将以下内容拆成结构化分镜 JSON。`];
    if (input.targetSeconds) lines.push(`目标成片大约 ${input.targetSeconds} 秒。`);
    if (input.styleBible?.trim()) lines.push(`已有风格设定：${input.styleBible.trim()}`);
    if (input.characterBible?.trim()) lines.push(`已有角色设定：${input.characterBible.trim()}`);
    lines.push("", "原文：", input.script.trim());
    return lines.join("\n");
}

export function parseLlmShotResponse(raw: string): { styleBible?: string; characterBible?: string; shots: LongformShotDraft[] } {
    const drafts = tryParseJsonShots(raw);
    if (!drafts?.length) {
        const fallback = parseScriptToShotDrafts(raw);
        return { shots: fallback };
    }
    let styleBible: string | undefined;
    let characterBible: string | undefined;
    try {
        const parsed = JSON.parse(extractJsonBlock(raw) || raw) as { styleBible?: string; characterBible?: string };
        styleBible = str(parsed.styleBible);
        characterBible = str(parsed.characterBible);
    } catch {
        // ignore
    }
    return { styleBible, characterBible, shots: drafts };
}

function str(value: unknown) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
