import { NextRequest, NextResponse } from 'next/server';

// Use Edge runtime for better streaming support on Vercel
export const runtime = 'edge';

const VIDEO_URL = 'https://pub-abc97c1b7de8441d956fe0b5ffae61e0.r2.dev/SquidCam.mp4';

export async function GET(request: NextRequest) {
    try {
        // Forward Range header for proper video streaming/seeking
        const rangeHeader = request.headers.get('Range');
        const fetchHeaders: HeadersInit = {};

        if (rangeHeader) {
            fetchHeaders['Range'] = rangeHeader;
        }

        const response = await fetch(VIDEO_URL, {
            headers: fetchHeaders,
        });

        if (!response.ok && response.status !== 206) {
            return new NextResponse(`Failed to fetch video: ${response.statusText}`, { status: response.status });
        }

        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Cache-Control', 'public, max-age=3600');
        headers.set('Content-Type', 'video/mp4');
        headers.set('Accept-Ranges', 'bytes');

        // Forward important headers from the upstream response
        const contentLength = response.headers.get('Content-Length');
        const contentRange = response.headers.get('Content-Range');

        if (contentLength) {
            headers.set('Content-Length', contentLength);
        }
        if (contentRange) {
            headers.set('Content-Range', contentRange);
        }

        return new NextResponse(response.body, {
            status: response.status, // Will be 206 for Range requests, 200 otherwise
            headers,
        });
    } catch (error) {
        console.error('Proxy error:', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
