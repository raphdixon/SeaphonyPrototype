/**
 * Cloudflare Worker — Serves assets from the "squid" R2 bucket.
 * Used for files too large for Cloudflare Pages (>25 MB), e.g. the video.
 */

export interface Env {
    BUCKET: R2Bucket;
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const key = url.pathname.slice(1); // strip leading /

        if (!key) {
            return new Response('Not found', { status: 404, headers: CORS_HEADERS });
        }

        const object = await env.BUCKET.get(key);
        if (!object) {
            return new Response('Not found', { status: 404, headers: CORS_HEADERS });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');

        // Set CORS headers
        for (const [k, v] of Object.entries(CORS_HEADERS)) {
            headers.set(k, v);
        }

        return new Response(object.body, { headers });
    },
} satisfies ExportedHandler<Env>;
