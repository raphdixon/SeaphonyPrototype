---
description: Deploy squidphony-mini to Cloudflare Pages
---

# Deploy squidphony-mini to Cloudflare Pages

// turbo-all

1. Build the project:
```bash
cd /Users/r/Library/Mobile Documents/com~apple~CloudDocs/Code/Projects/Google/Squid Music/squidphony-mini
npm run build
```

2. Remove the large video file from dist (it's served via an R2 worker, not Cloudflare Pages):
```bash
find /Users/r/Library/Mobile Documents/com~apple~CloudDocs/Code/Projects/Google/Squid Music/squidphony-mini/dist -name "SquidCam.mp4" -delete
```

3. Deploy to Cloudflare Pages. **The project name is `squidphony`** (NOT `sound-system`):
```bash
cd /Users/r/Library/Mobile Documents/com~apple~CloudDocs/Code/Projects/Google/Squid Music/squidphony-mini
npx wrangler pages deploy dist --project-name=squidphony
```
