import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorage } from "@/lib/localforage-storage";
import { buildShotsFromDrafts, createEmptyCharacter, normalizeDurationSec } from "@/lib/longform/script";
import type { LongformCharacter, LongformMediaRef, LongformProject, LongformScene, LongformShot, LongformShotDraft } from "@/types/longform";

const STORE_KEY = "infinite-canvas:longform_projects";

type LongformStore = {
    projects: LongformProject[];
    activeProjectId: string | null;
    createProject: (title?: string) => string;
    deleteProject: (id: string) => void;
    setActiveProject: (id: string | null) => void;
    updateProject: (id: string, patch: Partial<Omit<LongformProject, "id" | "createdAt" | "shots">>) => void;
    setCharacters: (projectId: string, characters: LongformCharacter[]) => void;
    setScenes: (projectId: string, scenes: LongformScene[]) => void;
    setShots: (projectId: string, shots: LongformShot[]) => void;
    updateShot: (projectId: string, shotId: string, patch: Partial<LongformShot>) => void;
    addShot: (projectId: string, draft?: LongformShotDraft) => string;
    removeShot: (projectId: string, shotId: string) => void;
    replaceShotsFromDrafts: (
        projectId: string,
        drafts: LongformShotDraft[],
        meta?: {
            styleBible?: string;
            characters?: LongformCharacter[];
            scenes?: LongformScene[];
            scriptSource?: LongformProject["scriptSource"];
            scriptRaw?: string;
        },
    ) => void;
    setShotFrame: (projectId: string, shotId: string, role: "firstFrame" | "lastFrame", media?: LongformMediaRef) => void;
    setShotVideo: (projectId: string, shotId: string, video?: LongformMediaRef, status?: LongformShot["status"], error?: string) => void;
    setAssemble: (projectId: string, assemble: LongformProject["assemble"]) => void;
};

function normalizeProject(raw: LongformProject & { characterBible?: string }): LongformProject {
    // 丢弃旧字段 characterBible，不再回填/迁移
    const { characterBible: _legacy, ...project } = raw;
    const characters = Array.isArray(project.characters) ? project.characters.map((item) => createEmptyCharacter(item)) : [];
    return {
        ...project,
        characters,
        scenes: Array.isArray(project.scenes) ? project.scenes : [],
        shots: (project.shots || []).map((shot, index) => ({
            ...shot,
            index,
            durationSec: normalizeDurationSec(shot.durationSec),
            characterIds: shot.characterIds?.length ? shot.characterIds : undefined,
        })),
    };
}

function touch(project: LongformProject, patch: Partial<LongformProject> = {}): LongformProject {
    return { ...project, ...patch, updatedAt: Date.now() };
}

function reindex(shots: LongformShot[]) {
    return shots.map((shot, index) => ({ ...shot, index }));
}

