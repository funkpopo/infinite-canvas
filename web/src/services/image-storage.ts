import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await fetchImageBlob(input) : input;
    return storeImageBlob(blob);
}

async function storeImageBlob(blob: Blob): Promise<UploadedImage> {
    const imageBlob = await normalizeImageBlob(blob);
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, imageBlob);
    const url = URL.createObjectURL(imageBlob);
    objectUrls.set(storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: imageBlob.size, mimeType: imageBlob.type || meta.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const imageBlob = await normalizeImageBlob(blob).catch(() => null);
    if (!imageBlob) return fallback;
    if (imageBlob !== blob) await store.setItem(storageKey, imageBlob);
    const url = URL.createObjectURL(imageBlob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return null;
    const imageBlob = await normalizeImageBlob(blob).catch(() => null);
    if (imageBlob && imageBlob !== blob) await store.setItem(storageKey, imageBlob);
    return imageBlob;
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    const imageBlob = await normalizeImageBlob(blob);
    await store.setItem(storageKey, imageBlob);
    const url = URL.createObjectURL(imageBlob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url));
}

export async function resolveDisplayImageUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    return proxiedImageUrl(url);
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

async function fetchImageBlob(url: string) {
    const response = await fetch(proxiedImageUrl(url));
    if (!response.ok) throw new Error(`${isRemoteUrl(url) ? "读取远程图片失败" : "读取图片失败"}：${response.status}`);
    return normalizeImageBlob(await response.blob());
}

function isRemoteUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

function proxiedImageUrl(url: string) {
    return url;
}

async function normalizeImageBlob(blob: Blob) {
    if (blob.type.startsWith("image/")) return blob;
    const mimeType = await sniffImageMimeType(blob);
    if (!mimeType) throw new Error("读取到的内容不是图片");
    return new Blob([blob], { type: mimeType });
}

async function sniffImageMimeType(blob: Blob) {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    return "";
}
