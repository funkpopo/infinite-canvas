import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorage } from "@/lib/localforage-storage";
import { createEmptyShot, parseScriptToShotDrafts } from "@/lib/longform/script";
import type { LongformMediaRef, LongformProject, LongformShot, LongformShotDraft } from "@/types/longform";

const STORE_KEY = "infinite-canvas:longform_projects";

type LongformStore = {
    projects: LongformProject[];
    activeProjectId: string | null;
    createProject: (title?: string) => string;
    deleteProject: (id: string) => void;
    setActiveProject: (id: string | null) => void;
    updateProject: (id: string, patch: Partial<Omit<LongformProject, "id" | "createdAt" | "shots">>) => void;
    setShots: (projectId: string, shots: LongformShot[]) => void;
    updateShot: (projectId: string, shotId: string, patch: Partial<LongformShot>) => void;
    addShot: (projectId: string, draft?: LongformShotDraft) => string;
    removeShot: (projectId: string, shotId: string) => void;
    importScript: (projectId: string, raw: string, source?: LongformProject["scriptSource"]) => number;
    replaceShotsFromDrafts: (projectId: string, drafts: LongformShotDraft[], meta?: { styleBible?: string; characterBible?: string; scriptSource?: LongformProject["scriptSource"]; scriptRaw?: string }) => void;
    setShotFrame: (projectId: string, shotId: string, role: "firstFrame" | "lastFrame", media?: LongformMediaRef) => void;
    setShotVideo: (projectId: string, shotId: string, video?: LongformMediaRef, status?: LongformShot["status"], error?: string) => void;
    setAssemble: (projectId: string, assemble: LongformProject["assemble"]) => void;
};

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
                    characterBible: "",
                    aspectRatio: "16:9",
                    resolution: "720",
                    fps: 24,
                    scriptSource: "manual",
                    scriptRaw: "",
                    chainMode: true,
                    shots: [createEmptyShot(0), createEmptyShot(1), createEmptyShot(2)],
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
                    projects: state.projects.map((project) => (project.id === id ? touch(project, patch) : project)),
                }));
            },
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
                            shots: project.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)),
                        });
                    }),
                }));
            },
            addShot: (projectId, draft) => {
                const id = nanoid();
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const shot = { ...createEmptyShot(project.shots.length, draft), id };
                        return touch(project, { shots: [...project.shots, shot] });
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
            importScript: (projectId, raw, source = "import") => {
                const drafts = parseScriptToShotDrafts(raw);
                if (!drafts.length) return 0;
                get().replaceShotsFromDrafts(projectId, drafts, { scriptSource: source, scriptRaw: raw });
                return drafts.length;
            },
            replaceShotsFromDrafts: (projectId, drafts, meta = {}) => {
                const shots = drafts.map((draft, index) => createEmptyShot(index, draft));
                set((state) => ({
                    projects: state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        return touch(project, {
                            shots,
                            scriptSource: meta.scriptSource || project.scriptSource,
                            scriptRaw: meta.scriptRaw ?? project.scriptRaw,
                            styleBible: meta.styleBible?.trim() || project.styleBible,
                            characterBible: meta.characterBible?.trim() || project.characterBible,
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
        },
    ),
);

export function selectActiveLongformProject(state: { projects: LongformProject[]; activeProjectId: string | null }) {
    return state.projects.find((project) => project.id === state.activeProjectId) || null;
}
