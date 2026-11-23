# Six-policy release image

This packages the existing six-policy flow, preserving separate consumer and admin listeners. It adds no application features. Use one accepted immutable image digest in staging and production. The November 20 image needs rebuilding: a reproduced private-markup leak is fixed at the Actor boundary before streaming, final output, checkpoints and evidence attribution.

## Recorded sources

- App main: `2fbfd3558d03528cd002471458c9659ac1f0cc5b` (consumer/admin isolation included).
- App release base: `380f070f94631bad19804acd42bafbc0ec64ea95`, PR #4; runtime lock and preview typing change from main. This release adds build files and updates the lock to the privacy fix; export the final committed host source.
- Harness base: `2d28db3cb433635dd17631ce1d0d3741e3492c45`; the exact fixed commit and application hash are in `harness-runtime.lock.json`.

The archive packer exports those commits, excluding local files, environment secrets, generated output and uncommitted edits. It checks the embedded Git archive identity and writes SHA-256 receipts. The image compiles Linux dependencies, independently checks the actual Harness application source hash against the app lock, and generates contracts. It does not copy or relabel an old runtime. Pin `NODE_IMAGE` by digest when rebuilding; record the resulting image digest because source-identical builds are not guaranteed to be byte-identical.

```sh
python3 deploy/container/package-runtime.py --harness /path/to/roleplay-harness --output /path/to/build-context
docker build -f /path/to/build-context/Dockerfile.runtime --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:VERIFIED_DIGEST --build-arg APP_COMMIT=EXPORTED_APP_COMMIT --build-arg HARNESS_COMMIT=LOCKED_HARNESS_COMMIT -t agentic-v3:RELEASE_TAG /path/to/build-context
```

## Runtime contract

Both commands use the same image and database. They bind **127.0.0.1**, so a Kubernetes proxy must share their Pod network namespace. A Service cannot directly reach these listeners. Do not expose the internal gateway secret or allow browser-supplied identity headers through the proxy.

| Entry | Command | Port |
| --- | --- | --- |
| Consumer | `node --import tsx server/index.ts --production` | `7633` (`PORT`) |
| Admin | `node --import tsx server/index.ts --production --admin` | `7634` (`ADMIN_PORT`) |

Both have model-free `/health/live` and database-backed `/health/ready`. Since listeners are loopback, use an exec probe or a proxy-local probe route. The consumer serves only `/app/dist`; admin serves only `/app/dist-admin` after admin authorization. Do not mount either directory through a separate public static server. Both processes have existing background workers coordinated by database leases.

Required environment keys (values belong in deployment Secrets): `DATABASE_URL`, `AUTH_GATEWAY_SECRET` (at least 32 bytes), `KAON_API_KEY`, `KAON_MODEL`. Set `MODEL_MODE=live`, `OLD_AGENT_TEAM=false`, `LOCAL_DEMO_ONLY=false`, `NODE_ENV=production`. Explicitly preserve accepted `KAON_BASE_URL`, `KAON_MAIN_MODEL`, `KAON_UPDATER_MODEL`, `KAON_TIMEOUT_MS`, `SCENE_LOCATOR`, and `DB_POOL_MAX`. The image supplies `HARNESS_MODULE_PATH` and `HARNESS_ROOT`. `SCENE_LOCATOR` is a distinct existing opt-in; do not accidentally enable it by copying `.env.example`.

The trusted proxy overwrites `X-Agentic-Gateway-Secret`, `X-Agentic-User-Id` and `X-Agentic-Roles`. Consumer roles must not acquire `admin`. Admin requires independent authenticated admin access; no public `/admin` forwarding. Existing signed guest ownership may be reused only with its own secret and stable secure cookie; never map every guest to a shared account.

Use a separate migration job with `MIGRATION_DATABASE_URL` and `DATABASE_URL`: `npm run db:migrate`, then `npm run db:seed-prompts` for first initialization. Seeding preserves published versions. Do not run `db:publish-world-prompts` as a routine startup action. No account, conversation or legacy database import is implicit in this image. Do not mount migration credentials into normal application containers.

## Release checks

The image build checks types, both builds, consumer artifact boundaries, auth/API/SSE privacy tests and bounded Harness regression tests. Final gateway acceptance must still verify forged identity headers, distinct guest ownership, absent consumer management APIs, admin HTML and assets requiring admin identity, `/verification` and source maps unavailable, successful streaming/persistence, and retained published six-policy configuration. A successful readiness check is not full chat/background acceptance.

Preserve the prior image digest and database backup before schema changes. Promote the exact accepted digest; image rollback does not revert database migrations or data.
