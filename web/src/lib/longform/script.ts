import { nanoid } from "nanoid";

import type { LongformCharacter, LongformProject, LongformShot, LongformShotDraft } from "@/types/longform";

/** 常用预设（秒）；实际可取 1–18，按镜独立设置。 */
export const LONGFORM_DURATION_OPTIONS = [3, 5, 10, 18] as const;

/** 单镜时长：默认 5s，钳制在 1–18，不强制归并到 18。 */
export function normalizeDurationSec(value: unknown, fallback = 5) {
    if (value == null || value === "") return fallback;
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.max(1, Math.min(18, number));
}

export function createEmptyCharacter(partial: Partial<LongformCharacter> = {}): LongformCharacter {
    const name = (partial.name || "").trim();
    return {
        id: partial.id || characterIdFromName(name || nanoid(6)),
        name,
        appearance: (partial.appearance || "").trim(),
        note: partial.note?.trim() || undefined,
    };
}

export function characterIdFromName(name: string) {
    const key = name.trim().toLowerCase().replace(/\s+/g, "-");
    return `char:${key || nanoid(6)}`;
}

export function createEmptyShot(index: number, draft: LongformShotDraft = {}): LongformShot {
    const action = (draft.action || "").trim();
    const scene = (draft.scene || "").trim();
    const title = (draft.title || "").trim();
    const prompt = (draft.prompt || "").trim() || buildShotBodyText({ scene, action, camera: draft.camera, dialogue: draft.dialogue });
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
        characterIds: draft.characterIds?.length ? draft.characterIds : undefined,
        status: "draft",
    };
}

/** 项目角色表；仅使用 characters，不再回退其它字段。 */
export function resolveProjectCharacters(project: Pick<LongformProject, "characters">): LongformCharacter[] {
    return Array.isArray(project.characters) ? project.characters.map((item) => createEmptyCharacter(item)) : [];
}

/** 自由文本角色列表：`姓名：外貌` 每行一条；用于导入解析，不作为项目持久化字段。 */
export function parseCharacterLines(text: string): LongformCharacter[] {
    const raw = text.trim();
    if (!raw) return [];
    const lines = raw
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    const structured = lines
        .map((line) => {
            const match = line.match(/^(?:\d+[\.、)\s]*)?([^:：\-–—|｜]{1,48})\s*[:：\-–—|｜]\s*(.+)$/);
            if (match) return createEmptyCharacter({ name: match[1].trim(), appearance: match[2].trim() });
            return null;
        })
        .filter((item): item is LongformCharacter => Boolean(item));
    if (structured.length) return dedupeCharacters(structured);
    if (lines.length >= 2) {
        return dedupeCharacters(lines.map((line) => createEmptyCharacter({ name: line.slice(0, 24), appearance: line })));
    }
    return [createEmptyCharacter({ name: "", appearance: raw })];
}

export function charactersToBibleText(characters: LongformCharacter[]) {
    return characters
        .filter((item) => item.name.trim() || item.appearance.trim())
        .map((item) => {
            const name = item.name.trim();
            const appearance = item.appearance.trim();
            if (name && appearance) return `${name}: ${appearance}`;
            return name || appearance;
        })
        .join("\n");
}

/**
 * 本镜角色：
 * 1) 显式 characterIds
 * 2) 文案命中角色名
 * 3) 否则全部
 */
export function resolveShotCharacters(
    characters: LongformCharacter[],
    shot?: Pick<LongformShot, "characterIds" | "title" | "scene" | "action" | "dialogue" | "prompt" | "camera"> | null,
): LongformCharacter[] {
    if (!characters.length) return [];
    if (shot?.characterIds?.length) {
        const set = new Set(shot.characterIds);
        const selected = characters.filter((item) => set.has(item.id));
        if (selected.length) return selected;
    }
    const haystack = [shot?.title, shot?.scene, shot?.action, shot?.dialogue, shot?.camera, shot?.prompt].filter(Boolean).join("\n");
    if (haystack) {
        const matched = matchCharactersInText(characters, haystack);
        if (matched.length) return matched;
    }
    return characters;
}

