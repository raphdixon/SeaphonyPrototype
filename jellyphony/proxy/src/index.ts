/**
 * Seaphony Lyria WebSocket Proxy
 *
 * Transparent WebSocket relay between the browser and Google's Lyria
 * Realtime API. The API key is injected server-side — never sent to
 * the client.
 */

export interface Env {
    GOOGLE_API_KEY: string;
    ALLOWED_ORIGINS: string;
}

const LYRIA_WS_BASE = 'https://generativelanguage.googleapis.com';
const LYRIA_WS_PATH = '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
        const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': corsOrigin,
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // Health check
        if (url.pathname === '/health') {
            return new Response('ok', {
                headers: { 'Access-Control-Allow-Origin': corsOrigin },
            });
        }

        // Debug: test upstream connection without WebSocket
        if (url.pathname === '/debug') {
            try {
                const upstreamUrl = `${LYRIA_WS_BASE}${LYRIA_WS_PATH}?key=${env.GOOGLE_API_KEY}`;
                console.log('[Proxy] Attempting upstream connection to:', LYRIA_WS_BASE + LYRIA_WS_PATH);
                const resp = await fetch(upstreamUrl, {
                    headers: { 'Upgrade': 'websocket' },
                });
                const hasWs = !!resp.webSocket;
                console.log('[Proxy] Upstream response status:', resp.status, 'hasWebSocket:', hasWs);
                return new Response(JSON.stringify({
                    status: resp.status,
                    statusText: resp.statusText,
                    hasWebSocket: hasWs,
                    headers: Object.fromEntries(resp.headers.entries()),
                }), {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            } catch (err) {
                console.error('[Proxy] Debug upstream error:', err);
                return new Response(JSON.stringify({ error: String(err) }), {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            }
        }

        // WebSocket upgrade on /ws
        if (url.pathname === '/ws') {
            return handleWebSocket(request, env, ctx);
        }

        return new Response('Not found', { status: 404 });
    },
};

function handleWebSocket(request: Request, env: Env, ctx: ExecutionContext): Response {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    // Queue messages from client until upstream is ready
    const pendingClientMessages: (string | ArrayBuffer)[] = [];
    let upstream: WebSocket | null = null;
    let upstreamReady = false;

    server.addEventListener('message', (event) => {
        if (upstreamReady && upstream) {
            try {
                upstream.send(event.data);
            } catch (e) {
                console.error('[Proxy] Error sending to upstream:', e);
            }
        } else {
            pendingClientMessages.push(event.data as string | ArrayBuffer);
            console.log('[Proxy] Queued client message, pending count:', pendingClientMessages.length);
        }
    });

    server.addEventListener('close', (event) => {
        console.log('[Proxy] Client closed:', event.code, event.reason);
        if (upstream) {
            try { upstream.close(event.code, event.reason); } catch { /* ignore */ }
        }
    });

    server.addEventListener('error', () => {
        console.error('[Proxy] Client WebSocket error');
        if (upstream) {
            try { upstream.close(1011, 'Client error'); } catch { /* ignore */ }
        }
    });

    ctx.waitUntil(connectUpstream(env, server, pendingClientMessages, (ws) => {
        upstream = ws;
        upstreamReady = true;
    }));

    return new Response(null, { status: 101, webSocket: client });
}

async function connectUpstream(
    env: Env,
    server: WebSocket,
    pendingMessages: (string | ArrayBuffer)[],
    onReady: (ws: WebSocket) => void,
): Promise<void> {
    const upstreamUrl = `${LYRIA_WS_BASE}${LYRIA_WS_PATH}?key=${env.GOOGLE_API_KEY}`;
    console.log('[Proxy] Connecting upstream...');

    try {
        const upstreamResponse = await fetch(upstreamUrl, {
            headers: { 'Upgrade': 'websocket' },
        });

        console.log('[Proxy] Upstream response status:', upstreamResponse.status, 'hasWebSocket:', !!upstreamResponse.webSocket);

        const upstream = upstreamResponse.webSocket;
        if (!upstream) {
            const body = await upstreamResponse.text();
            console.error('[Proxy] No WebSocket in response. Status:', upstreamResponse.status, 'Body:', body.substring(0, 500));
            server.close(1011, 'Upstream did not accept WebSocket');
            return;
        }

        upstream.accept();
        console.log('[Proxy] Upstream WebSocket accepted');

        upstream.addEventListener('message', (event) => {
            try {
                if (server.readyState === WebSocket.READY_STATE_OPEN) {
                    server.send(event.data);
                }
            } catch (e) {
                console.error('[Proxy] Error forwarding upstream->client:', e);
            }
        });

        upstream.addEventListener('close', (event) => {
            console.log('[Proxy] Upstream closed:', event.code, event.reason);
            try { server.close(event.code, event.reason); } catch { /* ignore */ }
        });

        upstream.addEventListener('error', () => {
            console.error('[Proxy] Upstream WebSocket error');
            try { server.close(1011, 'Upstream error'); } catch { /* ignore */ }
        });

        onReady(upstream);
        console.log('[Proxy] Upstream ready, flushing', pendingMessages.length, 'queued messages');

        for (const msg of pendingMessages) {
            try {
                upstream.send(msg);
            } catch (e) {
                console.error('[Proxy] Error flushing message:', e);
                break;
            }
        }
        pendingMessages.length = 0;
    } catch (err) {
        console.error('[Proxy] Upstream connection failed:', err);
        try {
            server.close(1011, 'Upstream connection failed');
        } catch { /* ignore */ }
    }
}