export const useLongformStore = create<LongformStore>()(
    persist(
        (set, get) => ({
            projects: [],
            activeProjectId: null,
            createProject: (title = "未命名长片") => {
                const now = Date.now();
                const project: LongformProject = {
                    id: nanoid(),
                    title,
                    styleBible: "",
                    characters: [],
                    scenes: [],
                    aspectRatio: "16:9",
                    resolution: "720",
                    fps: 24,
                    scriptSource: "manual",
                    scriptRaw: "",
                    chainMode: true,
                    shots: [],
                    assemble: { status: "idle" },
                    createdAt: now,
                    updatedAt: now,
                };
                set((state) => ({ projects: [project, ...state.projects], activeProjectId: project.id }));
                return project.id;
            },
            deleteProject: (id) => {
                set((state) => ({
                    projects: state.projects.filter((item) => item.id !== id),
                    activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
                }));
            },
            setActiveProject: (id) => set({ activeProjectId: id }),
            updateProject: (id, patch) => {
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== id) return project;
                        const next = touch(project, patch);
                        if (patch.characters) next.characters = patch.characters.map((item) => createEmptyCharacter(item));
                        return next;
                    }),
                }));
            },
            setCharacters: (projectId, characters) => {
                get().updateProject(projectId, { characters: characters.map((item) => createEmptyCharacter(item)) });
            },
            setScenes: (projectId, scenes) => get().updateProject(projectId, { scenes }),
            setShots: (projectId, shots) => {
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === projectId ? touch(project, { shots: reindex(shots) }) : project)),
                }));
            },
            updateShot: (projectId, shotId, patch) => {
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        return touch(project, {
                            shots: project.shots.map((shot) => {
                                if (shot.id !== shotId) return shot;
                                const next = { ...shot, ...patch };
                                if (patch.durationSec != null) next.durationSec = normalizeDurationSec(patch.durationSec);
                                return next;
                            }),
                        });
                    }),
                }));
            },
            addShot: (projectId, draft) => {
                const id = nanoid();
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const [shot] = buildShotsFromDrafts([draft || {}], project.characters || []);
                        return touch(project, { shots: [...project.shots, { ...shot, id, index: project.shots.length }] });
                    }),
                }));
                return id;
            },
            removeShot: (projectId, shotId) => {
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        return touch(project, { shots: reindex(project.shots.filter((shot) => shot.id !== shotId)) });
                    }),
                }));
            },
            replaceShotsFromDrafts: (projectId, drafts, meta = {}) => {
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const characters = meta.characters?.length
                            ? meta.characters.map((item) => createEmptyCharacter(item))
                            : project.characters || [];
                        const lockCast = Boolean(meta.characters?.length) || drafts.some((draft) => draft.characterNames?.length);
                        const shots = buildShotsFromDrafts(drafts, characters, { lockCast });
                        return touch(project, {
                            shots,
                            scriptSource: meta.scriptSource || project.scriptSource,
                            scriptRaw: meta.scriptRaw ?? project.scriptRaw,
                            styleBible: meta.styleBible?.trim() || project.styleBible,
                            characters,
                            scenes: meta.scenes?.length ? meta.scenes : project.scenes,
                            assemble: { status: "idle" },
                        });
                    }),
                }));
            },
            setShotFrame: (projectId, shotId, role, media) => {
                const shot = get().projects.find((p) => p.id === projectId)?.shots.find((s) => s.id === shotId);
                const nextFirst = role === "firstFrame" ? media : shot?.firstFrame;
                const nextLast = role === "lastFrame" ? media : shot?.lastFrame;
                const status = shot?.video && shot.status === "ready" ? "ready" : shot?.status === "generating" ? "generating" : nextFirst || nextLast || shot?.video ? "framed" : "draft";
                get().updateShot(projectId, shotId, { [role]: media, status, error: undefined });
            },
            setShotVideo: (projectId, shotId, video, status, error) => {
                get().updateShot(projectId, shotId, {
                    video,
                    status: status || (video ? "ready" : "draft"),
                    error,
                });
            },
            setAssemble: (projectId, assemble) => {
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === projectId ? touch(project, { assemble }) : project)),
                }));
            },
        }),
        {
            name: STORE_KEY,
            storage: createJSONStorage(() => localForageStorage),
            partialize: (state) => ({ projects: state.projects, activeProjectId: state.activeProjectId }),
            merge: (persisted, current) => {
                const data = (persisted || {}) as Partial<LongformStore>;
                const projects = Array.isArray(data.projects) ? data.projects.map((project) => normalizeProject(project as LongformProject)) : current.projects;
                return {
                    ...current,
                    ...data,
                    projects,
                    activeProjectId: data.activeProjectId ?? current.activeProjectId,
                };
            },
        },
    ),
);

export function selectActiveLongformProject(state: { projects: LongformProject[]; activeProjectId: string | null }) {
    return state.projects.find((item) => item.id === state.activeProjectId) || null;
}