export function matchCharactersInText(characters: LongformCharacter[], text: string) {
    const haystack = text || "";
    const sorted = [...characters].sort((a, b) => b.name.length - a.name.length);
    const hit: LongformCharacter[] = [];
    for (const item of sorted) {
        const name = item.name.trim();
        if (name.length < 1) continue;
        if (haystack.includes(name)) hit.push(item);
    }
    return hit;
}

/** 镜头字段拼成纯文本，不加指令套话。 */
export function buildShotBodyText(parts: { scene?: string; action?: string; camera?: string; dialogue?: string; prompt?: string; title?: string }) {
    const lines = [parts.title, parts.scene, parts.action, parts.camera, parts.dialogue, parts.prompt]
        .map((value) => (value || "").trim())
        .filter(Boolean);
    // 去掉与前面字段完全重复的 prompt
    const unique: string[] = [];
    for (const line of lines) {
        if (unique.some((item) => item === line || item.includes(line) && line.length > 20)) continue;
        unique.push(line);
    }
    return unique.join("\n").trim();
}

/**
 * 首帧 / 视频提示词：只拼接风格、本镜角色外貌、镜头正文。
 * 不注入「必须遵守 / 不要出现」等硬编码指令；多→单靠只带本镜角色描述实现。
 */
export function composeGenerationPrompt(
    project: Pick<LongformProject, "styleBible" | "characters">,
    shot: Pick<LongformShot, "title" | "scene" | "action" | "camera" | "dialogue" | "prompt" | "characterIds">,
    _kind: "image" | "video" = "video",
) {
    const allCharacters = resolveProjectCharacters(project);
    const shotCharacters = resolveShotCharacters(allCharacters, shot);
    const parts: string[] = [];

    const style = project.styleBible.trim();
    if (style) parts.push(style);

    const castLines = shotCharacters
        .map((item) => {
            const name = item.name.trim();
            const appearance = item.appearance.trim();
            const note = item.note?.trim();
            return [name, appearance, note].filter(Boolean).join(" · ");
        })
        .filter(Boolean);
    if (castLines.length) parts.push(castLines.join("\n"));

    const body = buildShotBodyText({
        title: shot.title,
        scene: shot.scene,
        action: shot.action,
        camera: shot.camera,
        dialogue: shot.dialogue,
        prompt: shot.prompt,
    });
    if (body) parts.push(body);

    return parts.join("\n\n").trim();
}

export function mapDraftCharacterIds(draft: LongformShotDraft, characters: LongformCharacter[]) {
    if (draft.characterIds?.length) {
        const set = new Set(draft.characterIds);
        return characters.filter((item) => set.has(item.id)).map((item) => item.id);
    }
    const names = (draft.characterNames || []).map((name) => name.trim()).filter(Boolean);
    if (!names.length) return undefined;
    const ids: string[] = [];
    for (const name of names) {
        const found = findCharacterByName(characters, name);
        if (found && !ids.includes(found.id)) ids.push(found.id);
    }
    return ids.length ? ids : undefined;
}

export function findCharacterByName(characters: LongformCharacter[], name: string) {
    const target = name.trim();
    if (!target) return undefined;
    return (
        characters.find((item) => item.name === target) ||
        characters.find((item) => item.name.includes(target) || target.includes(item.name)) ||
        characters.find((item) => item.name.replace(/\s+/g, "") === target.replace(/\s+/g, ""))
    );
}

export function buildShotsFromDrafts(drafts: LongformShotDraft[], characters: LongformCharacter[], options?: { lockCast?: boolean }) {
    const lockCast = Boolean(options?.lockCast);
    return drafts.map((draft, index) => {
        const shot = createEmptyShot(index, draft);
        const fromNames = mapDraftCharacterIds(draft, characters);
        const auto = resolveShotCharacters(characters, shot).map((item) => item.id);
        const characterIds = fromNames?.length ? fromNames : auto.length ? auto : undefined;
        if (lockCast && characterIds?.length) {
            return { ...shot, characterIds };
        }
        const partial = characters.length > 1 && characterIds && characterIds.length > 0 && characterIds.length < characters.length;
        return {
            ...shot,
            characterIds: fromNames?.length ? fromNames : partial ? characterIds : undefined,
        };
    });
}

