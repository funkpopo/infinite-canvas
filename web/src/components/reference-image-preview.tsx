"use client";

import { useEffect, useState } from "react";

import { resolveDisplayImageUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export function ReferenceImagePreview({ image, className }: { image: ReferenceImage; className?: string }) {
    const [src, setSrc] = useState("");

    useEffect(() => {
        let alive = true;
        setSrc("");
        void resolveDisplayImageUrl(image).then((url) => {
            if (alive) setSrc(url);
        });
        return () => {
            alive = false;
        };
    }, [image]);

    return src ? <img src={src} alt={image.name} className={className} /> : <div className={className} />;
}
