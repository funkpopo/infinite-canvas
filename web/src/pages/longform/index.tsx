import { Clapperboard, Download, Film, ImagePlus, LoaderCircle, Plus, Sparkles, Trash2, Upload, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Input, Select, Switch, Tag, Typography } from "antd";
import { saveAs } from "file-saver";

import { ModelPicker } from "@/components/model-picker";
import { preloadFfmpeg } from "@/lib/media/ffmpeg-frames";
import { normalizeDurationSec } from "@/lib/longform/script";
import {
    assembleProjectVideos,
    extractShotFrame,
    generateShotFirstFrame,
    generateShotVideo,
    resolveMediaDisplayUrl,
    selectShotsForFirstFrame,
    selectShotsForVideo,
    structureScriptWithLlm,
    blobToMediaRef,
} from "@/lib/longform/generation";
import { getMediaBlob } from "@/services/file-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { selectActiveLongformProject, useLongformStore } from "@/stores/use-longform-store";
import type { LongformMediaRef, LongformShot } from "@/types/longform";

type BatchKind = "frames" | "videos" | null;

const DURATION_OPTIONS = [
    { value: 3, label: "3s" },
    { value: 5, label: "5s" },
    { value: 10, label: "10s" },
    { value: 18, label: "18s" },
];

const RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4"].map((value) => ({ value, label: value }));
const RESOLUTION_OPTIONS = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
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
    const updateShot = useLongformStore((state) => state.updateShot);
    const addShot = useLongformStore((state) => state.addShot);
    const removeShot = useLongformStore((state) => state.removeShot);
    const importScript = useLongformStore((state) => state.importScript);
    const replaceShotsFromDrafts = useLongformStore((state) => state.replaceShotsFromDrafts);
    const setShotFrame = useLongformStore((state) => state.setShotFrame);
    const setShotVideo = useLongformStore((state) => state.setShotVideo);
    const setAssemble = useLongformStore((state) => state.setAssemble);

    const [busyShotId, setBusyShotId] = useState<string | null>(null);
    const [batchKind, setBatchKind] = useState<BatchKind>(null);
    const [structuring, setStructuring] = useState(false);
    const [structurePreview, setStructurePreview] = useState("");
    const [statusText, setStatusText] = useState("");
    const abortRef = useRef<AbortController | null>(null);
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
        const count = importScript(project.id, project.scriptRaw, "import");
        if (!count) {
            message.warning("未能解析出分镜，可改用 AI 拆解或 JSON 格式");
            return;
        }
        message.success(`已导入 ${count} 个镜头。下一步：确认分镜后批量出首帧`);
    };

    const handleStructure = async () => {
        if (!project?.scriptRaw.trim()) {
            message.warning("请先填写剧本原文");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, textModel)) {
            openConfigDialog();
            return;
        }
        setStructuring(true);
        setStructurePreview("");
        setStatusText("正在用文本模型拆解分镜…");
        try {
            const textConfig = { ...effectiveConfig, model: textModel };
            const result = await structureScriptWithLlm(textConfig, project, (delta) => setStructurePreview((prev) => prev + delta));
            if (!result.shots.length) throw new Error("模型没有返回可用分镜");
            replaceShotsFromDrafts(project.id, result.shots, {
                styleBible: result.styleBible,
                characterBible: result.characterBible,
                scriptSource: "generated",
                scriptRaw: project.scriptRaw,
            });
            message.success(`已生成 ${result.shots.length} 个分镜。请检查后点击「批量出首帧」`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "分镜拆解失败");
        } finally {
            setStructuring(false);
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

    const beginAbortable = () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        return controller;
    };

    const cancelRunning = () => {
        abortRef.current?.abort();
        setBatchKind(null);
        setBusyShotId(null);
        setStatusText("");
    };

    /** 仅出首帧，不触发出视频。 */
    const runFirstFrameOnly = async (shot: LongformShot, signal?: AbortSignal) => {
        if (!project) return;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            openConfigDialog();
            throw new Error("请先配置图片模型");
        }
        setBusyShotId(shot.id);
        updateShot(project.id, shot.id, { status: "generating", error: undefined });
        setStatusText(`镜头 ${shot.index + 1}：生成首帧…`);
        try {
            const latestProject = useLongformStore.getState().projects.find((item) => item.id === project.id) || project;
            const frame = await generateShotFirstFrame(effectiveConfig, latestProject, shot, signal);
            setShotFrame(project.id, shot.id, "firstFrame", frame);
            updateShot(project.id, shot.id, { status: "framed", error: undefined });
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                updateShot(project.id, shot.id, { status: shot.firstFrame ? "framed" : "draft" });
                throw error;
            }
            const text = error instanceof Error ? error.message : "首帧生成失败";
            updateShot(project.id, shot.id, { status: "error", error: text });
            message.error(`镜头 ${shot.index + 1}：${text}`);
            throw error;
        } finally {
            setBusyShotId(null);
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
        setBusyShotId(shot.id);
        updateShot(project.id, shot.id, { status: "generating", error: undefined });
        try {
            const latestProject = useLongformStore.getState().projects.find((item) => item.id === project.id) || project;
            let current = latestProject.shots.find((item) => item.id === shot.id) || shot;
            setStatusText(`镜头 ${current.index + 1}：生成视频…`);
            const video = await generateShotVideo(effectiveConfig, latestProject, current, {
                signal,
                onStatus: (text) => setStatusText(`镜头 ${current.index + 1}：${text}`),
            });
            setShotVideo(project.id, current.id, video, "ready");
            current = { ...current, video, status: "ready" };

            const after = useLongformStore.getState().projects.find((item) => item.id === project.id);
            if (after?.chainMode) {
                setStatusText(`镜头 ${current.index + 1}：抽取尾帧并衔接下镜…`);
                const last = await extractShotFrame(current, "last");
                setShotFrame(project.id, current.id, "lastFrame", last);
                const next = after.shots.find((item) => item.index === current.index + 1);
                // 链式只在下镜尚无独立首帧时写入，避免覆盖人工/批量已出的首帧
                if (next && !next.firstFrame) {
                    setShotFrame(project.id, next.id, "firstFrame", last);
                    updateShot(project.id, next.id, { chainFromShotId: current.id, status: next.video ? next.status : "framed" });
                }
            }
            message.success(`镜头 ${current.index + 1} 视频已完成`);
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                updateShot(project.id, shot.id, { status: shot.video ? "ready" : shot.firstFrame ? "framed" : "draft" });
                throw error;
            }
            const text = error instanceof Error ? error.message : "视频生成失败";
            setShotVideo(project.id, shot.id, shot.video, "error", text);
            message.error(`镜头 ${shot.index + 1}：${text}`);
            throw error;
        } finally {
            setBusyShotId(null);
        }
    };

    const handleGenerateFirstFrame = async (shot: LongformShot) => {
        const controller = beginAbortable();
        try {
            await runFirstFrameOnly(shot, controller.signal);
            message.success(`镜头 ${shot.index + 1} 首帧已生成`);
        } catch {
            // messaged
        } finally {
            setStatusText("");
        }
    };

    const handleGenerateVideo = async (shot: LongformShot) => {
        const controller = beginAbortable();
        try {
            await runVideoOnly(shot, controller.signal);
        } catch {
            // messaged
        } finally {
            setStatusText("");
        }
    };

    const handleExtractFrame = async (shot: LongformShot, position: "first" | "last") => {
        if (!project || !shot.video) {
            message.warning("请先生成该镜头视频");
            return;
        }
        setBusyShotId(shot.id);
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
            setBusyShotId(null);
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
            const controller = beginAbortable();
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
            const controller = beginAbortable();
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

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
            <input ref={frameInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void onFrameFile(event.target.files)} />

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
                            <div className="grid gap-3 md:grid-cols-2">
                                <label className="space-y-1 text-sm">
                                    <span className="text-stone-500">风格圣经</span>
                                    <Input.TextArea rows={2} value={project.styleBible} placeholder="统一画风、调色、时代感" onChange={(event) => updateProject(project.id, { styleBible: event.target.value })} />
                                </label>
                                <label className="space-y-1 text-sm">
                                    <span className="text-stone-500">角色圣经</span>
                                    <Input.TextArea rows={2} value={project.characterBible} placeholder="角色外貌、服装、年龄" onChange={(event) => updateProject(project.id, { characterBible: event.target.value })} />
                                </label>
                            </div>
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
                                    <Button icon={<Upload className="size-4" />} onClick={handleImportParse}>
                                        解析导入
                                    </Button>
                                    <Button type="primary" icon={<Sparkles className="size-4" />} loading={structuring} onClick={() => void handleStructure()}>
                                        AI 拆解分镜
                                    </Button>
                                </div>
                            </div>
                            <Input.TextArea
                                rows={6}
                                value={project.scriptRaw}
                                placeholder={"粘贴剧本 / Markdown / JSON。例如：\n## 镜头 1\n场景：雨夜街道\n动作：女孩撑伞转身\n\n或 JSON：{ \"shots\": [{ \"action\": \"...\", \"durationSec\": 5 }] }"}
                                onChange={(event) => updateProject(project.id, { scriptRaw: event.target.value })}
                            />
                            {structurePreview ? (
                                <pre className="max-h-40 overflow-auto rounded-xl bg-stone-50 p-3 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">{structurePreview}</pre>
                            ) : null}
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
                            <div className="rounded-xl bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600 dark:bg-stone-900/60 dark:text-stone-300">
                                <span className="font-medium text-stone-800 dark:text-stone-100">首帧流程：</span>
                                分镜确认后点「批量出首帧」→ 串行用图片模型生成各镜首帧 → 人工审阅（单镜「出首帧」重做 / 上传替换）→ 再「批量出视频」。链式衔接不会覆盖已有首帧。
                            </div>
                            {statusText ? (
                                <div className="flex items-center gap-2 text-sm text-stone-500">
                                    <LoaderCircle className="size-4 animate-spin" />
                                    {statusText}
                                </div>
                            ) : null}
                            {project.assemble?.status === "error" ? <div className="text-sm text-red-500">{project.assemble.error}</div> : null}
                            {project.assemble?.status === "done" && (project.assemble.videoUrl || project.assemble.storageKey) ? <AssemblePreview storageKey={project.assemble.storageKey} url={project.assemble.videoUrl} /> : null}

                            <div className="space-y-3">
                                {project.shots.map((shot) => (
                                    <ShotCard
                                        key={shot.id}
                                        shot={shot}
                                        busy={busyShotId === shot.id || batchRunning}
                                        onChange={(patch) => updateShot(project.id, shot.id, patch)}
                                        onRemove={() => removeShot(project.id, shot.id)}
                                        onPickFrame={(role) => pickFrameFile(shot.id, role)}
                                        onClearFrame={(role) => setShotFrame(project.id, shot.id, role, undefined)}
                                        onGenerateFrame={() => void handleGenerateFirstFrame(shot)}
                                        onGenerateVideo={() => void handleGenerateVideo(shot)}
                                        onExtract={(position) => void handleExtractFrame(shot, position)}
                                    />
                                ))}
                            </div>
                        </section>
                    </div>
                )}
            </div>
        </div>
    );
}

