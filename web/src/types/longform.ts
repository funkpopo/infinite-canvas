export type LongformMediaRef = {
    storageKey?: string;
    url?: string;
    width?: number;
    height?: number;
    mimeType?: string;
};

export type LongformShotStatus = "draft" | "framed" | "generating" | "ready" | "error";

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
    styleBible: string;
    characterBible: string;
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
};