/** 合并角色表、从草稿补角色名、回填每镜 characterNames（不做文案改写）。 */
export function finalizeStoryboard(input: {
    styleBible?: string;
    characters?: LongformCharacter[];
    shots: LongformShotDraft[];
    existingCharacters?: LongformCharacter[];
}): {
    styleBible?: string;
    characters: LongformCharacter[];
    shots: LongformShotDraft[];
} {
    const baseCharacters = dedupeCharacters([
        ...(input.existingCharacters || []),
        ...(input.characters || []),
        ...harvestCharactersFromDrafts(input.shots),
    ]);

    const mentioned = new Set<string>();
    for (const draft of input.shots) {
        for (const name of draft.characterNames || []) {
            if (name.trim()) mentioned.add(name.trim());
        }
        for (const hit of matchCharactersInText(baseCharacters, [draft.title, draft.scene, draft.action, draft.dialogue, draft.prompt].filter(Boolean).join("\n"))) {
            if (hit.name.trim()) mentioned.add(hit.name.trim());
        }
    }

    const characters = dedupeCharacters([
        ...baseCharacters,
        ...Array.from(mentioned)
            .filter((name) => !findCharacterByName(baseCharacters, name))
            .map((name) => createEmptyCharacter({ name, appearance: "" })),
    ]);

    const shots = input.shots.map((draft) => {
        let names = (draft.characterNames || []).map((name) => name.trim()).filter(Boolean);
        if (!names.length) {
            names = matchCharactersInText(characters, [draft.title, draft.scene, draft.action, draft.dialogue, draft.prompt].filter(Boolean).join("\n")).map((item) => item.name);
        }
        if (!names.length && characters.length === 1 && characters[0].name) names = [characters[0].name];
        return {
            ...draft,
            characterNames: names.length ? names : draft.characterNames,
        };
    });

    return {
        styleBible: input.styleBible?.trim() || undefined,
        characters,
        shots,
    };
}

function harvestCharactersFromDrafts(drafts: LongformShotDraft[]): LongformCharacter[] {
    const list: LongformCharacter[] = [];
    for (const draft of drafts) {
        for (const name of draft.characterNames || []) {
            if (name.trim()) list.push(createEmptyCharacter({ name: name.trim(), appearance: "" }));
        }
    }
    return list;
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
    const characterNames = normalizeNameList(item.characters || item.characterNames || item.character || item.cast);
    const rawDuration = item.durationSec ?? item.duration ?? item.seconds;
    return {
        title: str(item.title || item.name || item.shot),
        scene: str(item.scene || item.location || item.setting),
        action: str(item.action || item.description || item.content || item.visual),
        dialogue: str(item.dialogue || item.dialog || item.line),
        camera: str(item.camera || item.shot_type || item.movement),
        // 缺省由 createEmptyShot → 5s；有值则钳制 1–18，不强制 18
        durationSec: rawDuration == null || rawDuration === "" ? undefined : normalizeDurationSec(rawDuration, 5),
        prompt: str(item.prompt || item.video_prompt),
        negativePrompt: str(item.negativePrompt || item.negative_prompt),
        characterNames: characterNames.length ? characterNames : undefined,
    };
}

function normalizeNameList(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === "string") return item.trim();
                if (item && typeof item === "object" && "name" in item) return str((item as { name?: unknown }).name);
                return "";
            })
            .filter(Boolean);
    }
    if (typeof value === "string") {
        return value
            .split(/[,，、;/|]+/)
            .map((part) => part.trim())
            .filter(Boolean);
    }
    return [];
}

