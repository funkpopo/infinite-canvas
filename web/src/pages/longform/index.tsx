import { Clapperboard, Download, Film, ImagePlus, LoaderCircle, Plus, Sparkles, Trash2, Upload, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Select, Switch, Tag, Typography } from "antd";
import { saveAs } from "file-saver";

import { ModelPicker } from "@/components/model-picker";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { preloadFfmpeg } from "@/lib/media/ffmpeg-frames";
import { createEmptyCharacter, LONGFORM_DURATION_OPTIONS, normalizeDurationSec, parseStructuredStoryboard, resolveProjectCharacters, resolveShotCharacters, dedupeCharacters } from "@/lib/longform/script";
import {
    assembleProjectVideos,
    assistWriteLongform,
    extractShotFrame,
    generateShotFirstFrame,
    generateShotVideo,
    resolveMediaDisplayUrl,
    selectShotsForFirstFrame,
    selectShotsForVideo,
    blobToMediaRef,
} from "@/lib/longform/generation";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { selectActiveLongformProject, useLongformStore } from "@/stores/use-longform-store";
import type { LongformCharacter, LongformMediaRef, LongformShot } from "@/types/longform";
import type { AiTextMessage } from "@/services/api/image";
import { requestImageQuestion } from "@/services/api/image";
import type { ReferenceImage } from "@/types/image";

type BatchKind = "frames" | "videos" | null;

const RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4"].map((value) => ({ value, label: value }));
const RESOLUTION_OPTIONS = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];
/** 风格圣经 LLM 随机生成用的预设场景关键词。 */
const STYLE_PRESETS = [
    "电影级写实风格，胶片感，温暖自然光",
    "赛博朋克霓虹夜景，高对比冷调",
    "雨夜悬疑氛围，浅景深，电影色调",
    "科幻未来太空，蓝调赛博，动态光",
    "日系动漫风格，鲜艳色彩，流畅线条",
];

