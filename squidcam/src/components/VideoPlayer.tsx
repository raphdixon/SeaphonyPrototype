'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { SquidDetector, DetectionResult, Quadrant } from '@/lib/squidDetector';
import { LyriaClient } from '@/lib/lyriaClient';
import { AudioEngine } from '@/lib/audioEngine';

// Use local proxy to handle CORS for TF.js frame extraction
const VIDEO_URL = '/api/proxy-video';
const SYNC_DELAY_MS = 3000; // 3 seconds delay for A/V sync

const QUADRANT_GENRES: Record<Quadrant, { label: string; prompt: string }> = {
  Q1: { label: 'Whale Song', prompt: 'Whale Song' },
  Q2: { label: 'Chillwave', prompt: 'Chillwave' },
  Q3: { label: 'Aquacrunk', prompt: 'Aquacrunk' },
  Q4: { label: 'Rainy Day Music', prompt: 'Rainy Day Music' },
};

interface StatusInfo {
  modelLoaded: boolean;
  videoLoaded: boolean; // Tracking display video
  processingVideoLoaded: boolean;
  lyriaConnected: boolean;

  activeQuadrant: Quadrant | null;
  weights: Record<Quadrant, number>;
}

interface QueuedFrame {
  time: number;
  detections: DetectionResult[];
  weights: Record<Quadrant, number>;
}

