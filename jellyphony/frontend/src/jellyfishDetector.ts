/**
 * Jellyfish Detector — YOLOv8 Detection (bounding boxes) via ONNX Runtime Web
 * 
 * Simple bbox detection — no segmentation, no HSV.
 */
import * as ort from 'onnxruntime-web';

export interface BoundingBox {
    x1: number; y1: number;
    x2: number; y2: number;
}

export interface Detection {
    bbox: BoundingBox;
    centroid: { x: number; y: number };
    confidence: number;
}

export class JellyfishDetector {
    private session: ort.InferenceSession | null = null;
    private isLoading = false;
    private inputSize = 640;
    private canvas: HTMLCanvasElement;

    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.inputSize;
        this.canvas.height = this.inputSize;
    }

    async load(onProgress?: (pct: number) => void): Promise<void> {
        if (this.session || this.isLoading) return;
        this.isLoading = true;
        try {
            onProgress?.(10);
            this.session = await ort.InferenceSession.create('./model/best.onnx', {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });
            onProgress?.(90);
            console.log('[Detector] ONNX model loaded, outputs:', this.session.outputNames);

            // Warm up
            const dummy = new Float32Array(1 * 3 * this.inputSize * this.inputSize);
            const t = new ort.Tensor('float32', dummy, [1, 3, this.inputSize, this.inputSize]);
            await this.session.run({ [this.session.inputNames[0]]: t });
            console.log('[Detector] Warmed up');
            onProgress?.(100);
        } catch (err) {
            console.error('[Detector] Load failed:', err);
            throw err;
        } finally {
            this.isLoading = false;
        }
    }

    async detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<Detection[]> {
        if (!this.session) return [];

        const ctx = this.canvas.getContext('2d')!;
        ctx.drawImage(source, 0, 0, this.inputSize, this.inputSize);
        const imageData = ctx.getImageData(0, 0, this.inputSize, this.inputSize);

        const data = new Float32Array(3 * this.inputSize * this.inputSize);
        const px = imageData.data;
        const hw = this.inputSize * this.inputSize;
        for (let i = 0; i < hw; i++) {
            data[i] = px[i * 4] / 255;
            data[hw + i] = px[i * 4 + 1] / 255;
            data[2 * hw + i] = px[i * 4 + 2] / 255;
        }

        const input = new ort.Tensor('float32', data, [1, 3, this.inputSize, this.inputSize]);

        try {
            const results = await this.session.run({ [this.session.inputNames[0]]: input });
            return this.parse(results[this.session.outputNames[0]]);
        } catch (err) {
            console.error('[Detector] Inference error:', err);
            return [];
        }
    }

    private parse(output: ort.Tensor): Detection[] {
        const d = output.data as Float32Array;
        const dims = output.dims;
        if (dims.length !== 3) return [];

        const nVals = Number(dims[1]);
        const nAnchors = Number(dims[2]);
        const nClasses = nVals - 4;
        const minConf = 0.3;

        const candidates: Detection[] = [];
        for (let a = 0; a < nAnchors; a++) {
            const cx = d[0 * nAnchors + a];
            const cy = d[1 * nAnchors + a];
            const w = d[2 * nAnchors + a];
            const h = d[3 * nAnchors + a];

            let maxScore = 0;
            for (let c = 0; c < nClasses; c++) {
                const s = d[(4 + c) * nAnchors + a];
                if (s > maxScore) maxScore = s;
            }
            if (maxScore <= minConf) continue;

            const x1 = Math.max(0, Math.min(1, (cx - w / 2) / this.inputSize));
            const y1 = Math.max(0, Math.min(1, (cy - h / 2) / this.inputSize));
            const x2 = Math.max(0, Math.min(1, (cx + w / 2) / this.inputSize));
            const y2 = Math.max(0, Math.min(1, (cy + h / 2) / this.inputSize));

            candidates.push({
                bbox: { x1, y1, x2, y2 },
                centroid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
                confidence: maxScore,
            });
        }

        return this.nms(candidates, 0.45).slice(0, 30);
    }

    private nms(dets: Detection[], iouTh: number): Detection[] {
        const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
        const sel: Detection[] = [];
        while (sorted.length) {
            const cur = sorted.shift()!;
            sel.push(cur);
            for (let i = sorted.length - 1; i >= 0; i--) {
                if (this.iou(cur.bbox, sorted[i].bbox) > iouTh) sorted.splice(i, 1);
            }
        }
        return sel;
    }

    private iou(a: BoundingBox, b: BoundingBox): number {
        const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
        const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
        if (ix2 < ix1 || iy2 < iy1) return 0;
        const inter = (ix2 - ix1) * (iy2 - iy1);
        return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
    }

    dispose(): void { this.session = null; }
}
