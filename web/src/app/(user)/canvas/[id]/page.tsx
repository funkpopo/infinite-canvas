import { Suspense } from "react";

import CanvasClientPage from "./canvas-client-page";

export default function CanvasPage() {
    return (
        <Suspense fallback={<main className="relative h-full min-h-0 overflow-hidden bg-background text-foreground" />}>
            <CanvasClientPage />
        </Suspense>
    );
}
