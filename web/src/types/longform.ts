export type LongformMediaRef = {
    storageKey?: string;
    url?: string;
    width?: number;
    height?: number;
    mimeType?: string;
};

export type LongformShotStatus = "draft" | "framed" | "generating" | "ready" | "error";

/** 项目级角色圣经条目，可多角色。 */
export type LongformCharacter = {
    id: string;
    name: string;
    /** 外貌、服装、年龄、标志性特征 */
    appearance: string;
    note?: string;
    /** 角色参考图（资产库引入等），出首帧/视频时作为参考图保持人物一致性 */
    reference?: LongformMediaRef;
};

/** 项目级场景圣经条目，固定空间、陈设与色彩，供跨镜头复用。 */
export type LongformScene = {
    id: string;
    name: string;
    /** 环境、空间结构、陈设、时间与光线等稳定特征 */
    description: string;
    reference?: LongformMediaRef;
};

export type LongformShot = {
    id: string;
    index: number;
    title: string;
    scene: string;
    action: string;
    dialogue?: string;
    camera?: string;
    durationSec: number;
    prompt: string;
    negativePrompt?: string;
    /**
     * 本镜出场角色 id 列表。
     * - 有值：只注入这些角色（多人物项目里的单人特写等）
     * - 空 / 缺省：按分镜文案自动匹配角色名；匹配不到则注入全部角色
     */
    characterIds?: string[];
    /** 绑定项目场景；有值时生成会注入场景描述与参考图。 */
    sceneId?: string;
    firstFrame?: LongformMediaRef;
    lastFrame?: LongformMediaRef;
    video?: LongformMediaRef;
    status: LongformShotStatus;
    seed?: number;
    chainFromShotId?: string;
    error?: string;
};

export type LongformAssembleStatus = "idle" | "running" | "done" | "error";

export type LongformProject = {
    id: string;
    title: string;
    /** 全片统一风格，首帧与视频生成时强制前置 */
    styleBible: string;
    /** 项目级角色表（多人），生成时按本镜出场注入 */
    characters: LongformCharacter[];
    /** 项目级场景表，跨镜头保持环境一致。 */
    scenes: LongformScene[];
    aspectRatio: string;
    resolution: string;
    fps: number;
    scriptSource: "manual" | "import" | "generated";
    scriptRaw: string;
    chainMode: boolean;
    shots: LongformShot[];
    assemble?: {
        videoUrl?: string;
        storageKey?: string;
        status: LongformAssembleStatus;
        error?: string;
    };
    createdAt: number;
    updatedAt: number;
};

export type LongformShotDraft = {
    title?: string;
    scene?: string;
    action?: string;
    dialogue?: string;
    camera?: string;
    durationSec?: number;
    prompt?: string;
    negativePrompt?: string;
    /** 草稿里的角色名，入库时映射为 characterIds */
    characterNames?: string[];
    characterIds?: string[];
    /** LLM 草稿里的场景名，入库时映射为 sceneId。 */
    sceneName?: string;
    sceneId?: string;
};