function ShotCard({
    shot,
    busy,
    onChange,
    onRemove,
    onPickFrame,
    onClearFrame,
    onGenerateFrame,
    onGenerateVideo,
    onExtract,
}: {
    shot: LongformShot;
    busy: boolean;
    onChange: (patch: Partial<LongformShot>) => void;
    onRemove: () => void;
    onPickFrame: (role: "firstFrame" | "lastFrame") => void;
    onClearFrame: (role: "firstFrame" | "lastFrame") => void;
    onGenerateFrame: () => void;
    onGenerateVideo: () => void;
    onExtract: (position: "first" | "last") => void;
}) {
    return (
        <div className="rounded-2xl border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">#{shot.index + 1}</span>
                    <Input className="!w-48" size="small" value={shot.title} onChange={(event) => onChange({ title: event.target.value })} />
                    <StatusTag status={shot.status} />
                    {shot.chainFromShotId ? <Tag>链式</Tag> : null}
                </div>
                <div className="flex flex-wrap gap-1">
                    <Select
                        size="small"
                        className="!w-20"
                        value={shot.durationSec}
                        options={DURATION_OPTIONS}
                        onChange={(value) => onChange({ durationSec: normalizeDurationSec(value) })}
                    />
                    <Button size="small" loading={busy} icon={<ImagePlus className="size-3.5" />} onClick={onGenerateFrame}>
                        {shot.firstFrame ? "重出首帧" : "出首帧"}
                    </Button>
                    <Button size="small" type="primary" loading={busy} disabled={!shot.firstFrame} icon={<Video className="size-3.5" />} onClick={onGenerateVideo}>
                        出视频
                    </Button>
                    <Button size="small" disabled={!shot.video || busy} onClick={() => onExtract("last")}>
                        抽尾帧
                    </Button>
                    <Button size="small" danger onClick={onRemove}>
                        删除
                    </Button>
                </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_1fr_160px_160px_200px]">
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
                    视频提示词
                    <Input.TextArea rows={4} value={shot.prompt} onChange={(event) => onChange({ prompt: event.target.value })} />
                </label>
                <FrameSlot label="首帧" media={shot.firstFrame} onPick={() => onPickFrame("firstFrame")} onClear={() => onClearFrame("firstFrame")} />
                <FrameSlot label="尾帧" media={shot.lastFrame} onPick={() => onPickFrame("lastFrame")} onClear={() => onClearFrame("lastFrame")} />
                <VideoSlot media={shot.video} />
            </div>
            {shot.error ? <div className="mt-2 text-xs text-red-500">{shot.error}</div> : null}
        </div>
    );
}

function FrameSlot({ label, media, onPick, onClear }: { label: string; media?: LongformMediaRef; onPick: () => void; onClear: () => void }) {
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
        <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-stone-500">
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
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
                {url ? <img src={url} alt={label} className="size-full object-cover" /> : <span className="text-xs text-stone-400">空</span>}
            </div>
        </div>
    );
}

function VideoSlot({ media }: { media?: LongformMediaRef }) {
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
        <div className="space-y-1">
            <div className="text-xs text-stone-500">镜头视频</div>
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-stone-300 bg-black/90 dark:border-stone-700">
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
