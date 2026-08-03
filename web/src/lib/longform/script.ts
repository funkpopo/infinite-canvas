import { nanoid } from "nanoid";

import type { LongformCharacter, LongformProject, LongformScene, LongformShot, LongformShotDraft } from "@/types/longform";

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
    const reference = normalizeCharacterReference(partial.reference);
    return {
        id: partial.id || characterIdFromName(name || nanoid(6)),
        name,
        appearance: (partial.appearance || "").trim(),
        note: partial.note?.trim() || undefined,
        reference,
    };
}

function normalizeCharacterReference(value?: LongformCharacter["reference"]): LongformCharacter["reference"] {
    if (!value) return undefined;
    const storageKey = value.storageKey?.trim() || undefined;
    const url = value.url?.trim() || undefined;
    if (!storageKey && !url) return undefined;
    return {
        storageKey,
        url,
        width: value.width,
        height: value.height,
        mimeType: value.mimeType,
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
        sceneId: draft.sceneId,
        status: "draft",
    };
}

/** 项目角色表；仅使用 characters，不再回退其它字段。 */
export function resolveProjectCharacters(project: Pick<LongformProject, "characters">): LongformCharacter[] {
    return Array.isArray(project.characters) ? project.characters.map((item) => createEmptyCharacter(item)) : [];
}

/** 自由文本角色列表：`姓名：外貌` 每行一条；用于模型 JSON 角色字段归一化。 */
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
    project: Pick<LongformProject, "styleBible" | "characters" | "scenes">,
    shot: Pick<LongformShot, "title" | "scene" | "action" | "camera" | "dialogue" | "prompt" | "characterIds" | "sceneId">,
    _kind: "image" | "video" = "video",
) {
    const allCharacters = resolveProjectCharacters(project);
    const shotCharacters = resolveShotCharacters(allCharacters, shot);
    const sceneBible = project.scenes?.find((item) => item.id === shot.sceneId);

    const style = project.styleBible.trim();

    const castLines = shotCharacters
        .map((item) => {
            const name = item.name.trim();
            const appearance = item.appearance.trim();
            const note = item.note?.trim();
            return [name, appearance, note].filter(Boolean).join(" · ");
        })
        .filter(Boolean);
    const subject = [castLines.join("；"), shot.action, shot.dialogue].filter(Boolean).join("；");
    const environment = [sceneBible?.name, sceneBible?.description, shot.scene].filter(Boolean).join("；");
    if (_kind === "image") {
        return [
            `[主体] ${subject || shot.title}`,
            `[场景 / 环境] ${environment}`,
            `[风格] ${style}`,
            `[光照] ${sceneBible?.description || "与场景时间和氛围一致的电影光线"}`,
            `[构图] ${shot.camera || "电影叙事构图，主体清晰"}`,
            `[质量要求] ${shot.prompt || "角色外貌与场景陈设跨镜头一致，电影级细节"}`,
        ].filter((line) => !line.endsWith("] ")).join("\n");
    }
    return [style, castLines.join("\n"), environment, buildShotBodyText(shot)].filter(Boolean).join("\n\n").trim();
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

export function sceneIdFromName(name: string) {
    return `scene:${name.trim().toLowerCase().replace(/\s+/g, "-") || nanoid(6)}`;
}

export function createEmptyScene(partial: Partial<LongformScene> = {}): LongformScene {
    const name = (partial.name || "").trim();
    return { id: partial.id || sceneIdFromName(name), name, description: (partial.description || "").trim(), reference: partial.reference };
}

export function dedupeScenes(list: LongformScene[]) {
    const map = new Map<string, LongformScene>();
    for (const item of list) {
        const next = createEmptyScene(item);
        const key = next.name.toLowerCase() || next.id;
        const previous = map.get(key);
        map.set(key, previous ? { ...previous, description: previous.description || next.description, reference: previous.reference || next.reference } : next);
    }
    return Array.from(map.values());
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

/**
 * 将 LLM 返回的分镜 JSON 落成草稿（仅用于模型输出，不做用户剧本本地启发式解析）。
 * 支持整段 JSON、```json 代码块、前后夹杂说明文字。
 */
export function parseStoryboardFromJsonText(
    raw: string,
    options?: { existingCharacters?: LongformCharacter[]; existingScenes?: LongformScene[] },
): {
    styleBible?: string;
    characters: LongformCharacter[];
    scenes: LongformScene[];
    shots: LongformShotDraft[];
} | null {
    const block = extractJsonBlock(raw) || raw.trim();
    if (!block) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(block);
    } catch {
        return null;
    }
    const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { shots?: unknown }).shots)
          ? (parsed as { shots: unknown[] }).shots
          : null;
    if (!list?.length) return null;
    const drafts = list.map(normalizeDraftObject).filter((item) => item.action || item.prompt || item.scene || item.title);
    if (!drafts.length) return null;

    let styleBible: string | undefined;
    let characters: LongformCharacter[] | undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as { styleBible?: unknown; characters?: unknown; scenes?: unknown };
        styleBible = str(obj.styleBible) || undefined;
        characters = normalizeCharactersPayload(obj.characters);
        const scenes = dedupeScenes([
            ...(options?.existingScenes || []),
            ...normalizeScenesPayload(obj.scenes),
            ...drafts.map((draft) => createEmptyScene({ name: draft.sceneName || draft.scene })).filter((item) => item.name),
        ]);
        for (const draft of drafts) {
            const target = (draft.sceneName || draft.scene || "").trim().toLowerCase();
            const scene = scenes.find((item) => item.name.trim().toLowerCase() === target);
            if (scene) draft.sceneId = scene.id;
        }
        const result = finalizeStoryboard({ styleBible, characters, shots: drafts, existingCharacters: options?.existingCharacters });
        return { ...result, scenes };
    }
    return { ...finalizeStoryboard({
        styleBible,
        characters,
        shots: drafts,
        existingCharacters: options?.existingCharacters,
    }), scenes: options?.existingScenes || [] };
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
        sceneName: str(item.sceneName || item.locationName || item.scene || item.location || item.setting),
        action: str(item.action || item.description || item.content || item.visual),
        dialogue: str(item.dialogue || item.dialog || item.line),
        camera: str(item.camera || item.shot_type || item.movement),
        durationSec: rawDuration == null || rawDuration === "" ? undefined : normalizeDurationSec(rawDuration, 5),
        prompt: str(item.prompt || item.video_prompt),
        negativePrompt: str(item.negativePrompt || item.negative_prompt),
        characterNames: characterNames.length ? characterNames : undefined,
    };
}

function normalizeScenesPayload(value: unknown): LongformScene[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
        if (typeof item === "string") return createEmptyScene({ name: item });
        const row = item as Record<string, unknown>;
        return createEmptyScene({ name: str(row.name || row.scene || row.location), description: str(row.description || row.environment || row.setting || row.desc) });
    }).filter((item) => item.name || item.description);
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
            reference: prev.reference || item.reference,
        });
    }
    return Array.from(map.values());
}

function str(value: unknown) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
