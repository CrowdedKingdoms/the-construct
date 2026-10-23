# Signing in your own players (org-managed players)

The Construct signs players in with hosted sign-in: the page sends the player to Crowded
Kingdoms' sign-in page and gets back a token for your app. That works for players with a
Crowded Kingdoms account. If your studio runs its own player accounts and your organization
uses **org-managed players**, your players never see a Crowded Kingdoms sign-in, and hosted
sign-in cannot sign them in. This page shows the swap. The platform side (enabling the
feature, the addendum, org tokens, signing keys) is in the public docs:
[Org-managed players](https://docs.crowdedkingdoms.com/management-api/org-managed-players).

## What changes

Only the sign-in step. Your own sign-in page authenticates the player. Then either:

- **an org token:** your backend calls `mintManagedPlayerToken` with the org token it keeps
  on the server, and returns the player's app token to the page; or
- **a signed assertion:** your sign-in service signs a short assertion, and the page trades it
  with `portal.exchangeManagedPlayerAssertion`.

Either way the page ends up holding the player's app token, the same kind hosted sign-in
gives it. Everything after that (entering the app, the world hub, Crowdy Studio, voice, the
webcam) is unchanged. The page never holds an org token: the API refuses one sent from a
browser, and `adoptAppToken` refuses one too.

## The code

In [`packages/construct/src/platform/network/NetworkManager.ts`](../packages/construct/src/platform/network/NetworkManager.ts),
beside `completeHostedSignInIfPresent`, add a method that does what that one does after
`handleSignInCallback`, with your token instead:

```ts
import type { AppTokenResponse } from '@crowdedkingdoms/crowdyjs';

/** An org-managed player: adopt the app token your backend minted for it. */
async adoptManagedSignIn(access: AppTokenResponse): Promise<AppRoute> {
  this.platform.portal.adoptAppToken(access);
  const route = this.routeFrom(access, String(access.appId));
  writeScoped(savedRouteBase(), JSON.stringify(route));
  await this.hydrateUser();
  return route;
}
```

With a signed assertion, trade it first; the exchange stores the token itself:

```ts
const access = await this.platform.portal.exchangeManagedPlayerAssertion({ appId, assertion });
```

Then, where the boot flow would call `AuthService.signIn(appId)`, fetch the token from your
backend and adopt it instead:

```ts
const access = await fetch('/api/crowded-kingdoms/token', { credentials: 'include' }).then((r) =>
  r.json(),
);
const route = await network.adoptManagedSignIn(access);
```

`/api/crowded-kingdoms/token` stands for your own endpoint: it checks your player's session,
calls `mintManagedPlayerToken` and returns the result.

## Refresh and sign-out

The starter refreshes the app token before it expires, as it does for a hosted sign-in. A
managed sign-in lasts as long as your organization's sign-in length (24 hours by default).
After that the refresh is refused: ask your backend for a new sign-in. Signing out forgets the
token on the page; to sign the player out everywhere, your backend calls
`endManagedPlayerSessions`.

## Crowdy Studio and the agent

A managed player has no wallet, so its mods and agent use are your organization's to pay for.
The in-game Studio dock works for it only in an app where your organization switched
managed-player mods on (Studio: the app's **Usage & Billing** tab), and only with the code keys
and `use_studio_agent` on the player's access tier. See [MODDING.md](MODDING.md) for the keys.
