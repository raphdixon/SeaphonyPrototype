---
description: Deploy squidphony-mini to Cloudflare Pages
---

# Deploy Squidphony Mini

**Project**: `squidphony` → `squidphony.pages.dev`
**Assets Worker**: `squid-assets.quiet-king-8097.workers.dev` (serves large video files via R2)

> ⚠️ Do NOT deploy to `sound-system` — that is a different app!

## Steps

// turbo
1. Build the project:
```bash
npm run build
```

// turbo
2. Remove large video files from dist (served via R2 worker instead):
```bash
find dist -name "*.mp4" -size +25M -delete
```

3. Deploy to Cloudflare Pages:
```bash
npx wrangler pages deploy dist --project-name squidphony
```
