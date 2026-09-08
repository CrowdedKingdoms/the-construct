# Hosting

`npm run build` writes a static site to `dist/`. Put it on any static host.
One requirement decides whether Crowdy Studio CLIENT mods work: the host must
send the cross-origin isolation headers on **every** response (HTML, JS, wasm,
worker scripts), and should send the Content-Security-Policy too.

`security-headers.mjs` is the source of truth; the Vite dev and preview servers
use it, and the values below are copied from it. If you change the API origin
(`VITE_CROWDY_HTTP_URL`), regenerate the `connect-src` line — e.g.
`node -e "import('./security-headers.mjs').then(m=>console.log(m.buildCsp({apiOrigins:['https://YOUR_ORIGIN']})))"`.

## The headers

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(self), microphone=()
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://<api-origin> wss://<api-origin> https://*.<tier-zone> wss://*.<tier-zone>; worker-src 'self' blob:; frame-src 'none'; media-src 'self' blob:; manifest-src 'self'
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
```

`Permissions-Policy` is what lets the proximity webcam (`WebcamService`) ask
for the camera and denies it to anything embedded; the microphone stays denied
until a fork wires voice (then `microphone=(self)`). Some hosts ship a default
policy that denies the camera outright, so set it explicitly.

`<api-origin>` is the host the bundle dials (for the published `latest` SDK,
the production API). `<tier-zone>` is that host minus its first label: the API
hands clients to a per-datacenter and then a per-instance name under the same
zone, and the wildcard is what lets that move happen. The zone is one label
wide on purpose: a build for one tier cannot reach another.

## How to tell it worked

Open the site and check `crossOriginIsolated` in the console — it must be
`true`. The game checks the same thing at boot and shows a banner when it is
not. The Playwright smoke (`npm run test:e2e`) asserts it against `vite preview`.

## Recipes

### Netlify

`public/_headers` (copied into `dist/`):

```text
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: camera=(self), microphone=()
  Content-Security-Policy: <the CSP line above>
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
```

### Vercel

`vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" },
        { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" },
        { "key": "Permissions-Policy", "value": "camera=(self), microphone=()" },
        { "key": "Content-Security-Policy", "value": "<the CSP line above>" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "X-Content-Type-Options", "value": "nosniff" }
      ]
    }
  ]
}
```

### Cloudflare Pages

`public/_headers` with the same block as Netlify.

### AWS S3 + CloudFront

Attach a **response headers policy** to the distribution's default behaviour
with the six headers as custom headers (CloudFront's managed security-headers
policy does not include COOP/COEP). Serve `index.html` for unknown paths with
a viewer-request function if you add client-side routes.

### nginx

```nginx
location / {
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Cross-Origin-Embedder-Policy "credentialless" always;
  add_header Cross-Origin-Resource-Policy "same-origin" always;
  add_header Permissions-Policy "camera=(self), microphone=()" always;
  add_header Content-Security-Policy "<the CSP line above>" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Content-Type-Options "nosniff" always;
  try_files $uri $uri/ /index.html;
}
```

### Caddy

```caddyfile
header {
  Cross-Origin-Opener-Policy "same-origin"
  Cross-Origin-Embedder-Policy "credentialless"
  Cross-Origin-Resource-Policy "same-origin"
  Permissions-Policy "camera=(self), microphone=()"
  Content-Security-Policy "<the CSP line above>"
  Referrer-Policy "strict-origin-when-cross-origin"
  X-Content-Type-Options "nosniff"
}
try_files {path} /index.html
```

### GitHub Pages

GitHub Pages cannot set response headers. The game runs there, but
`crossOriginIsolated` is false, so CLIENT mods are disabled and the banner says
so. Use any host above for the full experience.

## Sub-path deployments

The bundle is built for the site root. For `https://example.com/my-game/`, build
with `npx vite build --base=/my-game/`. The app token store is namespaced per
app and API origin, not per path, so two games on one origin do not collide.

## Pinning the app

A hosted build usually serves one app: set `VITE_APP_ID` at build time so
players go straight to sign-in. Leave it unset for a "bring your own app"
deployment; players can still pass `?app=<id>`.

**Register the origin.** Hosted sign-in returns the player to the page that
started it, and the API accepts that return -- and any CORS request from the
page -- only if the page's origin is one of the app's redirect URIs. Add your
production origin once: `npm run setup -- --origin https://play.example.com`,
or Studio > Apps > Settings > Sign-in & redirect URIs. `npm run setup` registers
`http://localhost:5175` for the dev server automatically.