export default function LongformPage() {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    const projects = useLongformStore((state) => state.projects);
    const activeProjectId = useLongformStore((state) => state.activeProjectId);
    const project = useLongformStore(selectActiveLongformProject);
    const createProject = useLongformStore((state) => state.createProject);
    const deleteProject = useLongformStore((state) => state.deleteProject);
    const setActiveProject = useLongformStore((state) => state.setActiveProject);
    const updateProject = useLongformStore((state) => state.updateProject);
    const setCharacters = useLongformStore((state) => state.setCharacters);
    const updateShot = useLongformStore((state) => state.updateShot);
    const addShot = useLongformStore((state) => state.addShot);
    const removeShot = useLongformStore((state) => state.removeShot);
    const importScript = useLongformStore((state) => state.importScript);
    const replaceShotsFromDrafts = useLongformStore((state) => state.replaceShotsFromDrafts);
    const setShotFrame = useLongformStore((state) => state.setShotFrame);
    const setShotVideo = useLongformStore((state) => state.setShotVideo);
    const setAssemble = useLongformStore((state) => state.setAssemble);

    const [batchKind, setBatchKind] = useState<BatchKind>(null);
    const [assisting, setAssisting] = useState(false);
    const [assistInstruction, setAssistInstruction] = useState("");
    const [statusText, setStatusText] = useState("");
    const [isGeneratingStyle, setIsGeneratingStyle] = useState(false);
    const [isParsingImage, setIsParsingImage] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    /** 批量任务共用 abort；单镜任务各自独立，互不影响。 */
    const abortRef = useRef<AbortController | null>(null);
    const shotAbortRef = useRef(new Map<string, AbortController>());
    const [busyShotIds, setBusyShotIds] = useState<Record<string, boolean>>({});
    const frameInputRef = useRef<HTMLInputElement>(null);
    const frameTargetRef = useRef<{ shotId: string; role: "firstFrame" | "lastFrame" } | null>(null);

    const videoModel = effectiveConfig.videoModel || effectiveConfig.model;
    const textModel = effectiveConfig.textModel || effectiveConfig.model;
    const imageModel = effectiveConfig.imageModel || effectiveConfig.model;
    const batchRunning = batchKind !== null;

    useEffect(() => {
        void preloadFfmpeg().catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!activeProjectId && projects[0]) setActiveProject(projects[0].id);
    }, [activeProjectId, projects, setActiveProject]);

    const shotStats = useMemo(() => {
        const shots = project?.shots || [];
        const total = shots.length;
        const withFrame = shots.filter((shot) => shot.firstFrame).length;
        const ready = shots.filter((shot) => shot.status === "ready" && shot.video).length;
        const missingFrames = selectShotsForFirstFrame(shots, "missing").length;
        const readyForVideo = selectShotsForVideo(shots, "framed").length;
        return { total, withFrame, ready, missingFrames, readyForVideo };
    }, [project]);

    /** 流程阶段：1 分镜 → 2 首帧 → 3 视频 → 4 成片 */
    const workflowStep = useMemo(() => {
        if (!project?.shots.length) return 1;
        if (shotStats.withFrame < shotStats.total) return 2;
        if (shotStats.ready < shotStats.total) return 3;
        if (project.assemble?.status !== "done") return 4;
        return 4;
    }, [project, shotStats]);

    const handleCreate = () => {
        const id = createProject(`长片 ${projects.length + 1}`);
        message.success("已创建长片项目");
        setActiveProject(id);
    };

    const handleImportParse = () => {
        if (!project?.scriptRaw.trim()) {
            message.warning("请先粘贴剧本或分镜文本");
            return;
        }
        const structured = parseStructuredStoryboard(project.scriptRaw, {
            existingCharacters: resolveProjectCharacters(project),
        });
        if (structured.shots.length) {
            replaceShotsFromDrafts(project.id, structured.shots, {
                styleBible: structured.styleBible,
                characters: structured.characters,
                scriptSource: "import",
                scriptRaw: project.scriptRaw,
            });
            message.success(`已导入 ${structured.shots.length} 个镜头${structured.characters?.length ? `、${structured.characters.length} 名角色` : ""}。确认后可批量出首帧`);
            return;
        }
        const count = importScript(project.id, project.scriptRaw, "import");
        if (!count) {
            message.warning("未能解析出分镜，请使用 Markdown/JSON 分镜，或先 LLM 辅助撰写再解析");
            return;
        }
        message.success(`已导入 ${count} 个镜头。下一步：确认分镜后批量出首帧`);
    };

    /** LLM 辅助撰写：流式写入剧本区，不再另开预览，避免双份结果。 */
    const handleAssistWrite = async () => {
        if (!project) return;
        if (!assistInstruction.trim() && !project.scriptRaw.trim()) {
            message.warning("请填写撰写要求，或先贴一段草稿");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, textModel)) {
            openConfigDialog();
            return;
        }
        const projectId = project.id;
        const snapshot = {
            instruction: assistInstruction,
            scriptRaw: project.scriptRaw,
            styleBible: project.styleBible,
            characters: resolveProjectCharacters(project),
        };
        setAssisting(true);
        setStatusText("LLM 辅助撰写中…");
        try {
            const textConfig = { ...effectiveConfig, model: textModel };
            // onDelta 已是全文累计，直接覆盖剧本区，勿再拼接
            const text = await assistWriteLongform(textConfig, snapshot, (full) => {
                updateProject(projectId, { scriptRaw: full, scriptSource: "generated" });
            });
            const next = text.trim();
            if (!next) throw new Error("模型没有返回文案");
            updateProject(projectId, { scriptRaw: next, scriptSource: "generated" });
            message.success("已写入剧本区。需要分镜表时再点「解析导入」");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "辅助撰写失败");
        } finally {
            setAssisting(false);
            setStatusText("");
        }
    };

    /** 用预设场景调用 LLM 生成风格圣经；不传 preset 则随机选一个。 */
    const handleGenerateStyleBible = async (preset?: string) => {
        if (!project) return;
        if (!isAiConfigReady(effectiveConfig, textModel)) {
            openConfigDialog();
            return;
        }
        const scene = (preset || STYLE_PRESETS[Math.floor(Math.random() * STYLE_PRESETS.length)]).trim();
        setIsGeneratingStyle(true);
        setStatusText("正在生成风格圣经…");
        try {
            const messages: AiTextMessage[] = [{
                role: "user",
                content: `请生成一段风格描述（约 80 字），用于长片首帧与视频提示词强制注入。关键词：${scene}。输出纯文本描述，不要解释或标题。`,
            }];
            const textConfig = { ...effectiveConfig, model: textModel };
            const text = await requestImageQuestion(textConfig, messages, () => undefined);
            const next = text.trim() || scene;
            updateProject(project.id, { styleBible: next });
            message.success(preset ? "风格圣经已生成" : "风格圣经已随机生成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成风格圣经失败");
        } finally {
            setIsGeneratingStyle(false);
            setStatusText("");
        }
    };

    /** 从资产库图片解析人物并导入角色圣经。 */
    const handleParseImageCharacters = async (image: ReferenceImage) => {
        if (!project) return;
        if (!isAiConfigReady(effectiveConfig, textModel)) {
            openConfigDialog();
            return;
        }
        setIsParsingImage(true);
        setStatusText("正在解析图片人物…");
        try {
            // 资产库里的图多为 blob: / storageKey，需转成 data URL 再发给模型（服务端读不了 blob）
            const dataUrl = await imageToDataUrl(image);
            if (!dataUrl?.startsWith("data:")) throw new Error("图片不可用或无法转为 base64");
            const messages: AiTextMessage[] = [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "请仔细观察这张图片中的所有人物角色。提取每个角色的姓名（中文或英文）和外貌描述（服装、年龄、外表标志、风格等）。输出 JSON：{\"characters\": [{\"name\": \"姓名\", \"appearance\": \"外貌描述\"}]}。仅输出 JSON，不要额外文字。",
                    },
                    {
                        type: "image_url",
                        image_url: { url: dataUrl },
                    },
                ],
            }];
            const textConfig = { ...effectiveConfig, model: textModel };
            const text = await requestImageQuestion(textConfig, messages, () => undefined);
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("模型没有返回有效 JSON");
            const data = JSON.parse(match[0]) as { characters?: Array<{ name?: string; appearance?: string }> };
            const newChars = Array.isArray(data.characters)
                ? data.characters.map((item) => createEmptyCharacter({ name: item.name || "", appearance: item.appearance || "" }))
                : [];
            if (!newChars.length) throw new Error("未解析到人物");
            const existing = resolveProjectCharacters(project);
            const merged = dedupeCharacters([...existing, ...newChars]);
            setCharacters(project.id, merged);
            message.success(`已导入 ${newChars.length} 个角色到圣经`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片解析失败");
        } finally {
            setIsParsingImage(false);
            setStatusText("");
        }
    };

    const pickFrameFile = (shotId: string, role: "firstFrame" | "lastFrame") => {
        frameTargetRef.current = { shotId, role };
        frameInputRef.current?.click();
    };

    const onFrameFile = async (files?: FileList | null) => {
        const target = frameTargetRef.current;
        const file = files?.[0];
        frameTargetRef.current = null;
        if (!target || !file || !project) return;
        try {
            const media = await blobToMediaRef(file, "image");
            setShotFrame(project.id, target.shotId, target.role, media);
            message.success(target.role === "firstFrame" ? "已设置首帧" : "已设置尾帧");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取图片失败");
        }
    };

    /** 批量任务 abort（取消会中断整批）。 */
    const beginBatchAbortable = () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        return controller;
    };

    /** 单镜任务独立 abort：只取消同镜重入，不影响其它镜头。 */
    const beginShotAbortable = (shotId: string) => {
        shotAbortRef.current.get(shotId)?.abort();
        const controller = new AbortController();
        shotAbortRef.current.set(shotId, controller);
        return controller;
    };

    const setShotBusy = (shotId: string, busy: boolean) => {
        setBusyShotIds((prev) => {
            if (busy) return { ...prev, [shotId]: true };
            if (!prev[shotId]) return prev;
            const next = { ...prev };
            delete next[shotId];
            return next;
        });
    };

    const cancelRunning = () => {
        abortRef.current?.abort();
        for (const controller of shotAbortRef.current.values()) controller.abort();
        shotAbortRef.current.clear();
        setBatchKind(null);
        setBusyShotIds({});
        setStatusText("");
    };

    /** 仅出首帧，不触发出视频。 */
    const runFirstFrameOnly = async (shot: LongformShot, signal?: AbortSignal) => {
        if (!project) return;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            openConfigDialog();
            throw new Error("请先配置图片模型");
        }
        const projectId = project.id;
        const shotId = shot.id;
        setShotBusy(shotId, true);
        updateShot(projectId, shotId, { status: "generating", error: undefined });
        setStatusText(`镜头 ${shot.index + 1}：生成首帧…`);
        try {
            const latestProject = useLongformStore.getState().projects.find((item) => item.id === projectId) || project;
            const latestShot = latestProject.shots.find((item) => item.id === shotId) || shot;
            const frame = await generateShotFirstFrame(effectiveConfig, latestProject, latestShot, signal);
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            setShotFrame(projectId, shotId, "firstFrame", frame);
            updateShot(projectId, shotId, { status: "framed", error: undefined });
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                updateShot(projectId, shotId, { status: shot.firstFrame ? "framed" : "draft" });
                throw error;
            }
            const text = error instanceof Error ? error.message : "首帧生成失败";
            updateShot(projectId, shotId, { status: "error", error: text });
            message.error(`镜头 ${shot.index + 1}：${text}`);
            throw error;
        } finally {
            setShotBusy(shotId, false);
            shotAbortRef.current.delete(shotId);
        }
    };

    /** 仅出视频（默认要求已有首帧；无首帧时提示）。 */
    const runVideoOnly = async (shot: LongformShot, signal?: AbortSignal) => {
        if (!project) return;
        if (!shot.firstFrame) {
            message.warning(`镜头 ${shot.index + 1} 尚无首帧，请先出首帧或上传`);
            return;
        }
        if (!isAiConfigReady(effectiveConfig, videoModel)) {
            openConfigDialog();
            throw new Error("请先配置视频模型");
        }
        const projectId = project.id;
        const shotId = shot.id;
        setShotBusy(shotId, true);
        updateShot(projectId, shotId, { status: "generating", error: undefined });
        try {
            const latestProject = useLongformStore.getState().projects.find((item) => item.id === projectId) || project;
            let current = latestProject.shots.find((item) => item.id === shotId) || shot;
            setStatusText(`镜头 ${current.index + 1}：生成视频…`);
            const video = await generateShotVideo(effectiveConfig, latestProject, current, {
                signal,
                onStatus: (text) => setStatusText(`镜头 ${current.index + 1}：${text}`),
            });
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            setShotVideo(projectId, current.id, video, "ready");
            current = { ...current, video, status: "ready" };

            const after = useLongformStore.getState().projects.find((item) => item.id === projectId);
            if (after?.chainMode) {
                setStatusText(`镜头 ${current.index + 1}：抽取尾帧并衔接下镜…`);
                const last = await extractShotFrame(current, "last");
                setShotFrame(projectId, current.id, "lastFrame", last);
                const next = after.shots.find((item) => item.index === current.index + 1);
                // 链式只在下镜尚无独立首帧时写入，避免覆盖人工/批量已出的首帧
                if (next && !next.firstFrame) {
                    setShotFrame(projectId, next.id, "firstFrame", last);
                    updateShot(projectId, next.id, { chainFromShotId: current.id, status: next.video ? next.status : "framed" });
                }
            }
            message.success(`镜头 ${current.index + 1} 视频已完成`);
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                updateShot(projectId, shotId, { status: shot.video ? "ready" : shot.firstFrame ? "framed" : "draft" });
                throw error;
            }
            const text = error instanceof Error ? error.message : "视频生成失败";
            setShotVideo(projectId, shotId, shot.video, "error", text);
            message.error(`镜头 ${shot.index + 1}：${text}`);
            throw error;
        } finally {
            setShotBusy(shotId, false);
            shotAbortRef.current.delete(shotId);
        }
    };

    const handleGenerateFirstFrame = async (shot: LongformShot) => {
        // 单镜独立执行，不 abort 其它镜头的首帧任务
        const controller = beginShotAbortable(shot.id);
        try {
            await runFirstFrameOnly(shot, controller.signal);
            if (!controller.signal.aborted) message.success(`镜头 ${shot.index + 1} 首帧已生成`);
        } catch {
            // messaged
        }
    };

    const handleGenerateVideo = async (shot: LongformShot) => {
        const controller = beginShotAbortable(shot.id);
        try {
            await runVideoOnly(shot, controller.signal);
        } catch {
            // messaged
        }
    };

    const handleExtractFrame = async (shot: LongformShot, position: "first" | "last") => {
        if (!project || !shot.video) {
            message.warning("请先生成该镜头视频");
            return;
        }
        const shotId = shot.id;
        setShotBusy(shotId, true);
        setStatusText(`抽取${position === "first" ? "首" : "尾"}帧…`);
        try {
            const frame = await extractShotFrame(shot, position);
            setShotFrame(project.id, shot.id, position === "first" ? "firstFrame" : "lastFrame", frame);
            if (position === "last" && project.chainMode) {
                const next = project.shots.find((item) => item.index === shot.index + 1);
                if (next && !next.firstFrame) {
                    setShotFrame(project.id, next.id, "firstFrame", frame);
                    updateShot(project.id, next.id, { chainFromShotId: shot.id });
                }
            }
            message.success(position === "first" ? "已提取首帧" : "已提取尾帧");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "抽帧失败");
        } finally {
            setShotBusy(shotId, false);
            setStatusText("");
        }
    };

    /** 分镜完成后的主入口：批量出各镜首帧。 */
    const handleBatchFirstFrames = (mode: "missing" | "all" = "missing") => {
        if (!project?.shots.length) {
            message.warning("请先完成分镜");
            return;
        }
        const targets = selectShotsForFirstFrame(project.shots, mode);
        if (!targets.length) {
            message.info(mode === "missing" ? "所有镜头已有首帧。如需重出，请选择「全部重出首帧」" : "没有可出首帧的镜头（请先填写动作或提示词）");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            openConfigDialog();
            return;
        }

        const run = async () => {
            const controller = beginBatchAbortable();
            setBatchKind("frames");
            let ok = 0;
            let fail = 0;
            try {
                for (let i = 0; i < targets.length; i += 1) {
                    if (controller.signal.aborted) break;
                    const shotId = targets[i].id;
                    const latest = useLongformStore.getState().projects.find((item) => item.id === project.id)?.shots.find((item) => item.id === shotId);
                    if (!latest) continue;
                    if (mode === "missing" && latest.firstFrame) continue;
                    setStatusText(`批量出首帧 ${i + 1}/${targets.length}：镜头 ${latest.index + 1}`);
                    try {
                        await runFirstFrameOnly(latest, controller.signal);
                        ok += 1;
                    } catch (error) {
                        if (error instanceof DOMException && error.name === "AbortError") break;
                        fail += 1;
                    }
                }
                if (!controller.signal.aborted) {
                    message.success(`首帧完成：成功 ${ok}${fail ? `，失败 ${fail}` : ""}。可审帧后批量出视频`);
                }
            } finally {
                setBatchKind(null);
                setStatusText("");
            }
        };

        if (mode === "all") {
            modal.confirm({
                title: "全部重出首帧？",
                content: `将覆盖 ${targets.length} 个镜头的已有首帧（不删除已生成视频，但出视频时会用新首帧）。建议串行执行，可随时取消。`,
                okText: "全部重出",
                onOk: () => void run(),
            });
            return;
        }
        void run();
    };

    const handleBatchVideos = () => {
        if (!project) return;
        const targets = selectShotsForVideo(project.shots, "framed");
        if (!targets.length) {
            const missing = selectShotsForFirstFrame(project.shots, "missing").length;
            message.warning(missing ? `还有 ${missing} 个镜头没有首帧，请先「批量出首帧」` : "没有待出视频的镜头（需已有首帧且未完成）");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, videoModel)) {
            openConfigDialog();
            return;
        }

        void (async () => {
            const controller = beginBatchAbortable();
            setBatchKind("videos");
            let ok = 0;
            let fail = 0;
            try {
                for (let i = 0; i < targets.length; i += 1) {
                    if (controller.signal.aborted) break;
                    const shotId = targets[i].id;
                    const latest = useLongformStore.getState().projects.find((item) => item.id === project.id)?.shots.find((item) => item.id === shotId);
                    if (!latest?.firstFrame || (latest.status === "ready" && latest.video)) continue;
                    setStatusText(`批量出视频 ${i + 1}/${targets.length}：镜头 ${latest.index + 1}`);
                    try {
                        await runVideoOnly(latest, controller.signal);
                        ok += 1;
                    } catch (error) {
                        if (error instanceof DOMException && error.name === "AbortError") break;
                        fail += 1;
                    }
                }
                if (!controller.signal.aborted) {
                    message.success(`视频完成：成功 ${ok}${fail ? `，失败 ${fail}` : ""}`);
                }
            } finally {
                setBatchKind(null);
                setStatusText("");
            }
        })();
    };

    const handleAssemble = async () => {
        if (!project) return;
        setAssemble(project.id, { status: "running" });
        setStatusText("正在拼接成片…");
        try {
            const latest = useLongformStore.getState().projects.find((item) => item.id === project.id) || project;
            const media = await assembleProjectVideos(latest);
            setAssemble(project.id, { status: "done", storageKey: media.storageKey, videoUrl: media.url });
            message.success("成片已生成");
        } catch (error) {
            const text = error instanceof Error ? error.message : "拼接失败";
            setAssemble(project.id, { status: "error", error: text });
            message.error(text);
        } finally {
            setStatusText("");
        }
    };

    const handleDownloadAssemble = async () => {
        if (!project?.assemble?.storageKey && !project?.assemble?.videoUrl) return;
        try {
            const blob = project.assemble.storageKey ? await getMediaBlob(project.assemble.storageKey) : null;
            if (blob) {
                saveAs(blob, `${project.title || "longform"}.mp4`);
                return;
            }
            if (project.assemble.videoUrl) {
                const response = await fetch(project.assemble.videoUrl);
                saveAs(await response.blob(), `${project.title || "longform"}.mp4`);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        }
    };

    const handleDeleteProject = (id: string) => {
        modal.confirm({
            title: "删除长片项目？",
            content: "项目元数据会删除；已落盘的媒体文件不会自动清理。",
            okText: "删除",
            okButtonProps: { danger: true },
            onOk: () => {
                deleteProject(id);
                message.success("已删除");
            },
        });
    };

    const totalDurationSec = useMemo(
        () => (project?.shots || []).reduce((sum, shot) => sum + normalizeDurationSec(shot.durationSec), 0),
        [project?.shots],
    );

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 pb-16">
            <input ref={frameInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void onFrameFile(event.target.files)} />
            <AssetPickerModal
                open={assetPickerOpen}
                defaultTab="my-assets"
                onInsert={(payload: InsertAssetPayload) => {
                    if (payload.kind === "image") {
                        void handleParseImageCharacters({
                            id: payload.storageKey || payload.title || "asset-image",
                            name: payload.title || "asset",
                            type: "image/jpeg",
                            dataUrl: payload.dataUrl,
                            storageKey: payload.storageKey,
                        });
                    } else {
                        message.warning("请选择图片资产");
                    }
                    setAssetPickerOpen(false);
                }}
                onClose={() => setAssetPickerOpen(false)}
            />

            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-stone-950 dark:text-stone-100">
                        <Clapperboard className="size-5" />
                        <Typography.Title level={3} className="!mb-0">
                            长片工作台
                        </Typography.Title>
                    </div>
                    <Typography.Paragraph type="secondary" className="!mb-0 !mt-1">
                        推荐流程：剧本分镜 → 批量出首帧（人工审帧）→ 批量出视频 → 拼接成片
                    </Typography.Paragraph>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button icon={<Plus className="size-4" />} onClick={handleCreate}>
                        新建项目
                    </Button>
                    {project ? (
                        <Button danger icon={<Trash2 className="size-4" />} onClick={() => handleDeleteProject(project.id)}>
                            删除项目
                        </Button>
                    ) : null}
                </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
                <aside className="space-y-2 rounded-2xl border border-stone-200 p-3 dark:border-stone-800">
                    <div className="px-1 text-xs font-medium text-stone-500">项目列表</div>
                    {projects.length ? (
                        projects.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                className={`flex w-full flex-col rounded-xl px-3 py-2 text-left text-sm transition hover:bg-black/5 dark:hover:bg-white/10 ${item.id === activeProjectId ? "bg-black/5 dark:bg-white/10" : ""}`}
                                onClick={() => setActiveProject(item.id)}
                            >
                                <span className="truncate font-medium text-stone-900 dark:text-stone-100">{item.title}</span>
                                <span className="text-xs text-stone-500">{item.shots.length} 镜 · {item.shots.filter((s) => s.status === "ready").length} 完成</span>
                            </button>
                        ))
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目" />
                    )}
                </aside>

                {!project ? (
                    <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-dashed border-stone-300 dark:border-stone-700">
                        <Empty description="创建或选择一个长片项目">
                            <Button type="primary" icon={<Plus className="size-4" />} onClick={handleCreate}>
                                新建长片
                            </Button>
                        </Empty>
                    </div>
                ) : (
                    <div className="space-y-5">
                        <section className="space-y-3 rounded-2xl border border-stone-200 p-4 dark:border-stone-800">
                            <div className="grid gap-3 md:grid-cols-2">
                                <label className="space-y-1 text-sm">
                                    <span className="text-stone-500">标题</span>
                                    <Input value={project.title} onChange={(event) => updateProject(project.id, { title: event.target.value })} />
                                </label>
                                <div className="grid grid-cols-3 gap-2">
                                    <label className="space-y-1 text-sm">
                                        <span className="text-stone-500">比例</span>
                                        <Select className="w-full" value={project.aspectRatio} options={RATIO_OPTIONS} onChange={(value) => updateProject(project.id, { aspectRatio: value })} />
                                    </label>
                                    <label className="space-y-1 text-sm">
                                        <span className="text-stone-500">分辨率</span>
                                        <Select className="w-full" value={project.resolution} options={RESOLUTION_OPTIONS} onChange={(value) => updateProject(project.id, { resolution: value })} />
                                    </label>
                                    <label className="space-y-1 text-sm">
                                        <span className="text-stone-500">帧率</span>
                                        <Select className="w-full" value={project.fps} options={[24, 30].map((value) => ({ value, label: `${value}` }))} onChange={(value) => updateProject(project.id, { fps: value })} />
                                    </label>
                                </div>
                            </div>
                            <label className="space-y-1 text-sm">
                                <span className="text-stone-500">风格圣经（强制注入每镜首帧与视频）</span>
                                <Input.TextArea
                                    rows={2}
                                    value={project.styleBible}
                                    placeholder="统一画风、调色、时代感、镜头语言。例如：电影感写实、冷色调雨夜、浅景深"
                                    onChange={(event) => updateProject(project.id, { styleBible: event.target.value })}
                                />
                            </label>
                            <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        size="small"
                                        icon={<Sparkles className="size-3.5" />}
                                        loading={isGeneratingStyle}
                                        onClick={() => void handleGenerateStyleBible()}
                                    >
                                        随机生成风格圣经
                                    </Button>
                                    <span className="text-xs text-stone-400">或点选下方预设场景</span>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {STYLE_PRESETS.map((preset) => (
                                        <button
                                            key={preset}
                                            type="button"
                                            disabled={isGeneratingStyle}
                                            className="rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-600 transition hover:border-stone-400 hover:bg-black/5 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-500 dark:hover:bg-white/10"
                                            onClick={() => void handleGenerateStyleBible(preset)}
                                        >
                                            {preset.split("，")[0]}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <CharacterBibleEditor
                                characters={resolveProjectCharacters(project)}
                                onChange={(characters) => setCharacters(project.id, characters)}
                                onOpenAssetPicker={() => setAssetPickerOpen(true)}
                                isParsing={isParsingImage}
                            />
                            <div className="flex flex-wrap items-center gap-4">
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="text-stone-500">链式衔接</span>
                                    <Switch checked={project.chainMode} onChange={(checked) => updateProject(project.id, { chainMode: checked })} />
                                    <span className="text-xs text-stone-400">出视频后抽尾帧；仅当下镜尚无首帧时写入</span>
                                </div>
                            </div>
                            <div className="grid gap-3 md:grid-cols-2">
                                <div>
                                    <div className="mb-1 text-xs text-stone-500">图片模型（出首帧）</div>
                                    <ModelPicker config={effectiveConfig} value={imageModel} capability="image" onChange={(value) => updateConfig("imageModel", value)} fullWidth />
                                </div>
                                <div>
                                    <div className="mb-1 text-xs text-stone-500">视频模型（出短镜）</div>
                                    <ModelPicker config={effectiveConfig} value={videoModel} capability="video" onChange={(value) => updateConfig("videoModel", value)} fullWidth />
                                </div>
                            </div>
                        </section>

                        <section className="space-y-3 rounded-2xl border border-stone-200 p-4 dark:border-stone-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-sm font-medium text-stone-900 dark:text-stone-100">① 剧本与分镜</div>
                                <div className="flex flex-wrap gap-2">
                                    <Button type="primary" icon={<Sparkles className="size-4" />} loading={assisting} onClick={() => void handleAssistWrite()}>
                                        LLM 辅助撰写
                                    </Button>
                                    <Button icon={<Upload className="size-4" />} onClick={handleImportParse}>
                                        解析导入
                                    </Button>
                                </div>
                            </div>
                            <div className="text-xs leading-5 text-stone-500">
                                辅助撰写只扩写/润色正文（要求由你填写）；「解析导入」再本地拆成角色与分镜表。风格/角色圣经仍会在出首帧与出视频时自动注入。
                            </div>
                            <Input.TextArea
                                rows={2}
                                value={assistInstruction}
                                placeholder="撰写要求（可选）。例如：扩成 6 个分镜，写清小明/小红出场；雨夜悬疑风格"
                                onChange={(event) => setAssistInstruction(event.target.value)}
                            />
                            <Input.TextArea
                                rows={6}
                                value={project.scriptRaw}
                                placeholder={"粘贴或撰写剧本 / Markdown / JSON。例如：\n## 镜头 1\n场景：雨夜街道\n动作：小明撑伞转身\n角色：小明\n\n或 JSON：{ \"characters\": [...], \"shots\": [...] }"}
                                onChange={(event) => updateProject(project.id, { scriptRaw: event.target.value })}
                            />
                        </section>

                        <WorkflowSteps
                            step={workflowStep}
                            stats={shotStats}
                            onBatchFrames={() => handleBatchFirstFrames("missing")}
                            onBatchFramesAll={() => handleBatchFirstFrames("all")}
                            onBatchVideos={handleBatchVideos}
                            onAssemble={() => void handleAssemble()}
                            onDownload={() => void handleDownloadAssemble()}
                            onCancel={cancelRunning}
                            batchKind={batchKind}
                            assembleStatus={project.assemble?.status}
                            canDownload={project.assemble?.status === "done"}
                        />

                        <section className="space-y-3 rounded-2xl border border-stone-200 p-4 dark:border-stone-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-sm font-medium">分镜表</div>
                                    <Tag>{shotStats.total} 镜</Tag>
                                    <Tag>合计约 {totalDurationSec}s</Tag>
                                    <Tag color="blue">首帧 {shotStats.withFrame}/{shotStats.total}</Tag>
                                    <Tag color="success">视频 {shotStats.ready}/{shotStats.total}</Tag>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button icon={<Plus className="size-4" />} onClick={() => addShot(project.id)}>
                                        添加镜头
                                    </Button>
                                    <Button
                                        type={workflowStep === 2 ? "primary" : "default"}
                                        icon={<ImagePlus className="size-4" />}
                                        loading={batchKind === "frames"}
                                        disabled={batchRunning && batchKind !== "frames"}
                                        onClick={() => handleBatchFirstFrames("missing")}
                                    >
                                        批量出首帧{shotStats.missingFrames ? `（${shotStats.missingFrames}）` : ""}
                                    </Button>
                                    <Button
                                        type={workflowStep === 3 ? "primary" : "default"}
                                        icon={<Video className="size-4" />}
                                        loading={batchKind === "videos"}
                                        disabled={batchRunning && batchKind !== "videos"}
                                        onClick={handleBatchVideos}
                                    >
                                        批量出视频{shotStats.readyForVideo ? `（${shotStats.readyForVideo}）` : ""}
                                    </Button>
                                    {batchRunning ? (
                                        <Button danger onClick={cancelRunning}>
                                            取消
                                        </Button>
                                    ) : null}
                                    <Button icon={<Film className="size-4" />} disabled={shotStats.ready < 1} loading={project.assemble?.status === "running"} onClick={() => void handleAssemble()}>
                                        拼接成片
                                    </Button>
                                    {project.assemble?.status === "done" ? (
                                        <Button icon={<Download className="size-4" />} onClick={() => void handleDownloadAssemble()}>
                                            下载成片
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                            <div className="text-xs leading-5 text-stone-500">编辑分镜文案、本镜时长（1–18s，默认 5s，各镜独立）与出场；生成结果在下方「分镜结果」独立查看。</div>
                            {statusText ? (
                                <div className="flex items-center gap-2 text-sm text-stone-500">
                                    <LoaderCircle className="size-4 animate-spin" />
                                    {statusText}
                                </div>
                            ) : null}

                            {project.shots.length ? (
                                <div className="space-y-3">
                                    {project.shots.map((shot) => (
                                        <ShotEditorCard
                                            key={shot.id}
                                            shot={shot}
                                            characters={resolveProjectCharacters(project)}
                                            busy={Boolean(busyShotIds[shot.id]) || batchRunning}
                                            onChange={(patch) => updateShot(project.id, shot.id, patch)}
                                            onRemove={() => removeShot(project.id, shot.id)}
                                            onGenerateFrame={() => void handleGenerateFirstFrame(shot)}
                                            onGenerateVideo={() => void handleGenerateVideo(shot)}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <Empty
                                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                                    description="暂无分镜。请解析导入剧本，或点击「添加镜头」；数量不设上限，以实际分镜为准"
                                >
                                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => addShot(project.id)}>
                                        添加镜头
                                    </Button>
                                </Empty>
                            )}
                        </section>

                        <section className="space-y-3 rounded-2xl border border-stone-200 p-4 dark:border-stone-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-sm font-medium">分镜结果</div>
                                    <Tag color="blue">{shotStats.withFrame} 首帧</Tag>
                                    <Tag color="success">{shotStats.ready} 视频</Tag>
                                </div>
                                <div className="text-xs text-stone-500">每镜结果独立卡片；可在此上传帧、抽尾帧、审片</div>
                            </div>
                            {project.shots.length ? (
                                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                    {project.shots.map((shot) => (
                                        <ShotResultCard
                                            key={`result-${shot.id}`}
                                            shot={shot}
                                            busy={Boolean(busyShotIds[shot.id]) || batchRunning}
                                            onChange={(patch) => updateShot(project.id, shot.id, patch)}
                                            onPickFrame={(role) => pickFrameFile(shot.id, role)}
                                            onClearFrame={(role) => setShotFrame(project.id, shot.id, role, undefined)}
                                            onGenerateFrame={() => void handleGenerateFirstFrame(shot)}
                                            onGenerateVideo={() => void handleGenerateVideo(shot)}
                                            onExtract={(position) => void handleExtractFrame(shot, position)}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分镜结果" />
                            )}
                            {project.assemble?.status === "error" ? <div className="text-sm text-red-500">{project.assemble.error}</div> : null}
                            {project.assemble?.status === "done" && (project.assemble.videoUrl || project.assemble.storageKey) ? (
                                <div className="space-y-2">
                                    <div className="text-sm font-medium">成片预览</div>
                                    <AssemblePreview storageKey={project.assemble.storageKey} url={project.assemble.videoUrl} />
                                </div>
                            ) : null}
                        </section>
                    </div>
                )}
            </div>
            </div>
            </div>
        </div>
    );
}

/** 单镜时长控件：预设 + 自定义秒数，仅改本镜。 */
function ShotDurationControl({
    value,
    onChange,
    compact = false,
}: {
    value: number;
    onChange: (sec: number) => void;
    compact?: boolean;
}) {
    const sec = normalizeDurationSec(value);
    return (
        <div className={`flex flex-wrap items-center gap-1.5 ${compact ? "" : "gap-2"}`}>
            {!compact ? <span className="text-xs text-stone-500">本镜时长</span> : null}
            <div className="flex flex-wrap gap-1">
                {LONGFORM_DURATION_OPTIONS.map((option) => (
                    <button
                        key={option}
                        type="button"
                        className={`h-7 rounded-full border px-2.5 text-xs transition ${sec === option ? "border-stone-900 text-stone-900 dark:border-stone-100 dark:text-stone-100" : "border-stone-200 text-stone-500 hover:border-stone-400 dark:border-stone-700 dark:hover:border-stone-500"}`}
                        onClick={() => onChange(option)}
                    >
                        {option}s
                    </button>
                ))}
            </div>
            <InputNumber
                size="small"
                min={1}
                max={18}
                className="!w-[4.5rem]"
                value={sec}
                addonAfter="s"
                onChange={(next) => onChange(normalizeDurationSec(next, 5))}
            />
            {!compact ? <span className="text-[11px] text-stone-400">1–18s，仅影响本镜</span> : null}
        </div>
    );
}

/** 分镜编辑：只改文案、时长与出场，不含媒体结果。 */
function ShotEditorCard({
    shot,
    characters,
    busy,
    onChange,
    onRemove,
    onGenerateFrame,
    onGenerateVideo,
}: {
    shot: LongformShot;
    characters: LongformCharacter[];
    busy: boolean;
    onChange: (patch: Partial<LongformShot>) => void;
    onRemove: () => void;
    onGenerateFrame: () => void;
    onGenerateVideo: () => void;
}) {
    const resolved = resolveShotCharacters(characters, shot);
    const explicit = Boolean(shot.characterIds?.length);
    const partial = characters.length > 1 && resolved.length > 0 && resolved.length < characters.length;

    return (
        <div className="rounded-2xl border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">#{shot.index + 1}</span>
                    <Input className="!w-48" size="small" value={shot.title} placeholder="标题" onChange={(event) => onChange({ title: event.target.value })} />
                    <Tag>{normalizeDurationSec(shot.durationSec)}s</Tag>
                    <StatusTag status={shot.status} />
                    {shot.chainFromShotId ? <Tag>链式</Tag> : null}
                    {partial ? <Tag color="purple">指定出场</Tag> : null}
                </div>
                <div className="flex flex-wrap gap-1">
                    <Button size="small" loading={busy} icon={<ImagePlus className="size-3.5" />} onClick={onGenerateFrame}>
                        {shot.firstFrame ? "重出首帧" : "出首帧"}
                    </Button>
                    <Button size="small" type="primary" loading={busy} disabled={!shot.firstFrame} icon={<Video className="size-3.5" />} onClick={onGenerateVideo}>
                        出视频
                    </Button>
                    <Button size="small" danger onClick={onRemove}>
                        删除
                    </Button>
                </div>
            </div>

            <div className="mb-3">
                <ShotDurationControl value={shot.durationSec} onChange={(durationSec) => onChange({ durationSec })} />
            </div>

            <div className="mb-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <label className="space-y-1 text-xs text-stone-500">
                    本镜出场角色
                    <Select
                        mode="multiple"
                        allowClear
                        className="w-full"
                        size="small"
                        placeholder={characters.length ? "空=自动匹配文案角色名" : "请先添加角色"}
                        value={shot.characterIds || []}
                        options={characters.map((item) => ({ value: item.id, label: item.name || "未命名" }))}
                        onChange={(value: string[]) => onChange({ characterIds: value.length ? value : undefined })}
                        disabled={!characters.length}
                    />
                </label>
                <div className="text-xs text-stone-500">
                    {explicit ? "手动" : "自动"} · {resolved.length ? resolved.map((item) => item.name).join("、") : "无"}
                </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                    <label className="space-y-1 text-xs text-stone-500">
                        场景
                        <Input size="small" value={shot.scene} onChange={(event) => onChange({ scene: event.target.value })} />
                    </label>
                    <label className="space-y-1 text-xs text-stone-500">
                        动作
                        <Input.TextArea rows={2} value={shot.action} onChange={(event) => onChange({ action: event.target.value })} />
                    </label>
                </div>
                <label className="space-y-1 text-xs text-stone-500">
                    镜头提示词
                    <Input.TextArea rows={4} value={shot.prompt} onChange={(event) => onChange({ prompt: event.target.value })} />
                </label>
            </div>
            {shot.error ? <div className="mt-2 text-xs text-red-500">{shot.error}</div> : null}
        </div>
    );
}

/** 单镜结果卡：首帧 / 尾帧 / 视频独立展示。 */
function ShotResultCard({
    shot,
    busy,
    onChange,
    onPickFrame,
    onClearFrame,
    onGenerateFrame,
    onGenerateVideo,
    onExtract,
}: {
    shot: LongformShot;
    busy: boolean;
    onChange: (patch: Partial<LongformShot>) => void;
    onPickFrame: (role: "firstFrame" | "lastFrame") => void;
    onClearFrame: (role: "firstFrame" | "lastFrame") => void;
    onGenerateFrame: () => void;
    onGenerateVideo: () => void;
    onExtract: (position: "first" | "last") => void;
}) {
    return (
        <div className="flex flex-col overflow-hidden rounded-2xl border border-stone-200 dark:border-stone-800">
            <div className="space-y-2 border-b border-stone-100 px-3 py-2 dark:border-stone-800">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                            #{shot.index + 1}
                            {shot.title ? ` · ${shot.title}` : ""}
                        </div>
                        <div className="truncate text-xs text-stone-500">{shot.action || shot.prompt || "暂无动作描述"}</div>
                    </div>
                    <StatusTag status={shot.status} />
                </div>
                <ShotDurationControl compact value={shot.durationSec} onChange={(durationSec) => onChange({ durationSec })} />
            </div>

            <div className="grid grid-cols-2 gap-px bg-stone-100 dark:bg-stone-800">
                <FrameSlot compact label="首帧" media={shot.firstFrame} onPick={() => onPickFrame("firstFrame")} onClear={() => onClearFrame("firstFrame")} />
                <FrameSlot compact label="尾帧" media={shot.lastFrame} onPick={() => onPickFrame("lastFrame")} onClear={() => onClearFrame("lastFrame")} />
            </div>
            <div className="border-t border-stone-100 dark:border-stone-800">
                <VideoSlot media={shot.video} tall />
            </div>

            <div className="flex flex-wrap gap-1 border-t border-stone-100 p-2 dark:border-stone-800">
                <Button size="small" loading={busy} icon={<ImagePlus className="size-3.5" />} onClick={onGenerateFrame}>
                    {shot.firstFrame ? "重出首帧" : "出首帧"}
                </Button>
                <Button size="small" type="primary" loading={busy} disabled={!shot.firstFrame} icon={<Video className="size-3.5" />} onClick={onGenerateVideo}>
                    出视频
                </Button>
                <Button size="small" disabled={!shot.video || busy} onClick={() => onExtract("last")}>
                    抽尾帧
                </Button>
                <Button size="small" disabled={!shot.video || busy} onClick={() => onExtract("first")}>
                    抽首帧
                </Button>
            </div>
            {shot.error ? <div className="px-3 pb-2 text-xs text-red-500">{shot.error}</div> : null}
        </div>
    );
}

function CharacterBibleEditor({
    characters,
    onChange,
    onOpenAssetPicker,
    isParsing = false,
}: {
    characters: LongformCharacter[];
    onChange: (characters: LongformCharacter[]) => void;
    onOpenAssetPicker?: () => void;
    isParsing?: boolean;
}) {
    const updateAt = (index: number, patch: Partial<LongformCharacter>) => {
        onChange(characters.map((item, i) => (i === index ? createEmptyCharacter({ ...item, ...patch, id: item.id }) : item)));
    };
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-stone-500">
                    角色圣经（多人）· 生成首帧/视频时按「本镜出场」注入
                </div>
                <div className="flex flex-wrap gap-1">
                    <Button
                        size="small"
                        icon={<ImagePlus className="size-3.5" />}
                        loading={isParsing}
                        onClick={onOpenAssetPicker}
                    >
                        解析资产库图片
                    </Button>
                    <Button
                        size="small"
                        icon={<Plus className="size-3.5" />}
                        onClick={() => onChange([...characters, createEmptyCharacter({ name: `角色${characters.length + 1}`, appearance: "" })])}
                    >
                        添加角色
                    </Button>
                </div>
            </div>
            {characters.length ? (
                <div className="space-y-2">
                    {characters.map((item, index) => (
                        <div key={item.id} className="grid gap-2 rounded-xl border border-stone-200 p-2 dark:border-stone-700 md:grid-cols-[120px_minmax(0,1fr)_auto] md:items-start">
                            <Input size="small" value={item.name} placeholder="姓名" onChange={(event) => updateAt(index, { name: event.target.value })} />
                            <Input.TextArea
                                size="small"
                                autoSize={{ minRows: 2, maxRows: 8 }}
                                className="!whitespace-pre-wrap break-words"
                                value={item.appearance}
                                placeholder="外貌、服装、年龄、标志物（可多行）"
                                onChange={(event) => updateAt(index, { appearance: event.target.value })}
                            />
                            <Button size="small" danger onClick={() => onChange(characters.filter((_, i) => i !== index))}>
                                删除
                            </Button>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-xl border border-dashed border-stone-300 px-3 py-4 text-xs text-stone-400 dark:border-stone-700">
                    暂无角色。可手动添加，或从资产库解析图片人物，或在剧本 JSON/Markdown 中写角色后「解析导入」。多人请分别填外貌，单人特写只勾选该角色。
                </div>
            )}
        </div>
    );
}

function FrameSlot({
    label,
    media,
    onPick,
    onClear,
    compact = false,
}: {
    label: string;
    media?: LongformMediaRef;
    onPick: () => void;
    onClear: () => void;
    compact?: boolean;
}) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let cancelled = false;
        void resolveMediaDisplayUrl(media).then((value) => {
            if (!cancelled) setUrl(value);
        });
        return () => {
            cancelled = true;
        };
    }, [media]);
    return (
        <div className={compact ? "bg-stone-50 dark:bg-stone-900" : "space-y-1"}>
            <div className={`flex items-center justify-between text-xs text-stone-500 ${compact ? "px-2 pt-2" : ""}`}>
                <span>{label}</span>
                <span className="flex gap-1">
                    <button type="button" className="hover:text-stone-900 dark:hover:text-stone-100" onClick={onPick}>
                        上传
                    </button>
                    {media ? (
                        <button type="button" className="hover:text-red-500" onClick={onClear}>
                            清除
                        </button>
                    ) : null}
                </span>
            </div>
            <div className={`flex aspect-video items-center justify-center overflow-hidden ${compact ? "bg-black/5 dark:bg-black/40" : "rounded-xl border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900"}`}>
                {url ? <img src={url} alt={label} className="size-full object-cover" /> : <span className="text-xs text-stone-400">空</span>}
            </div>
        </div>
    );
}

function VideoSlot({ media, tall = false }: { media?: LongformMediaRef; tall?: boolean }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let cancelled = false;
        void resolveMediaDisplayUrl(media).then((value) => {
            if (!cancelled) setUrl(value);
        });
        return () => {
            cancelled = true;
        };
    }, [media]);
    return (
        <div className={tall ? "" : "space-y-1"}>
            {!tall ? <div className="text-xs text-stone-500">镜头视频</div> : <div className="px-2 pt-2 text-xs text-stone-500">镜头视频</div>}
            <div className={`flex items-center justify-center overflow-hidden bg-black ${tall ? "aspect-video" : "aspect-video rounded-xl border border-stone-300 dark:border-stone-700"}`}>
                {url ? <video src={url} controls className="size-full object-contain" /> : <span className="text-xs text-stone-400">未生成</span>}
            </div>
        </div>
    );
}

function AssemblePreview({ storageKey, url }: { storageKey?: string; url?: string }) {
    const [src, setSrc] = useState(url || "");
    useEffect(() => {
        let cancelled = false;
        void resolveMediaDisplayUrl({ storageKey, url }).then((value) => {
            if (!cancelled) setSrc(value);
        });
        return () => {
            cancelled = true;
        };
    }, [storageKey, url]);
    if (!src) return null;
    return (
        <video src={src} controls className="max-h-64 w-full rounded-xl bg-black" />
    );
}

function StatusTag({ status }: { status: LongformShot["status"] }) {
    if (status === "ready") return <Tag color="success">就绪</Tag>;
    if (status === "generating") return <Tag color="processing">生成中</Tag>;
    if (status === "framed") return <Tag color="blue">已有帧</Tag>;
    if (status === "error") return <Tag color="error">失败</Tag>;
    return <Tag>草稿</Tag>;
}

function WorkflowSteps({
    step,
    stats,
    onBatchFrames,
    onBatchFramesAll,
    onBatchVideos,
    onAssemble,
    onDownload,
    onCancel,
    batchKind,
    assembleStatus,
    canDownload,
}: {
    step: number;
    stats: { total: number; withFrame: number; ready: number; missingFrames: number; readyForVideo: number };
    onBatchFrames: () => void;
    onBatchFramesAll: () => void;
    onBatchVideos: () => void;
    onAssemble: () => void;
    onDownload: () => void;
    onCancel: () => void;
    batchKind: BatchKind;
    assembleStatus?: string;
    canDownload: boolean;
}) {
    const items = [
        { id: 1, title: "分镜", desc: `${stats.total} 条` },
        { id: 2, title: "出首帧", desc: `${stats.withFrame}/${stats.total}` },
        { id: 3, title: "出视频", desc: `${stats.ready}/${stats.total}` },
        { id: 4, title: "成片", desc: assembleStatus === "done" ? "已导出" : "待拼接" },
    ];
    return (
        <section className="space-y-3 rounded-2xl border border-stone-200 p-4 dark:border-stone-800">
            <div className="text-sm font-medium text-stone-900 dark:text-stone-100">生产流程</div>
            <div className="grid gap-2 sm:grid-cols-4">
                {items.map((item) => {
                    const active = step === item.id;
                    const done = step > item.id || (item.id === 4 && assembleStatus === "done");
                    return (
                        <div
                            key={item.id}
                            className={`rounded-xl border px-3 py-2 ${active ? "border-stone-900 dark:border-stone-100" : "border-stone-200 dark:border-stone-700"} ${done ? "opacity-90" : ""}`}
                        >
                            <div className="text-xs text-stone-500">
                                {done ? "完成" : active ? "进行中" : "待办"} · {item.id}
                            </div>
                            <div className="text-sm font-medium text-stone-900 dark:text-stone-100">{item.title}</div>
                            <div className="text-xs text-stone-500">{item.desc}</div>
                        </div>
                    );
                })}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button type="primary" icon={<ImagePlus className="size-4" />} loading={batchKind === "frames"} disabled={batchKind === "videos" || stats.total < 1} onClick={onBatchFrames}>
                    ② 批量出首帧{stats.missingFrames ? `（缺 ${stats.missingFrames}）` : ""}
                </Button>
                <Button disabled={batchKind !== null || stats.withFrame < 1} onClick={onBatchFramesAll}>
                    全部重出首帧
                </Button>
                <Button icon={<Video className="size-4" />} loading={batchKind === "videos"} disabled={batchKind === "frames"} onClick={onBatchVideos}>
                    ③ 批量出视频{stats.readyForVideo ? `（${stats.readyForVideo}）` : ""}
                </Button>
                <Button icon={<Film className="size-4" />} disabled={stats.ready < 1 || batchKind !== null} loading={assembleStatus === "running"} onClick={onAssemble}>
                    ④ 拼接成片
                </Button>
                {canDownload ? (
                    <Button icon={<Download className="size-4" />} onClick={onDownload}>
                        下载成片
                    </Button>
                ) : null}
                {batchKind ? (
                    <Button danger onClick={onCancel}>
                        取消当前任务
                    </Button>
                ) : null}
            </div>
            <p className="!mb-0 text-xs leading-5 text-stone-500">
                分镜完成后请先走「批量出首帧」：只调用图片模型，不自动出视频。审完首帧后再出视频，便于控制跨镜一致性。
            </p>
        </section>
    );
}
