# Hosting

Two ways to put the game in front of players. The first is a command; the
second is any static host you like.

## Host on Crowdy Games (one command)

```sh
CONSTRUCT_EMAIL=you@example.com CONSTRUCT_PASSWORD=... npm run publish
# -> Play it at: https://<games host>/<slug>/
```

`npm run publish` signs in with your account (an identity session, from Node --
a browser page cannot do this, by design), claims a **slug** for your app
(default: the app's slug; `-- --slug my-game` to choose), builds, and uploads
`dist/` to the platform. Your game is then reached at
`https://<games host>/<slug>/` -- a first-party Crowded Kingdoms page (the
*shell*) that frames your bundle from an origin of its own,
`https://<slug>.<content host>`. Every header in the next section is served for
you by the platform's edge, including the `/dsh/*` policy, and `crossOriginIsolated`
is true inside the frame (the shell delegates it), so CLIENT mods work.

What is different from self-hosting, and what is not:

- **Sign-in is the same flow** (`portal.signIn` -> Studio `/authorize` ->
  `portal.handleSignInCallback`). Inside the shell the SDK (CrowdyJS >= 17.2)
  asks the shell to navigate the tab and uses the shell page as the
  `redirect_uri`; the shell relays the returned code into your frame. Nothing in
  this repo changes for it. The PKCE verifier never leaves your origin and the
  shell never holds a token.
- **Your origin is yours.** localStorage, IndexedDB, service workers and
  `BroadcastChannel` are per game; no other game shares them.
- **The slug is global on the tier** and a DNS label (`a-z0-9-`, 1-63, no edge
  hyphens); first-party names are reserved. `HOSTED_SLUG_UNAVAILABLE` says
  which rule you hit. Publishing is self-serve and immediate; being *listed* in
  the Overworld lobby is an operator's decision.
- **Quotas**: 2,000 files / 250 MB per publish, 60 MB per file, 10 publishes an
  hour per app. A 0.6 build is ~130 files / ~23 MB.
- **You publish from the tier your SDK pin dials.** A `prod` clone publishes to
  production Crowdy Games; a `dev` clone to the dev tier. The same
  `manage_apps` permission that let you run `npm run setup` is what lets you
  publish. `--no-build` reuses an existing `dist/`; `--dir` points at another.
- `CONTENT_HOSTING_DISABLED` means the tier you dialled has no content CDN yet;
  self-host (below) until it does.

Everything below is for hosting the build yourself.

## Self-hosting

`npm run build` writes a static site to `dist/`. Put it on any static host.
One requirement decides whether Crowdy Studio CLIENT mods work: the host must
send the cross-origin isolation headers on **every** response (HTML, JS, wasm,
worker scripts), and should send the Content-Security-Policy too.

`security-headers.mjs` is the source of truth; the Vite **preview** server and
default `npm run dev` use it, and the values below are copied from it. If you
change the API origin (`VITE_CROWDY_HTTP_URL`), regenerate the `connect-src`
line — e.g.
`node -e "import('./security-headers.mjs').then(m=>console.log(m.buildCsp({apiOrigins:['https://YOUR_ORIGIN']})))"`.

A local ck-api or IDE-on-public-IP checkout may set `VITE_DEV_PROXY`,
`VITE_DEV_ALLOWED_HOSTS`, and `VITE_DEV_RELAX_ISOLATION` in gitignored
`.env.local` (see `.env.example`). Those flags never apply to preview or a
production host. `VITE_DEV_RELAX_ISOLATION=1` strips COEP/COOP on the *dev
server only* so a plain-HTTP public IP can load; CLIENT mods stay off.

## The headers

Behind a shell of your own? Set `CONSTRUCT_FRAME_ANCESTORS=https://your-shell.example`
when you build/preview, or pass `frameAncestors` to `securityHeaders()`: the
game then serves `frame-ancestors <that origin>` (the DSH pane `'self'` plus it)
and `Cross-Origin-Resource-Policy: cross-origin`, which a framed document needs
under the shell's COEP. The shell itself must send COOP `same-origin`, a COEP,
and delegate `cross-origin-isolated` to the frame (`Permissions-Policy` +
`allow=`), or `crossOriginIsolated` is false inside it. `tests/e2e/shell.spec.ts`
is the working example.

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(self), microphone=(self)
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://<api-origin> wss://<api-origin> https://*.<tier-zone> wss://*.<tier-zone>; worker-src 'self' blob:; frame-src 'self'; media-src 'self' blob:; manifest-src 'self'
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
```

The game page embeds the Studio agent pane (`/dsh/index.html`) in a same-origin
iframe, so `frame-src 'self'` is required. Responses under `/dsh/*` (the harness
HTML, assets, and worker script) carry the relaxed DSH policy generated by
`buildDshCsp()`:
`script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:`,
`connect-src 'self' blob: ...`, `frame-ancestors 'self'`.
The game page's own policy remains strict (`wasm-unsafe-eval`, no JS eval).

That iframe is same-origin by design: the page and the harness worker talk
over a `BroadcastChannel` and the harness persists sessions in OPFS, both of
which are origin-scoped. Its `sandbox="allow-scripts allow-same-origin"`
therefore does not isolate it from the page; the `/dsh/*` CSP above is the
control, and it is why that policy must not be relaxed further. Serving the
harness from its own origin is a tracked follow-up in CrowdyJS.

### Where `/dsh/` comes from

`public/dsh/` is not in git. `scripts/copy-dsh-web.mjs` runs before `vite dev`
and `vite build` (`predev` / `prebuild`) and copies `dist/dsh-web/` out of the
`@crowdedkingdoms/crowdy-dsh` devDependency into it. The copy is ~13 MB: the
harness web client, the worker, the packed plugin image, `BUILD.json` (which
harness tag and CrowdyJS the artifact carries, sha256 per file) and the MIT
notices. Upgrade by bumping the devDependency; pin it exactly like the SDK,
and keep its CrowdyJS major equal to the SDK's (the harness refuses to build
otherwise). `DSH_WEB_DIR=/path/to/dist/dsh-web` serves a locally built
artifact; `CONSTRUCT_SKIP_DSH=1` builds without the agent pane.

One serving detail: `preview/vfs-image.tar.gz` must reach the browser with NO
`Content-Encoding` header, because the harness worker decompresses it itself.
`vite dev`/`preview` handle this for `.gz` under `/dsh/` (see
`dshHeadersPlugin` in `vite.config.ts`); a static host that adds
`Content-Encoding: gzip` for `.gz` files needs the same exception, and only
for that suffix.

`Permissions-Policy` is what lets the proximity webcam (`WebcamService`) and
voice (`VoiceService`) ask for the camera and microphone, and denies both to
anything embedded. Some hosts ship a default policy that denies devices
outright, so set it explicitly.

`<api-origin>` is the host the bundle dials (for the published `latest` SDK,
the production API). `<tier-zone>` is that host minus its first label: the API
hands clients to a per-datacenter and then a per-instance name under the same
zone, and the wildcard is what lets that move happen. The zone is one label
wide on purpose: a build for one tier cannot reach another. The world hub
connection (ck-exec) dials an execution host's gateway, a `wss://` name under
the same zone, so it needs nothing more; a build pointed at a proxy or a raw IP
(`VITE_CROWDY_HTTP_URL`) must add the gateway's origin with `extraConnectSrc`.

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
  Permissions-Policy: camera=(self), microphone=(self)
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
        { "key": "Permissions-Policy", "value": "camera=(self), microphone=(self)" },
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
  add_header Permissions-Policy "camera=(self), microphone=(self)" always;
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
  Permissions-Policy "camera=(self), microphone=(self)"
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
