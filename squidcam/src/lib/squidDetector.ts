import * as tf from '@tensorflow/tfjs';

export type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface DetectionResult {
    bbox: BoundingBox;
    centroid: { x: number; y: number };
    quadrant: Quadrant;
    confidence: number;
}

export class SquidDetector {
    private model: tf.GraphModel | null = null;
    private isLoading = false;
    private inputSize = 640;

    async load(): Promise<void> {
        if (this.model || this.isLoading) return;

        this.isLoading = true;
        try {
            // Load the YOLOv8 TF.js model from public folder
            // The model files need to be copied to public/model/
            const modelUrl = '/model/model.json';
            this.model = await tf.loadGraphModel(modelUrl);
            console.log('YOLOv8 model loaded successfully');

            // Warm up the model
            const dummyInput = tf.zeros([1, this.inputSize, this.inputSize, 3]);
            await this.model.predict(dummyInput);
            dummyInput.dispose();
            console.log('Model warmed up');
        } catch (error) {
            console.error('Failed to load model:', error);
            throw error;
        } finally {
            this.isLoading = false;
        }
    }

    async detect(video: HTMLVideoElement): Promise<DetectionResult[]> {
        if (!this.model) return [];

        // Use tf.tidy for tensor memory management
        const predData = tf.tidy(() => {
            // Get video frame as tensor
            const frame = tf.browser.fromPixels(video);

            // Resize to model input size
            const resized = tf.image.resizeBilinear(frame, [this.inputSize, this.inputSize]);

            // Normalize to 0-1 range
            const normalized = resized.div(255.0);

            // Add batch dimension
            const batched = normalized.expandDims(0);

            // Run inference
            const predictions = this.model!.predict(batched) as tf.Tensor;

            return predictions.arraySync() as number[][][];
        });

        // Parse detections (outside tf.tidy)
        return this.parseYoloOutput(predData, video.videoWidth, video.videoHeight);
    }

    private parseYoloOutput(
        output: number[][][],
        videoWidth: number,
        videoHeight: number
    ): DetectionResult[] {
        // Handle different YOLOv8 output formats
        let detections: number[][] = [];

        if (output[0].length === 5 || output[0].length === 6) {
            // Format: [1, 5/6, num_detections] - need to transpose
            const transposed = this.transpose(output[0]);
            detections = transposed;
        } else {
            // Format: [1, num_detections, 5/6]
            detections = output[0];
        }

        const validDetections: DetectionResult[] = [];
        const minConfidence = 0.3; // Minimum confidence threshold

        for (const det of detections) {
            // YOLOv8 outputs: [x_center, y_center, width, height, ...class_scores]
            const confidence = det.length > 4 ? det[4] : 0;

            if (confidence > minConfidence) {
                const [cx, cy, w, h] = det;

                // Convert from center format to corner format
                // Normalize to 0-1 range
                const x1 = (cx - w / 2) / this.inputSize;
                const y1 = (cy - h / 2) / this.inputSize;
                const x2 = (cx + w / 2) / this.inputSize;
                const y2 = (cy + h / 2) / this.inputSize;

                const bbox = {
                    x1: Math.max(0, Math.min(1, x1)),
                    y1: Math.max(0, Math.min(1, y1)),
                    x2: Math.max(0, Math.min(1, x2)),
                    y2: Math.max(0, Math.min(1, y2)),
                };

                const centroid = {
                    x: (bbox.x1 + bbox.x2) / 2,
                    y: (bbox.y1 + bbox.y2) / 2,
                };

                const quadrant = this.getQuadrant(centroid.x, centroid.y);

                validDetections.push({ bbox, centroid, quadrant, confidence });
            }
        }

        // Apply Non-Maximum Suppression (NMS)
        return this.nonMaxSuppression(validDetections, 0.45); // IoU threshold 0.45
    }

    private nonMaxSuppression(detections: DetectionResult[], iouThreshold: number): DetectionResult[] {
        if (detections.length === 0) return [];

        // Sort by confidence (descending)
        const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
        const selected: DetectionResult[] = [];

        while (sorted.length > 0) {
            const current = sorted.shift()!;
            selected.push(current);

            // Filter out detections with high IoU with current
            for (let i = sorted.length - 1; i >= 0; i--) {
                const other = sorted[i];
                if (this.calculateIoU(current.bbox, other.bbox) > iouThreshold) {
                    sorted.splice(i, 1);
                }
            }
        }
        return selected;
    }

    private calculateIoU(box1: BoundingBox, box2: BoundingBox): number {
        const x1 = Math.max(box1.x1, box2.x1);
        const y1 = Math.max(box1.y1, box2.y1);
        const x2 = Math.min(box1.x2, box2.x2);
        const y2 = Math.min(box1.y2, box2.y2);

        if (x2 < x1 || y2 < y1) return 0.0;

        const intersection = (x2 - x1) * (y2 - y1);
        const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
        const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);

        return intersection / (area1 + area2 - intersection);
    }

    private transpose(matrix: number[][]): number[][] {
        return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
    }

    private getQuadrant(x: number, y: number): Quadrant {
        // x and y are normalized 0-1
        if (x < 0.5 && y < 0.5) return 'Q1'; // Top-left
        if (x >= 0.5 && y < 0.5) return 'Q2'; // Top-right
        if (x < 0.5 && y >= 0.5) return 'Q3'; // Bottom-left
        return 'Q4'; // Bottom-right
    }

    dispose(): void {
        this.model?.dispose();
        this.model = null;
    }
}
