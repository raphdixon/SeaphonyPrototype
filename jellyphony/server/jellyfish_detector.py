"""
Jellyfish Detector — MediaPipe Object Detection wrapper

Uses MediaPipe's Object Detection task to detect objects (jellyfish)
in video frames. Defaults to EfficientDet-Lite0 (COCO) but can be
swapped for a custom jellyfish-trained .tflite model.

Detection output format matches the Squidphony Detection interface:
  { bbox: {x1, y1, x2, y2}, centroid: {x, y}, confidence: float }
All coordinates are normalized 0–1.
"""

import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

# ── Configuration ──────────────────────────────────────────────

# Default model — swap this path to use a custom jellyfish model
DEFAULT_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "object_detector/efficientdet_lite0/int8/latest/efficientdet_lite0.tflite"
)
DEFAULT_MODEL_PATH = Path(__file__).parent / "models" / "efficientdet_lite0.tflite"

# Minimum confidence threshold
DEFAULT_CONFIDENCE = 0.3

# Maximum detections per frame
MAX_DETECTIONS = 30


# ── Data Types ─────────────────────────────────────────────────

@dataclass
class BoundingBox:
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass
class Centroid:
    x: float
    y: float


@dataclass
class Detection:
    bbox: BoundingBox
    centroid: Centroid
    confidence: float
    label: str = ""

    def to_dict(self) -> dict:
        return {
            "bbox": {"x1": self.bbox.x1, "y1": self.bbox.y1, "x2": self.bbox.x2, "y2": self.bbox.y2},
            "centroid": {"x": self.centroid.x, "y": self.centroid.y},
            "confidence": round(self.confidence, 3),
            "label": self.label,
        }


# ── Detector ───────────────────────────────────────────────────

class JellyfishDetector:
    """MediaPipe-based object detector for jellyfish (or any object)."""

    def __init__(
        self,
        model_path: str | Path | None = None,
        confidence_threshold: float = DEFAULT_CONFIDENCE,
        max_results: int = MAX_DETECTIONS,
    ):
        self.model_path = Path(model_path) if model_path else DEFAULT_MODEL_PATH
        self.confidence_threshold = confidence_threshold
        self.max_results = max_results
        self._detector: vision.ObjectDetector | None = None

    def load(self) -> None:
        """Download model if needed and initialize the detector."""
        self._ensure_model()

        base_options = mp_python.BaseOptions(
            model_asset_path=str(self.model_path)
        )
        options = vision.ObjectDetectorOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.IMAGE,
            max_results=self.max_results,
            score_threshold=self.confidence_threshold,
        )
        self._detector = vision.ObjectDetector.create_from_options(options)
        print(f"[JellyfishDetector] Model loaded from {self.model_path}")

    def detect(self, frame) -> list[Detection]:
        """
        Run detection on a numpy BGR frame (from OpenCV).
        Returns a list of Detection objects with normalized coordinates.
        """
        if self._detector is None:
            raise RuntimeError("Detector not loaded. Call load() first.")

        height, width = frame.shape[:2]

        # Convert BGR → RGB for MediaPipe
        import cv2
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)

        # Run detection
        result = self._detector.detect(mp_image)

        detections: list[Detection] = []
        for det in result.detections:
            bb = det.bounding_box
            # MediaPipe gives pixel coordinates — normalize to 0–1
            x1 = max(0.0, bb.origin_x / width)
            y1 = max(0.0, bb.origin_y / height)
            x2 = min(1.0, (bb.origin_x + bb.width) / width)
            y2 = min(1.0, (bb.origin_y + bb.height) / height)

            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2

            label = det.categories[0].category_name if det.categories else ""
            confidence = det.categories[0].score if det.categories else 0.0

            detections.append(
                Detection(
                    bbox=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
                    centroid=Centroid(x=cx, y=cy),
                    confidence=confidence,
                    label=label,
                )
            )

        return detections[:self.max_results]

    def _ensure_model(self) -> None:
        """Download the default model if it doesn't exist on disk."""
        if self.model_path.exists():
            return

        self.model_path.parent.mkdir(parents=True, exist_ok=True)

        if str(self.model_path) == str(DEFAULT_MODEL_PATH):
            print(f"[JellyfishDetector] Downloading default model…")
            urllib.request.urlretrieve(DEFAULT_MODEL_URL, self.model_path)
            print(f"[JellyfishDetector] Model saved to {self.model_path}")
        else:
            raise FileNotFoundError(
                f"Custom model not found: {self.model_path}. "
                "Please provide a valid .tflite model file."
            )

    def dispose(self) -> None:
        """Clean up resources."""
        if self._detector:
            self._detector.close()
            self._detector = None
