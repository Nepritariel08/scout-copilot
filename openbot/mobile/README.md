# Scout mobile chat client

This Expo app provides a native sign-in and text chat for built-in Scout agents.
It reads conversations from the owned CopilotKit history endpoint and submits
turns through the owned AG-UI runner; PostgreSQL on the server remains the
transcript authority. The client does not include delivery, routines, memory,
approvals, computer access, plugins or push notifications.

## Build

The GitHub Actions workflow `Scout mobile test APK` creates a standalone Android
APK with the JavaScript bundle embedded. It does not use EAS, an EAS project ID,
signing secrets or a Metro server. The resulting artifact is debug-signed for
installation on Android test devices and is not a Play Store release.

The build configures the public origin as
`https://scout.somethingsomewhere.ph`. That hostname's current TLS and app route
have not been verified, so a successful APK build does not establish that the
phone can reach Scout or sign in. Before live sign-in, confirm the HTTPS route,
configure the exact Microsoft Entra web callback, and enable the server's narrow
native callback with `SCOUT_NATIVE_AUTH_ENABLED=true`. This switch enables only
Better Auth's `scoutmobile://` callback; it does not enable push or require an
EAS project.

For local development, install the reviewed `package-lock.json` with `npm ci`,
set `EXPO_PUBLIC_SERVER_URL` to an approved HTTPS origin, and use Expo's native
prebuild/run commands. The release APK build is independent of a development
server.

## Checks

Run `npm run typecheck` and `npm test` from this directory. The focused
tests cover persisted history reads, authenticated request shape, owned-run
payloads, streamed text, terminal events and error handling.
