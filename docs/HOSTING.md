# Hosting

Crowded Kingdoms does not host games: you put the build on a host of your own. Any
static host works if it can set response headers. (Crowdy Games, where
`npm run publish` used to upload it, was retired on 2026-10-29, and the platform's
hosting API answers `CONTENT_HOSTING_DISABLED` on every tier.)

## Five steps

1. **Register your address.** In your checkout,
   `npm run setup -- --origin https://play.example.com` adds that origin to the app's
   redirect URIs and, when the app has no launch URL yet, makes it the launch URL. You
   can also set both in Crowdy Studio: the app > Settings > Sign-in & redirect URIs.
   Hosted sign-in returns players only to a registered origin, and the same list is the
   API's CORS allow-list for your page.
2. **Build.** `npm run build` writes a static site to `dist/`. Set `VITE_APP_ID` so the
   build serves your app ([Pinning the app](#pinning-the-app)).
3. **Upload `dist/` with the headers** in [The headers](#the-headers): cross-origin
   isolation on every response, a Content-Security-Policy per page, the agent pane's
   files under `/dsh/` with their own policy, and `construct-draft-sw.js` served as
   itself. The [recipes](#recipes) do this for common hosts.
4. **Check it.** Open the site: `crossOriginIsolated` must be `true` in the console, and
   Crowdy Studio (M) opens with the agent pane ([How to tell it worked](#how-to-tell-it-worked)).
5. **Use Live code on it.** Crowdy Studio's Live code opens the app's launch URL with the
   dock on your bound project ([Live code on your host](#live-code-on-your-host)).

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

Every response, whatever the path:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Resource-Policy: same-origin
Access-Control-Allow-Origin: null
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
```

`Access-Control-Allow-Origin: null` is for the JS grid program sandbox: it is an opaque
origin, so its module scripts are fetched with `Origin: null` and need that answer. The
dev and preview servers send it only to those requests; a static host sends it on every
file, which exposes nothing, because the files are your public build.

Then one Content-Security-Policy and one Permissions-Policy per page. A build has three
kinds of page, and each needs its own policy:

| Path | Content-Security-Policy | Permissions-Policy |
| --- | --- | --- |
| `/` and `/index.html` | the game's, below | `camera=(self), microphone=(self)` |
| `/dsh/*` | the agent pane's, below | `camera=(self), microphone=(self)` |
| `/grid-program.html` | the grid program sandbox's, below | `camera=(), microphone=(), geolocation=()` |

**Never set one policy on every path.** A browser enforces every Content-Security-Policy
it receives, and many hosts combine overlapping rules, so the game's policy on `/*` lands
on `/dsh/*` as well and keeps the agent pane from starting. Set each policy on its own
paths, as the recipes do.

The game's policy (`buildCsp()`):

```text
default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://<api-origin> wss://<api-origin> https://*.<tier-zone> wss://*.<tier-zone>; worker-src 'self' blob:; frame-src 'self'; media-src 'self' blob:; manifest-src 'self'
```

The agent pane's policy (`buildDshCsp()`), for the harness HTML, assets and worker
under `/dsh/`:

```text
default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: https://<api-origin> wss://<api-origin> https://*.<tier-zone> wss://*.<tier-zone>; worker-src 'self' blob:; frame-src 'self'; media-src 'self' blob:; manifest-src 'self'
```

The grid program sandbox's policy (`buildGridProgramCsp()`), which also sends
`Referrer-Policy: no-referrer`:

```text
default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'
```

Three serving details:

- **`.wasm` as `application/wasm`.** Most hosts do this already.
- **No fallback to `index.html`.** The game has no client-side routes. If your host
  adds a fallback, keep it to paths without a file extension, so a missing script or
  `construct-draft-sw.js` is never answered with the page.
- **`/dsh/preview/vfs-image.tar.gz` without `Content-Encoding`.** See below.

Behind a shell of your own? Set `CONSTRUCT_FRAME_ANCESTORS=https://your-shell.example`
when you build/preview, or pass `frameAncestors` to `securityHeaders()`: the
game then serves `frame-ancestors <that origin>` (the DSH pane `'self'` plus it)
and `Cross-Origin-Resource-Policy: cross-origin`, which a framed document needs
under the shell's COEP. The shell itself must send COOP `same-origin`, a COEP,
and delegate `cross-origin-isolated` to the frame (`Permissions-Policy` +
`allow=`), or `crossOriginIsolated` is false inside it. `tests/e2e/shell.spec.ts`
is the working example.

The game page embeds the Studio agent pane (`/dsh/index.html`) in a same-origin
iframe, so `frame-src 'self'` is required. The game page's own policy remains
strict (`wasm-unsafe-eval`, no JS eval); the agent pane's relaxed one applies only
under `/dsh/`.

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
`vite dev`/`preview` handle this for `.gz` under `/dsh/`, under the game's
base too (`constructHeaderPlugins` in the framework's `node/vite-plugins.mjs`,
which also types the image so preview compression leaves it alone); a static host that adds
`Content-Encoding: gzip` for `.gz` files needs the same exception, and only
for that suffix.

`Permissions-Policy` is what lets the proximity webcam (`WebcamService`) and
voice (`VoiceService`) ask for the camera and microphone, and denies both to
anything embedded. Some hosts ship a default policy that denies devices
outright, so set it explicitly.

### The game editor's preview: `construct-draft-sw.js`

Crowdy Studio's game editor previews a player's uncommitted edits in the
running world. On your deployed game that is a service worker the build writes
next to `index.html` (`constructDraftPlugin` in `vite.config.ts`):

- It is registered only when the game's owner opens the game editor, with the
  game's base as its scope (a service worker sees only the requests of pages
  it controls). It answers nothing but `<base>__draft/` URLs: draft modules
  built from the edits in that browser, and shims onto the page's own
  modules. Navigations, `/dsh/`, the API and the game's assets go to the
  network untouched, so the headers above still apply and
  `crossOriginIsolated` stays `true`.
- It needs no header change: draft modules are same-origin scripts
  (`script-src 'self'`), nothing is evaluated from a string or a blob, and the
  worker itself is same-origin (`worker-src 'self'`).
- Serve it as `text/javascript` and do not cache it for long (`Cache-Control:
  no-cache` is right); the page registers it with `updateViaCache: 'none'`.
  A host that rewrites unknown paths to `index.html` must still serve this
  file as itself.
- Only the content layer (`src/game/content.ts` and what it imports)
  previews this way. A draft can import only what the published build already
  bundles; the preview says so when it imports something else.

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
not. Then open Crowdy Studio (M): the agent pane starts only when `/dsh/` has its own
policy and the image arrives undecoded. `curl -I https://your.host/dsh/index.html`
should show the agent pane's policy, and `curl -I https://your.host/` the game's. The
Playwright smoke (`npm run test:e2e`) asserts isolation against `vite preview`.

## Live code on your host

Crowdy Studio's Live code opens the app's launch URL with
`?app=<id>&studio=open&project=<id>`: your game, with the dock on the bound project in
the game editor. Your edits are a draft in your browser, previewed by
`construct-draft-sw.js`, and Commit in the dock publishes them to GitHub as one commit.
Live code does not deploy: build and upload again to ship the change.

A sign-in returns to the bare page address, without that query, so the game keeps what
it needs across it: `main.ts` remembers the app id before sign-in, and
`rememberRequestedProject` keeps the requested project for the tab until the editor
opens it.

During development, `LIVE_DRAFT=1 npm run dev` in the bound repository's clone is the
same flow against your checkout (README, "Editing the game from Crowdy Studio").

## Letting players mod your game

Mods are written in Crowdy Studio inside your running game, so the page you host is where
players mod it. On top of the headers above, it takes:

- **Access.** Writing mods needs an access tier with `use_studio_agent`. `npm run setup`
  creates the Constructor tier with it and grants it to you; every visitor can run mods
  others wrote.
- **Allow Live Modding**, on the app's page in Crowdy Studio, for drafts and live deploys
  from the dock.
- **Cross-origin isolation** for CLIENT mods, which run in the player's browser. The page
  shows a banner when it is missing.
- **The agent pane**, which needs the `/dsh/` files and their policy.

Server mods run on the platform's ck-exec, so nothing about them depends on your host.
[MODDING.md](MODDING.md) has the details.

## Recipes

Each recipe puts the shared headers on every path and each Content-Security-Policy on its
own paths. Replace `<the game's policy>` and the other placeholders with the lines in
[The headers](#the-headers), with your API origin filled in.

### Netlify and Cloudflare Pages

`public/_headers` (copied into `dist/`). The CSP rules name exact paths, so no path gets
two policies:

```text
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  Cross-Origin-Resource-Policy: same-origin
  Access-Control-Allow-Origin: null
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff

/
  Content-Security-Policy: <the game's policy>
  Permissions-Policy: camera=(self), microphone=(self)

/index.html
  Content-Security-Policy: <the game's policy>
  Permissions-Policy: camera=(self), microphone=(self)

/dsh/*
  Content-Security-Policy: <the agent pane's policy>
  Permissions-Policy: camera=(self), microphone=(self)

/grid-program.html
  Content-Security-Policy: <the grid program sandbox's policy>
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/construct-draft-sw.js
  Cache-Control: no-cache
```

Load `/dsh/` once after deploying and watch the agent pane start: if the host labels
`.gz` files `Content-Encoding: gzip`, `preview/vfs-image.tar.gz` needs an exception.

### Vercel

`vercel.json`, again with each policy on its own paths:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" },
        { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" },
        { "key": "Access-Control-Allow-Origin", "value": "null" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "X-Content-Type-Options", "value": "nosniff" }
      ]
    },
    {
      "source": "/",
      "headers": [
        { "key": "Content-Security-Policy", "value": "<the game's policy>" },
        { "key": "Permissions-Policy", "value": "camera=(self), microphone=(self)" }
      ]
    },
    {
      "source": "/index.html",
      "headers": [
        { "key": "Content-Security-Policy", "value": "<the game's policy>" },
        { "key": "Permissions-Policy", "value": "camera=(self), microphone=(self)" }
      ]
    },
    {
      "source": "/dsh/(.*)",
      "headers": [
        { "key": "Content-Security-Policy", "value": "<the agent pane's policy>" },
        { "key": "Permissions-Policy", "value": "camera=(self), microphone=(self)" }
      ]
    },
    {
      "source": "/grid-program.html",
      "headers": [
        { "key": "Content-Security-Policy", "value": "<the grid program sandbox's policy>" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" }
      ]
    },
    {
      "source": "/construct-draft-sw.js",
      "headers": [{ "key": "Cache-Control", "value": "no-cache" }]
    }
  ]
}
```

### AWS S3 + CloudFront

Three cache behaviours, each with a response headers policy carrying the shared headers
(`Access-Control-Allow-Origin: null` among them) plus its own Content-Security-Policy and
Permissions-Policy as custom headers: the
default behaviour (the game's), `/dsh/*` (the agent pane's) and `/grid-program.html`
(the grid program sandbox's). CloudFront's managed security-headers policy does not
include COOP/COEP. Leave out any viewer-request rewrite to `index.html`: the game has no
client-side routes.

### nginx

nginx's `add_header` in a `location` replaces the server's, so each `location` repeats
the shared headers:

```nginx
server {
  listen 8080;
  root /srv/game;  # your dist/

  location / {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Access-Control-Allow-Origin "null" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Permissions-Policy "camera=(self), microphone=(self)" always;
    add_header Content-Security-Policy "<the game's policy>" always;
  }

  location /dsh/ {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Access-Control-Allow-Origin "null" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Permissions-Policy "camera=(self), microphone=(self)" always;
    add_header Content-Security-Policy "<the agent pane's policy>" always;
  }

  location = /grid-program.html {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Access-Control-Allow-Origin "null" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "<the grid program sandbox's policy>" always;
  }

  location = /construct-draft-sw.js {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "credentialless" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Access-Control-Allow-Origin "null" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Cache-Control "no-cache" always;
  }
}
```

Leave `gzip_static` off for `/dsh/`, so `vfs-image.tar.gz` goes out as it is.

### Caddy

```caddyfile
:8080 {
  root * /srv/game
  file_server

  header {
    Cross-Origin-Opener-Policy "same-origin"
    Cross-Origin-Embedder-Policy "credentialless"
    Cross-Origin-Resource-Policy "same-origin"
    Access-Control-Allow-Origin "null"
    X-Content-Type-Options "nosniff"
  }

  @game path / /index.html
  header @game Content-Security-Policy "<the game's policy>"
  header @game Permissions-Policy "camera=(self), microphone=(self)"

  @dsh path /dsh/*
  header @dsh Content-Security-Policy "<the agent pane's policy>"
  header @dsh Permissions-Policy "camera=(self), microphone=(self)"

  @grid path /grid-program.html
  header @grid Content-Security-Policy "<the grid program sandbox's policy>"
  header @grid Permissions-Policy "camera=(), microphone=(), geolocation=()"
  header @grid Referrer-Policy "no-referrer"

  @notGrid not path /grid-program.html
  header @notGrid Referrer-Policy "strict-origin-when-cross-origin"

  @draft path /construct-draft-sw.js
  header @draft Cache-Control "no-cache"
}
```

Caddy runs `header` lines with the most specific matcher first and the unmatched block last, so
a header set in both places takes the unmatched value: that is why `Referrer-Policy` is set
per path here. Caddy serves `.gz` files as they are unless you turn on `precompressed`;
leave it off.

### GitHub Pages

GitHub Pages cannot set response headers. The game runs there, but
`crossOriginIsolated` is false, so CLIENT mods are disabled and the banner says
so, and the agent pane does not start. Use any host above for the full experience.

## Sub-path deployments

The bundle is built for the site root. For `https://example.com/my-game/`, build
with `npx vite build --base=/my-game/`, and put the paths in your host's rules under
`/my-game/` too. The app token store is namespaced per app and API origin, not per
path, so two games on one origin do not collide.

## Pinning the app

A hosted build usually serves one app: set `VITE_APP_ID` at build time so
players go straight to sign-in. Leave it unset for a "bring your own app"
deployment; players can still pass `?app=<id>`.

**Register the origin.** Hosted sign-in returns the player to the page that
started it, and the API accepts that return -- and any CORS request from the
page -- only if the page's origin is one of the app's redirect URIs. Add your
production origin once: `npm run setup -- --origin https://play.example.com`,
or Studio > Apps > Settings > Sign-in & redirect URIs. `npm run setup` registers
`http://localhost:5175` for the dev server automatically, and makes the first
`--origin` the app's launch URL when it has none; Crowdy Studio's Live code opens the
launch URL.
