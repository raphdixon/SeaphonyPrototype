/**
 * Squid Detector — YOLO v8 TF.js inference for squid detection
 * Adapted from squidcam's squidDetector.ts
 */
import * as tf from '@tensorflow/tfjs';

export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface Detection {
    bbox: BoundingBox;
    centroid: { x: number; y: number };
    confidence: number;
}

export class SquidDetector {
    private model: tf.GraphModel | null = null;
    private isLoading = false;
    private inputSize = 640;

    async load(onProgress?: (pct: number) => void): Promise<void> {
        if (this.model || this.isLoading) return;
        this.isLoading = true;

        try {
            const modelUrl = './model/model.json';
            this.model = await tf.loadGraphModel(modelUrl, {
                onProgress: (fraction) => {
                    onProgress?.(fraction * 100);
                },
            });
            console.log('[SquidDetector] Model loaded');

            // Warm up
            const dummy = tf.zeros([1, this.inputSize, this.inputSize, 3]);
            this.model.predict(dummy);
            dummy.dispose();
            console.log('[SquidDetector] Model warmed up');
        } catch (err) {
            console.error('[SquidDetector] Failed to load:', err);
            throw err;
        } finally {
            this.isLoading = false;
        }
    }

    detect(source: HTMLVideoElement | HTMLCanvasElement): Detection[] {
        if (!this.model) return [];

        const predData = tf.tidy(() => {
            const frame = tf.browser.fromPixels(source);
            const resized = tf.image.resizeBilinear(frame, [this.inputSize, this.inputSize]);
            const normalized = resized.div(255.0);
            const batched = normalized.expandDims(0);
            const predictions = this.model!.predict(batched) as tf.Tensor;
            return predictions.arraySync() as number[][][];
        });

        return this.parseOutput(predData);
    }

    private static readonly MAX_DETECTIONS = 30;

    private parseOutput(output: number[][][]): Detection[] {
        let detections: number[][];

        if (output[0].length === 5 || output[0].length === 6) {
            // [1, 5/6, N] — transpose needed
            detections = this.transpose(output[0]);
        } else {
            // [1, N, 5/6]
            detections = output[0];
        }

        const valid: Detection[] = [];
        const minConf = 0.3;

        for (const det of detections) {
            const conf = det.length > 4 ? det[4] : 0;
            if (conf <= minConf) continue;

            const [cx, cy, w, h] = det;
            const x1 = Math.max(0, Math.min(1, (cx - w / 2) / this.inputSize));
            const y1 = Math.max(0, Math.min(1, (cy - h / 2) / this.inputSize));
            const x2 = Math.max(0, Math.min(1, (cx + w / 2) / this.inputSize));
            const y2 = Math.max(0, Math.min(1, (cy + h / 2) / this.inputSize));

            valid.push({
                bbox: { x1, y1, x2, y2 },
                centroid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
                confidence: conf,
            });
        }

        const afterNms = this.nms(valid, 0.45);

        // Diagnostic: warn if detections seem anomalous
        if (afterNms.length > 50) {
            console.warn(
                `[SquidDetector] Anomalous detection count: ${afterNms.length} (pre-NMS: ${valid.length}). ` +
                `Possible TF.js corruption. Capping at ${SquidDetector.MAX_DETECTIONS}.`
            );
        }

        return afterNms.slice(0, SquidDetector.MAX_DETECTIONS);
    }

    private nms(dets: Detection[], iouThreshold: number): Detection[] {
        if (!dets.length) return [];
        const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
        const selected: Detection[] = [];

        while (sorted.length) {
            const current = sorted.shift()!;
            selected.push(current);
            for (let i = sorted.length - 1; i >= 0; i--) {
                if (this.iou(current.bbox, sorted[i].bbox) > iouThreshold) {
                    sorted.splice(i, 1);
                }
            }
        }
        return selected;
    }

    private iou(a: BoundingBox, b: BoundingBox): number {
        const ix1 = Math.max(a.x1, b.x1);
        const iy1 = Math.max(a.y1, b.y1);
        const ix2 = Math.min(a.x2, b.x2);
        const iy2 = Math.min(a.y2, b.y2);
        if (ix2 < ix1 || iy2 < iy1) return 0;
        const inter = (ix2 - ix1) * (iy2 - iy1);
        const aArea = (a.x2 - a.x1) * (a.y2 - a.y1);
        const bArea = (b.x2 - b.x1) * (b.y2 - b.y1);
        return inter / (aArea + bArea - inter);
    }

    private transpose(matrix: number[][]): number[][] {
        return matrix[0].map((_, c) => matrix.map((row) => row[c]));
    }

    dispose(): void {
        this.model?.dispose();
        this.model = null;
    }
}
