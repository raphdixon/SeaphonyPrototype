/**
 * Lyria WebSocket Proxy — Cloudflare Worker
 *
 * Accepts WebSocket connections from the frontend and relays them upstream
 * to Google's Lyria Realtime API, injecting the API key server-side so it
 * is never exposed to the client.
 *
 * Uses Cloudflare Workers fetch() with Upgrade: websocket for outbound
 * WebSocket connections (the correct pattern for Workers).
 */

interface Env {
    GOOGLE_API_KEY: string;
}

const GOOGLE_API_HOST = 'generativelanguage.googleapis.com';
const API_VERSION = 'v1alpha';
const WS_PATH = `ws/google.ai.generativelanguage.${API_VERSION}.GenerativeService.BidiGenerateMusic`;

// Allowed origins (add localhost for dev)
const ALLOWED_ORIGINS = [
    'https://seaphony.pages.dev',
    'http://localhost:5173',
    'http://localhost:4173',
];

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        // ── CORS preflight ──────────────────────────────────────────
        if (request.method === 'OPTIONS') {
            return handleCORS(request);
        }

        // ── Health check ────────────────────────────────────────────
        const url = new URL(request.url);
        if (url.pathname === '/health') {
            return new Response('ok', { status: 200 });
        }

        // ── WebSocket upgrade ───────────────────────────────────────
        if (url.pathname === '/ws') {
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader !== 'websocket') {
                return new Response('Expected WebSocket upgrade', { status: 426 });
            }

            // Validate origin
            const origin = request.headers.get('Origin') ?? '';
            if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
                return new Response('Origin not allowed', { status: 403 });
            }

            if (!env.GOOGLE_API_KEY) {
                return new Response('Server misconfigured: missing API key', { status: 500 });
            }

            // Connect upstream to Google using fetch() with Upgrade header
            // This is the correct Cloudflare Workers pattern for outbound WebSockets
            const upstreamUrl = `https://${GOOGLE_API_HOST}/${WS_PATH}?key=${env.GOOGLE_API_KEY}`;

            const upstreamResp = await fetch(upstreamUrl, {
                headers: {
                    'Upgrade': 'websocket',
                },
            });

            const upstream = upstreamResp.webSocket;
            if (!upstream) {
                console.error('Failed to establish upstream WebSocket. Status:', upstreamResp.status);
                return new Response(`Failed to connect to upstream API (status: ${upstreamResp.status})`, {
                    status: 502,
                });
            }

            // Accept the client WebSocket pair
            const [client, server] = Object.values(new WebSocketPair());
            server.accept();
            upstream.accept();

            // Relay: client → upstream
            server.addEventListener('message', (event) => {
                try {
                    upstream.send(event.data);
                } catch (e) {
                    console.error('Error relaying client→upstream:', e);
                }
            });

            server.addEventListener('close', (event) => {
                try {
                    upstream.close(event.code, event.reason);
                } catch { /* already closed */ }
            });

            server.addEventListener('error', () => {
                try { upstream.close(1011, 'Client error'); } catch { }
            });

            // Relay: upstream → client
            upstream.addEventListener('message', (event) => {
                try {
                    server.send(event.data);
                } catch (e) {
                    console.error('Error relaying upstream→client:', e);
                }
            });

            upstream.addEventListener('close', (event) => {
                try {
                    server.close(event.code, event.reason);
                } catch { /* already closed */ }
            });

            upstream.addEventListener('error', () => {
                try { server.close(1011, 'Upstream error'); } catch { }
            });

            return new Response(null, {
                status: 101,
                webSocket: client,
                headers: corsHeaders(origin),
            });
        }

        return new Response('Not found', { status: 404 });
    },
} satisfies ExportedHandler<Env>;

function handleCORS(request: Request): Response {
    const origin = request.headers.get('Origin') ?? '';
    if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
        return new Response('Origin not allowed', { status: 403 });
    }
    return new Response(null, {
        status: 204,
        headers: {
            ...corsHeaders(origin),
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection',
            'Access-Control-Max-Age': '86400',
        },
    });
}

function corsHeaders(origin: string): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': origin,
        'Vary': 'Origin',
    };
}