export default function VideoPlayer() {
  const videoDisplayRef = useRef<HTMLVideoElement>(null);
  const videoProcessingRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const detectorRef = useRef<SquidDetector | null>(null);
  const lyriaRef = useRef<LyriaClient | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);

  // Refs for loops
  const detectFrameRef = useRef<number>(0);
  const renderFrameRef = useRef<number>(0);
  const lastDetectTimeRef = useRef<number>(0);
  const lastLyriaUpdateRef = useRef<number>(0);

  // Synchronization Queue
  const detectionQueueRef = useRef<QueuedFrame[]>([]);

  const [status, setStatus] = useState<StatusInfo>({
    modelLoaded: false,
    videoLoaded: false,
    processingVideoLoaded: false,
    lyriaConnected: false,

    activeQuadrant: null,
    weights: { Q1: 0, Q2: 0, Q3: 0, Q4: 0 }
  });

  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);

  // Initialize detector and audio
  useEffect(() => {
    const init = async () => {
      // Initialize squid detector
      const detector = new SquidDetector();
      await detector.load();
      detectorRef.current = detector;
      setStatus(s => ({ ...s, modelLoaded: true }));
      console.log('Squid detector loaded');

      // Initialize audio engine
      const audioEngine = new AudioEngine();
      await audioEngine.init();
      audioEngineRef.current = audioEngine;
      console.log('Audio engine initialized');

      // Initialize Lyria client
      const lyria = new LyriaClient();
      lyria.onAudioData = (pcmData: Float32Array) => {
        audioEngineRef.current?.feedAudio(pcmData);
      };
      lyria.onConnectionChange = (connected: boolean) => {
        setStatus(s => ({ ...s, lyriaConnected: connected }));
      };
      lyriaRef.current = lyria;
    };

    init().catch(console.error);

    return () => {
      detectorRef.current?.dispose();
      lyriaRef.current?.disconnect();
      audioEngineRef.current?.close();
    };
  }, []);

  // Handle video resize
  useEffect(() => {
    const updateDimensions = () => {
      if (videoDisplayRef.current) {
        const rect = videoDisplayRef.current.getBoundingClientRect();
        setDimensions({ width: rect.width, height: rect.height });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  // PROCESSING LOOP (The "Future")
  // Reads from videoProcessingRef (Leading Video)
  const detectLoop = useCallback(async () => {
    if (!videoProcessingRef.current || !detectorRef.current || videoProcessingRef.current.paused) {
      detectFrameRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    const now = performance.now();

    // Target 5 FPS for detection to save resources
    if (now - lastDetectTimeRef.current >= 200) {
      lastDetectTimeRef.current = now;

      // 1. Detect on the LEADING video
      const results = await detectorRef.current.detect(videoProcessingRef.current);

      // 2. Calculate Weights (Logic moved here from render)
      const counts: Record<Quadrant, number> = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
      results.forEach(d => counts[d.quadrant]++);
      const total = results.length;

      const targetWeights: Record<Quadrant, number> = {
        Q1: total ? counts.Q1 / total : 0,
        Q2: total ? counts.Q2 / total : 0,
        Q3: total ? counts.Q3 / total : 0,
        Q4: total ? counts.Q4 / total : 0
      };

      // Construct prompts for Lyria - SEND IMMEDIATELY
      const activePrompts = Object.entries(targetWeights)
        .filter(([_, weight]) => weight > 0.01)
        .map(([q, weight]) => ({
          text: QUADRANT_GENRES[q as Quadrant].prompt,
          weight: weight
        }));

      const timeNow = Date.now();
      if (timeNow - lastLyriaUpdateRef.current > 8000) {
        lyriaRef.current?.updateWeightedPrompts(activePrompts);
        lastLyriaUpdateRef.current = timeNow;
        console.log("Updated Lyria Prompts (Ahead):", activePrompts);
      }

      // 3. Queue the result for the Display Video
      detectionQueueRef.current.push({
        time: videoProcessingRef.current.currentTime,
        detections: results,
        weights: targetWeights
      });

      // Prune queue if too large (safety cap, though we consume it in render)
      if (detectionQueueRef.current.length > 100) {
        detectionQueueRef.current.shift();
      }
    }

    detectFrameRef.current = requestAnimationFrame(detectLoop);
  }, []);


  // VISUAL LOOP (The "Present")
  // Syncs with videoDisplayRef
  const renderLoop = useCallback(() => {
    if (!videoDisplayRef.current || !canvasRef.current) {
      renderFrameRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const displayTime = videoDisplayRef.current.currentTime;

    // 1. Find best matching frame in queue
    let bestFrame: QueuedFrame | null = null;

    // Remove old frames (< displayTime - 0.5s)
    while (detectionQueueRef.current.length > 0 && detectionQueueRef.current[0].time < displayTime - 0.5) {
      detectionQueueRef.current.shift();
    }

    // Find the closest frame
    let minDiff = Infinity;
    for (const frame of detectionQueueRef.current) {
      const diff = Math.abs(frame.time - displayTime);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrame = frame;
      } else {
        break;
      }
    }

    const frameToDraw = bestFrame || {
      time: 0,
      detections: [],
      weights: { Q1: 0, Q2: 0, Q3: 0, Q4: 0 }
    };

    // Update Visible Status (Smoothly)
    setStatus(prevStatus => {
      const alpha = 0.05; // Smoothing factor for UI
      const currentWeights = prevStatus.weights;
      const targetWeights = frameToDraw.weights;

      const smoothedWeights: Record<Quadrant, number> = {
        Q1: currentWeights.Q1 + alpha * (targetWeights.Q1 - currentWeights.Q1),
        Q2: currentWeights.Q2 + alpha * (targetWeights.Q2 - currentWeights.Q2),
        Q3: currentWeights.Q3 + alpha * (targetWeights.Q3 - currentWeights.Q3),
        Q4: currentWeights.Q4 + alpha * (targetWeights.Q4 - currentWeights.Q4)
      };

      // Normalize
      const sum = Object.values(smoothedWeights).reduce((a, b) => a + b, 0);
      if (sum > 0) {
        smoothedWeights.Q1 /= sum;
        smoothedWeights.Q2 /= sum;
        smoothedWeights.Q3 /= sum;
        smoothedWeights.Q4 /= sum;
      } else {
        smoothedWeights.Q1 = 0; smoothedWeights.Q2 = 0; smoothedWeights.Q3 = 0; smoothedWeights.Q4 = 0;
      }

      return { ...prevStatus, weights: smoothedWeights };
    });


    // 2. Draw
    canvasRef.current.width = dimensions.width;
    canvasRef.current.height = dimensions.height;
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    const midX = dimensions.width / 2;
    const midY = dimensions.height / 2;

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(midX, 0);
    ctx.lineTo(midX, dimensions.height);
    ctx.moveTo(0, midY);
    ctx.lineTo(dimensions.width, midY);
    ctx.stroke();

    // Draw genre labels
    const quadrantPositions: { quadrant: Quadrant; x: number; y: number }[] = [
      { quadrant: 'Q1', x: midX / 2, y: midY / 2 },
      { quadrant: 'Q2', x: midX + midX / 2, y: midY / 2 },
      { quadrant: 'Q3', x: midX / 2, y: midY + midY / 2 },
      { quadrant: 'Q4', x: midX + midX / 2, y: midY + midY / 2 },
    ];

    ctx.font = 'bold 18px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    quadrantPositions.forEach(({ quadrant, x, y }) => {
      const genre = QUADRANT_GENRES[quadrant];
      const weight = status.weights[quadrant];

      const opacity = 0.3 + (weight * 0.7);

      if (weight > 0) {
        ctx.shadowColor = '#00FFFF';
        ctx.shadowBlur = 20 * weight;
        ctx.fillStyle = `rgba(0, 255, 255, ${opacity})`;
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      }

      ctx.fillText(`${genre.label} ${(weight * 100).toFixed(0)}%`, x, y);
    });

    // Draw Detections
    frameToDraw.detections.forEach(detection => {
      const { bbox, centroid } = detection;
      const x1 = bbox.x1 * dimensions.width;
      const y1 = bbox.y1 * dimensions.height;
      const x2 = bbox.x2 * dimensions.width;
      const y2 = bbox.y2 * dimensions.height;
      const cx = centroid.x * dimensions.width;
      const cy = centroid.y * dimensions.height;

      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#FF00FF';
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      ctx.fillStyle = '#FF00FF';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    renderFrameRef.current = requestAnimationFrame(renderLoop);
  }, [dimensions, status.weights]);

  // Start/Stop Loops
  useEffect(() => {
    if (isPlaying) {
      renderFrameRef.current = requestAnimationFrame(renderLoop);
      detectFrameRef.current = requestAnimationFrame(detectLoop);
    } else {
      cancelAnimationFrame(renderFrameRef.current);
      cancelAnimationFrame(detectFrameRef.current);
    }
    return () => {
      cancelAnimationFrame(renderFrameRef.current);
      cancelAnimationFrame(detectFrameRef.current);
    };
  }, [isPlaying, detectLoop, renderLoop]);

  // Start experience
  const handleStart = async () => {
    if (videoProcessingRef.current && videoDisplayRef.current) {
      setIsPlaying(true);
      setIsBuffering(true);

      // 1. Start Processing Video (Hidden)
      await videoProcessingRef.current.play();

      // Connect to Lyria and start audio (let it buffer)
      const initialGenre = QUADRANT_GENRES.Q1;
      const sampleRate = audioEngineRef.current?.getSampleRate() || 48000;
      await lyriaRef.current?.connect(
        [{ text: initialGenre.prompt, weight: 1.0 }],
        sampleRate
      );
      await audioEngineRef.current?.start();

      // 2. Wait for audio to buffer (3 seconds) then start display video
      setTimeout(async () => {
        setIsBuffering(false);
        if (videoDisplayRef.current) {
          await videoDisplayRef.current.play();
        }
      }, SYNC_DELAY_MS);
    }
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden">
      {/* Processing Video (Hidden) */}
      <video
        ref={videoProcessingRef}
        src={VIDEO_URL}
        crossOrigin="anonymous"
        className="invisible absolute top-0 left-0 w-1 h-1"
        loop
        muted
        playsInline
        onLoadedData={() => setStatus(s => ({ ...s, processingVideoLoaded: true }))}
      />

      {/* Display Video (Visible, Delayed) */}
      <video
        ref={videoDisplayRef}
        src={VIDEO_URL}
        crossOrigin="anonymous"
        className="absolute inset-0 w-full h-full object-cover"
        loop
        muted
        playsInline
        onLoadedMetadata={() => {
          if (videoDisplayRef.current) {
            const rect = videoDisplayRef.current.getBoundingClientRect();
            setDimensions({ width: rect.width, height: rect.height });
          }
        }}
        onLoadedData={() => {
          setStatus(s => ({ ...s, videoLoaded: true }));
        }}
      />

      {/* Canvas overlay */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 10 }}
      />

      {/* Status indicators */}
      <div className="absolute top-4 left-4 z-20 flex flex-col gap-2 text-white text-sm font-mono">
        <div className={`px-3 py-1 rounded-full ${status.lyriaConnected ? 'bg-green-500/30' : 'bg-yellow-500/30'}`}>
          Lyria: {status.lyriaConnected ? 'Connected' : 'Disconnected'}
        </div>
        <div className="px-3 py-1 rounded-full bg-blue-500/30">
          Delay: {SYNC_DELAY_MS}ms
        </div>
      </div>

      {/* Start overlay */}
      {!isPlaying && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70">
          <button
            onClick={handleStart}
            disabled={!status.modelLoaded || !status.videoLoaded || !status.processingVideoLoaded}
            className="px-8 py-4 text-xl font-bold text-white bg-gradient-to-r from-cyan-500 to-purple-500 rounded-full hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {!status.modelLoaded ? 'Loading Model...' :
              (!status.videoLoaded || !status.processingVideoLoaded) ? 'Loading Videos...' :
                'Start Squidphony'}
          </button>
        </div>
      )}

      {/* Buffering overlay */}
      {isBuffering && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-white text-xl font-semibold">Buffering audio...</p>
          </div>
        </div>
      )}
    </div>
  );
}
