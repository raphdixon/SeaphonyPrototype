'use client';

import { useEffect, useRef, useState } from 'react';
import { GoogleGenAI } from "@google/genai";

/**
 * CLEAN AUDIO TEST PAGE
 * - Single genre: "House"
 * - All defaults
 * - Maximum logging
 * - No processing - raw PCM passthrough
 */

interface LogEntry {
    time: string;
    type: 'info' | 'error' | 'data';
    message: string;
}

export default function AudioTestClean() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [status, setStatus] = useState('Not Started');
    const [stats, setStats] = useState({
        chunksReceived: 0,
        totalSamples: 0,
        bufferLevel: 0,
    });

    const audioContextRef = useRef<AudioContext | null>(null);
    const workletNodeRef = useRef<AudioWorkletNode | null>(null);
    const sessionRef = useRef<any>(null);

    const log = (type: LogEntry['type'], message: string) => {
        const time = new Date().toISOString().split('T')[1].slice(0, 12);
        console.log(`[${type.toUpperCase()}] ${message}`);
        setLogs(prev => [...prev.slice(-50), { time, type, message }]);
    };

    const startTest = async () => {
        try {
            setStatus('Initializing AudioContext...');
            log('info', 'Creating AudioContext with default sample rate');

            // Create AudioContext with DEFAULT sample rate (let browser decide)
            audioContextRef.current = new AudioContext();
            const actualSampleRate = audioContextRef.current.sampleRate;
            log('info', `AudioContext created. Sample Rate: ${actualSampleRate}Hz`);

            // Load minimal worklet
            setStatus('Loading AudioWorklet...');
            await audioContextRef.current.audioWorklet.addModule(`/audio-worklet.js?v=${Date.now()}`);
            log('info', 'AudioWorklet module loaded');

            workletNodeRef.current = new AudioWorkletNode(audioContextRef.current, 'pcm-player-processor');
            workletNodeRef.current.connect(audioContextRef.current.destination);
            log('info', 'AudioWorklet connected to destination');

            // Resume context
            if (audioContextRef.current.state === 'suspended') {
                await audioContextRef.current.resume();
                log('info', 'AudioContext resumed');
            }

            // Connect to Lyria
            setStatus('Connecting to Lyria...');
            const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY || '';
            log('info', `API Key present: ${apiKey.length > 0}`);

            const client = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });

            log('info', 'Calling client.live.music.connect...');
            const session = await client.live.music.connect({
                model: "models/lyria-realtime-exp",
                callbacks: {
                    onmessage: (message: any) => {
                        if (message.serverContent?.audioChunks) {
                            const chunks = message.serverContent.audioChunks;
                            for (const chunk of chunks) {
                                if (!chunk.data) continue;

                                // Decode base64
                                const binaryString = atob(chunk.data);
                                const bytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }

                                // Convert Int16 -> Float32 (NO UPSAMPLING)
                                const int16Data = new Int16Array(bytes.buffer);
                                const float32Data = new Float32Array(int16Data.length);
                                for (let i = 0; i < int16Data.length; i++) {
                                    float32Data[i] = int16Data[i] / 32768.0;
                                }

                                // Log chunk details
                                const chunkDurationMs = (float32Data.length / actualSampleRate) * 1000;
                                log('data', `Chunk: ${float32Data.length} samples (${chunkDurationMs.toFixed(1)}ms)`);

                                // Send to worklet
                                workletNodeRef.current?.port.postMessage({ audioData: float32Data });

                                // Update stats
                                setStats(prev => ({
                                    chunksReceived: prev.chunksReceived + 1,
                                    totalSamples: prev.totalSamples + float32Data.length,
                                    bufferLevel: prev.bufferLevel + float32Data.length,
                                }));
                            }
                        }
                    },
                    onerror: (error: any) => {
                        log('error', `WebSocket Error: ${JSON.stringify(error)}`);
                        setStatus('Error');
                    },
                    onclose: (event: any) => {
                        log('info', `Session closed: ${JSON.stringify(event)}`);
                        setStatus('Disconnected');
                    },
                },
            });

            sessionRef.current = session;
            log('info', 'Lyria session connected');
            setStatus('Connected - Setting prompt...');

            // Set weighted prompts - just "House"
            await session.setWeightedPrompts({
                weightedPrompts: [{ text: "House", weight: 1.0 }]
            });
            log('info', 'Prompt set: House (weight: 1.0)');

            // Set config with MATCHING sample rate
            log('info', `Setting config: bpm=120, sampleRate=${actualSampleRate}`);
            try {
                await session.setMusicGenerationConfig({
                    bpm: 120,
                    sampleRateHz: actualSampleRate,
                } as any);
                log('info', 'Config set successfully');
            } catch (err) {
                log('error', `Config error: ${err}`);
            }

            // Start playback
            await session.play();
            log('info', 'Playback started!');
            setStatus('Playing - House @ 120 BPM');

        } catch (error) {
            log('error', `Fatal error: ${error}`);
            setStatus('Failed');
        }
    };

    const stopTest = async () => {
        try {
            await sessionRef.current?.stop();
            audioContextRef.current?.close();
            setStatus('Stopped');
            log('info', 'Stopped');
        } catch (e) {
            log('error', `Stop error: ${e}`);
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-8 font-mono">
            <h1 className="text-2xl font-bold mb-4">🔊 Clean Audio Test</h1>
            <p className="text-gray-400 mb-6">Single genre: House | All defaults | Raw PCM passthrough</p>

            <div className="flex gap-4 mb-6">
                <button
                    onClick={startTest}
                    className="px-6 py-3 bg-green-600 rounded hover:bg-green-500"
                >
                    Start Test
                </button>
                <button
                    onClick={stopTest}
                    className="px-6 py-3 bg-red-600 rounded hover:bg-red-500"
                >
                    Stop
                </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-gray-800 p-4 rounded">
                    <div className="text-sm text-gray-400">Status</div>
                    <div className="text-xl">{status}</div>
                </div>
                <div className="bg-gray-800 p-4 rounded">
                    <div className="text-sm text-gray-400">Audio Stats</div>
                    <div className="text-sm">
                        Chunks: {stats.chunksReceived} |
                        Samples: {stats.totalSamples.toLocaleString()}
                    </div>
                </div>
            </div>

            <div className="bg-black p-4 rounded h-96 overflow-y-auto text-xs">
                {logs.map((log, i) => (
                    <div
                        key={i}
                        className={`py-0.5 ${log.type === 'error' ? 'text-red-400' :
                            log.type === 'data' ? 'text-blue-400' : 'text-green-400'
                            }`}
                    >
                        <span className="text-gray-500">{log.time}</span> {log.message}
                    </div>
                ))}
            </div>
        </div>
    );
}
