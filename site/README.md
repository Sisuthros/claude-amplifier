# claude-amplifier landing page

Static, single-page marketing site for [claude-amplifier](https://www.npmjs.com/package/claude-amplifier).

## Stack

- Vanilla HTML + CSS. **No build step. No JavaScript framework.**
- Google Fonts (JetBrains Mono) loaded from CDN at runtime.
- One `vercel.json` for clean URLs + security headers.

## File map

```
site/
  index.html       # single-page landing
  styles.css       # dark theme, mobile-first
  favicon.svg      # monogram wave + dot
  og-image.svg     # 1200x630 social card
  vercel.json      # cleanUrls + security headers
  README.md        # this file
```

## Manual deploy (Vercel)

```bash
cd /path/to/claude-amplifier/site
npx vercel --prod
```

On first run Vercel will:

1. Ask to link or create a project &mdash; choose **new project**, name it `claude-amplifier-site`.
2. Detect framework as **Other** (static).
3. Output Dir: `.` (root of `site/`).
4. Build Command: leave empty.
5. Deploy.

## Custom domain

Once deployed:

1. Buy `claude-amplifier.dev` (Namecheap, Porkbun, Cloudflare Registrar &mdash; ~$13/yr).
2. In Vercel project &rarr; Settings &rarr; Domains, add `claude-amplifier.dev`.
3. Add the DNS records Vercel suggests:
   - `A` &rarr; `76.76.21.21`
   - `CNAME` `www` &rarr; `cname.vercel-dns.com`
4. Wait for SSL provisioning (Vercel handles Lets Encrypt automatically).

## Local preview

```bash
cd /path/to/claude-amplifier/site
npx serve .
# or any static server: python -m http.server 8000
```

Open <http://localhost:3000>.

## Analytics

Plausible script is included in `index.html` as a commented-out placeholder. After domain is live:

1. Sign up at <https://plausible.io>.
2. Add `claude-amplifier.dev` as a site.
3. Uncomment the `<script>` tag in `index.html`.
4. Redeploy.

No cookies, GDPR-friendly, no consent banner needed.

## License

MIT &mdash; same as the parent project.