/** 分镜块标题：镜头/分镜/Shot + 阿拉伯或中文数字，含 【镜头1】、## 分镜二 等。 */
const SHOT_HEAD_LINE =
    /^(?:#{1,6}\s*)?(?:【\s*)?(?:镜头|分镜|Shot|Scene)\s*(?:第)?\s*(?:\d+|[一二三四五六七八九十百两零〇]+)\s*(?:镜|场|幕|回)?\s*】?\s*[:：.\-—)）]?\s*/i;
/** 仅在「镜头/分镜」标题处切分，不用泛化的 ## 任意标题，避免前言/大纲变成空白镜。 */
const SHOT_HEAD_SPLIT =
    /\n(?=(?:#{1,6}\s*)?(?:【\s*)?(?:镜头|分镜|Shot|Scene)\s*(?:第)?\s*(?:\d+|[一二三四五六七八九十百两零〇]+))/i;

function isShotHeaderLine(line: string) {
    const head = line.trim();
    if (!head) return false;
    if (SHOT_HEAD_LINE.test(head)) return true;
    // 宽松：镜头一 / 分镜 2 / 【镜头1】雨夜
    return /^(?:#{1,6}\s*)?(?:【\s*)?(?:镜头|分镜|Shot|Scene)\s*(?:第)?\s*(?:\d+|[一二三四五六七八九十百两零〇]+)/i.test(head);
}

function parseMarkdownShots(text: string): LongformShotDraft[] {
    const blocks = splitStoryboardBlocks(text);
    if (blocks.length < 2 && !/(?:镜头|分镜|Shot)\s*(?:第)?\s*(?:\d+|[一二三四五六七八九十])/i.test(text)) return [];
    const fieldAliases: Record<string, keyof LongformShotDraft | "characterField" | "durationField"> = {
        场景: "scene",
        scene: "scene",
        动作: "action",
        action: "action",
        对白: "dialogue",
        dialogue: "dialogue",
        运镜: "camera",
        camera: "camera",
        提示词: "prompt",
        prompt: "prompt",
        时长: "durationField",
        秒数: "durationField",
        duration: "durationField",
        seconds: "durationField",
        角色: "characterField",
        出场: "characterField",
        characters: "characterField",
    };
    const drafts = blocks.map((block, index) => {
        const lines = block
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (!lines.length) return { durationSec: 5 } as LongformShotDraft;
        const head = lines[0];
        const titleFromHead = head
            .replace(/^#{1,6}\s*/, "")
            .replace(SHOT_HEAD_LINE, "")
            .replace(/^【\s*|\s*】$/g, "")
            .trim();
        // 纯「镜头 N」标题时用序号，避免空 title 回退成整行导致只像一镜
        const title = titleFromHead || (isShotHeaderLine(head) ? `镜头 ${index + 1}` : head);
        const draft: LongformShotDraft = { title, durationSec: 5 };
        const body: string[] = [];
        let characterField = "";
        // 首行若是「镜头1：动作摘要」且 strip 后仍有内容，并入动作
        if (titleFromHead && isShotHeaderLine(head) && !/^[^:：]{1,16}\s*[:：]/.test(titleFromHead)) {
            body.push(titleFromHead);
        }
        for (const line of lines.slice(1)) {
            const match = line.match(/^([^:：]{1,16})\s*[:：]\s*(.+)$/);
            if (match) {
                const key = fieldAliases[match[1].trim().toLowerCase()] || fieldAliases[match[1].trim()];
                if (key === "characterField") {
                    characterField = match[2].trim();
                    continue;
                }
                if (key === "durationField") {
                    draft.durationSec = normalizeDurationSec(String(match[2]).replace(/[^\d.]/g, ""), 5);
                    continue;
                }
                if (key) {
                    (draft as Record<string, unknown>)[key] = match[2].trim();
                    continue;
                }
            }
            body.push(line);
        }
        if (!draft.action) draft.action = body.join("\n").trim();
        if (characterField) draft.characterNames = normalizeNameList(characterField);
        return draft;
    });
    // 必须有场景/动作/提示词之一，排除仅标题的空白镜与前言块
    return drafts.filter((item) => Boolean((item.action || item.prompt || item.scene || "").trim()));
}

/** 按镜头标题切块；丢掉第一镜之前的前言/大纲。 */
function splitStoryboardBlocks(text: string): string[] {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];
    const byHeader = normalized
        .split(SHOT_HEAD_SPLIT)
        .map((block) => block.trim())
        .filter(Boolean);
    const shotOnly = dropLeadingNonShotBlocks(byHeader);
    if (shotOnly.length >= 1) return shotOnly;
    // 无换行分隔时：同一行多个「镜头N：」
    const inline = normalized
        .split(/(?=(?:【\s*)?(?:镜头|分镜|Shot)\s*(?:第)?\s*(?:\d+|[一二三四五六七八九十百两零〇]+))/i)
        .map((b) => b.trim())
        .filter(Boolean);
    const inlineShots = dropLeadingNonShotBlocks(inline);
    if (inlineShots.length >= 1) return inlineShots;
    return shotOnly;
}

/** 存在镜头标题时，丢弃不以镜头/分镜开头的前导块（剧本说明、角色表等）。 */
function dropLeadingNonShotBlocks(blocks: string[]) {
    if (blocks.length < 2) return blocks.filter((block) => isShotHeaderLine(block.split(/\r?\n/).find((line) => line.trim()) || ""));
    const firstShot = blocks.findIndex((block) => isShotHeaderLine(block.split(/\r?\n/).find((line) => line.trim()) || ""));
    if (firstShot < 0) return blocks;
    return blocks.slice(firstShot).filter((block) => {
        const head = block.split(/\r?\n/).find((line) => line.trim()) || "";
        return isShotHeaderLine(head);
    });
}

function parsePlainParagraphs(text: string): LongformShotDraft[] {
    const parts = text
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter((part) => part.length > 8);
    if (parts.length >= 2) {
        return parts.map((action) => ({ action, durationSec: 5 }));
    }
    // 不截断条数：有多少有效句就出多少镜
    return text
        .split(/[。！？\n]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 6)
        .map((action) => ({ action, durationSec: 5 }));
}

/** 解析用户粘贴的结构化分镜（JSON / Markdown / 纯文本）。 */
export function parseStructuredStoryboard(
    raw: string,
    options?: { existingCharacters?: LongformCharacter[] },
): {
    styleBible?: string;
    characters?: LongformCharacter[];
    shots: LongformShotDraft[];
} {
    const drafts = tryParseJsonShots(raw);
    if (!drafts?.length) {
        return finalizeStoryboard({
            shots: parseScriptToShotDrafts(raw),
            existingCharacters: options?.existingCharacters,
        });
    }
    let styleBible: string | undefined;
    let characters: LongformCharacter[] | undefined;
    try {
        const parsed = JSON.parse(extractJsonBlock(raw) || raw) as {
            styleBible?: string;
            characters?: unknown;
        };
        styleBible = str(parsed.styleBible);
        characters = normalizeCharactersPayload(parsed.characters);
    } catch {
        // ignore
    }
    return finalizeStoryboard({
        styleBible,
        characters,
        shots: drafts,
        existingCharacters: options?.existingCharacters,
    });
}

function normalizeCharactersPayload(value: unknown): LongformCharacter[] | undefined {
    if (!value) return undefined;
    if (typeof value === "string") return parseCharacterLines(value);
    if (!Array.isArray(value)) return undefined;
    const list = value
        .map((item) => {
            if (typeof item === "string") {
                const match = item.match(/^([^:：\-–—]{1,48})\s*[:：\-–—]\s*(.+)$/);
                if (match) return createEmptyCharacter({ name: match[1], appearance: match[2] });
                return createEmptyCharacter({ name: item.slice(0, 24), appearance: item });
            }
            if (item && typeof item === "object") {
                const row = item as Record<string, unknown>;
                const name = str(row.name || row.character || row.title);
                const appearance = str(row.appearance || row.description || row.look || row.outfit || row.desc);
                if (!name && !appearance) return null;
                return createEmptyCharacter({ name, appearance, note: str(row.note) || undefined });
            }
            return null;
        })
        .filter((item): item is LongformCharacter => Boolean(item));
    return list.length ? dedupeCharacters(list) : undefined;
}

export function dedupeCharacters(list: LongformCharacter[]) {
    const map = new Map<string, LongformCharacter>();
    for (const item of list) {
        const key = item.name.trim().toLowerCase() || item.id;
        const prev = map.get(key);
        if (!prev) {
            map.set(key, item);
            continue;
        }
        map.set(key, {
            ...prev,
            appearance: [prev.appearance, item.appearance].filter(Boolean).join("; "),
            note: prev.note || item.note,
        });
    }
    return Array.from(map.values());
}

function str(value: unknown) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
