"""
Jellyphony — Python MediaPipe Detection Server

FastAPI WebSocket server that:
1. Captures frames from a video file or webcam
2. Runs MediaPipe object detection (jellyfish)
3. Streams detections as JSON to the browser frontend

Usage:
    python main.py                         # Webcam (device 0)
    python main.py --video jellyfish.mp4   # Video file (loops)
    python main.py --device 1              # Specific webcam device

The frontend connects via WebSocket at ws://localhost:8000/ws
"""

import argparse
import asyncio
import json
import time
from contextlib import asynccontextmanager

import cv2
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from jellyfish_detector import JellyfishDetector

# ── Configuration ──────────────────────────────────────────────

DETECT_INTERVAL_S = 0.2  # ~5 FPS detection, matching Squidphony
DEFAULT_PORT = 8000

# ── Global State ───────────────────────────────────────────────

detector = JellyfishDetector()
video_source: str | int = 0  # Default to webcam
connected_clients: set[WebSocket] = set()


# ── Lifespan ───────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup, clean up on shutdown."""
    print("[Jellyphony] Loading MediaPipe model…")
    detector.load()
    print("[Jellyphony] Model ready ✓")

    # Start the detection loop as a background task
    task = asyncio.create_task(detection_loop())
    yield

    # Cleanup
    task.cancel()
    detector.dispose()
    print("[Jellyphony] Shut down.")


# ── App ────────────────────────────────────────────────────────

app = FastAPI(title="Jellyphony Detection Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Detection Loop ─────────────────────────────────────────────

async def detection_loop():
    """
    Continuously capture frames and broadcast detections
    to all connected WebSocket clients.
    """
    cap = cv2.VideoCapture(video_source)
    if not cap.isOpened():
        print(f"[Jellyphony] ERROR: Could not open video source: {video_source}")
        return

    print(f"[Jellyphony] Video source opened: {video_source}")
    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"[Jellyphony] Frame size: {frame_width}x{frame_height}")

    try:
        while True:
            start_time = time.monotonic()

            ret, frame = cap.read()
            if not ret:
                # If video file, loop back to start
                if isinstance(video_source, str):
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                else:
                    print("[Jellyphony] Webcam read failed, retrying…")
                    await asyncio.sleep(0.5)
                    continue

            # Run detection
            detections = detector.detect(frame)

            # Build message matching Squidphony Detection[] format
            message = json.dumps({
                "type": "detections",
                "detections": [d.to_dict() for d in detections],
                "timestamp": time.time(),
            })

            # Broadcast to all connected clients
            if connected_clients:
                disconnected = set()
                for ws in connected_clients:
                    try:
                        await ws.send_text(message)
                    except Exception:
                        disconnected.add(ws)
                connected_clients -= disconnected

            # Maintain target frame rate
            elapsed = time.monotonic() - start_time
            sleep_time = max(0, DETECT_INTERVAL_S - elapsed)
            await asyncio.sleep(sleep_time)

    except asyncio.CancelledError:
        pass
    finally:
        cap.release()
        print("[Jellyphony] Video source released.")


# ── WebSocket Endpoint ─────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    print(f"[Jellyphony] Client connected ({len(connected_clients)} total)")

    try:
        # Keep the connection alive — client may send control messages
        while True:
            data = await ws.receive_text()
            # Handle any control messages from the frontend
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(ws)
        print(f"[Jellyphony] Client disconnected ({len(connected_clients)} total)")


# ── Health Check ───────────────────────────────────────────────

@app.get("/")
async def root():
    return HTMLResponse(
        "<h1>🪼 Jellyphony Detection Server</h1>"
        f"<p>Connected clients: {len(connected_clients)}</p>"
        "<p>WebSocket endpoint: <code>ws://localhost:8000/ws</code></p>"
    )


# ── CLI Entry Point ────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jellyphony MediaPipe Detection Server")
    parser.add_argument("--video", type=str, default=None, help="Path to video file (omit for webcam)")
    parser.add_argument("--device", type=int, default=0, help="Webcam device index (default: 0)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Server port (default: {DEFAULT_PORT})")
    parser.add_argument("--model", type=str, default=None, help="Path to custom .tflite model")
    parser.add_argument("--confidence", type=float, default=0.3, help="Minimum confidence threshold (default: 0.3)")
    args = parser.parse_args()

    # Set video source
    if args.video:
        video_source = args.video
    else:
        video_source = args.device

    # Configure detector
    if args.model:
        detector = JellyfishDetector(model_path=args.model, confidence_threshold=args.confidence)
    else:
        detector = JellyfishDetector(confidence_threshold=args.confidence)

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port)
