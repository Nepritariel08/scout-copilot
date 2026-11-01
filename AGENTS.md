# Scout integration agreement

- This is the owned fork of CopilotKit/OpenDuet. Preserve upstream MIT notices.
- Read SCOUT-INTEGRATION.md before Scout work. Use SSC AI Enablement #4 as the
  primary tracker, under architecture #8; do not create a competing outcome queue.
- Prefer the tenant-package extension at openbot/examples/scout to deep platform
  forks. Do not modify the upstream OpenDuet tenant package for Scout branding.
- One writer per branch/host/device. Queue, Community host and native-device
  owners remain separate; reconcile current ownership before changing them.
- Preserve the existing Odoo/DSH queue's identity, idempotency, leases, revisions,
  cancellation, acceptance and receipts. No second scheduler for the same work.
- Prompts, tenant branding, channel groups and AG-UI are not authorization. Bind
  requester/tenant rights on the server after verified authentication.
- Keep all credentials and real business data out of source, logs and fixtures.
- Use Bun 1.4.3 and frozen lockfiles. Run focused existing checks for material
  changes; distinguish configuration checks, mocked upstream tests, real
  integration, exact-head CI, deployment, live behavior and human acceptance.
- Preserve the licensed Intelligence composition and its entitlements. Scout's
  explicit owned mode uses the public MIT runner and its own PostgreSQL store;
  never emulate vendor entitlements or claim production acceptance from source.
- Physical PC-off testing is deferred. No timers/countdowns are authorized now.
