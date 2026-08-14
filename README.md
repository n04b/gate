# Gate

A small self-hosted HTTP gateway for a homelab. Gate sits behind a Cloudflare
Tunnel, decides which local service a request belongs to, and reverse-proxies it
there.

The target is resolved from a JWT `target` claim or from the `X-Target` header
(JWT wins). Anything that cannot be routed goes to a single `fallback` service.

Full behaviour is specified in [docs/SPEC.md](docs/SPEC.md).

```text
Internet → Cloudflare → cloudflared → Gate → n8n | Grafana | Node-RED | fallback
```

## Quick start

```bash
cp .env.example .env      # fill in TUNNEL_TOKEN
docker compose up -d --build
```

The first start bootstraps itself: if `config/gate.yaml` is missing Gate writes
a minimal one there (the mount is writable for exactly this reason), and if the
JWT keys named in it do not exist it generates an RS256 pair into the
`gate-data` volume. Nothing existing is ever overwritten, so restarts and
upgrades leave a live deployment alone. Edit `config/gate.yaml` — see
[config/gate.example.yaml](config/gate.example.yaml) for a worked example — and
restart to add your services.

Bootstrap is driven by `GATE_BOOTSTRAP`, which the image sets to `true`. Set it
to `false` to require a config and keys that you provision yourself.

Mounted directories keep their host ownership — and Docker creates a missing
bind-mount source as `root:root` — so ownership, not the image, decides what the
container may write. Gate handles that in two places:

* The entrypoint starts as root, chowns `/data` and `/app/config` to
  `PUID:PGID` (`1000:1000` by default, taken from `UID`/`GID` in `.env`) and
  then execs Gate as that user. The server itself never runs as root; set
  `user:` in compose to skip the chown entirely and stay unprivileged
  throughout.
* If the config directory still cannot be written — a `:ro` mount, for
  instance — Gate does not crash-loop: it writes the default to
  `/data/gate.yaml`, says so in the log, and keeps using it.

To move a fallback config back to the host, make the directory writable for that
uid (`chown -R 1000:1000 config`) and copy the file over:

```bash
docker cp gate:/data/gate.yaml ./config/gate.yaml
```

A config at the mounted path always wins over the fallback once it exists.

`docker-compose.yml` expects `TUNNEL_TOKEN` in `.env` (see `.env.example`), and
points the tunnel's public hostname at `http://gate:8080`. Gate publishes no
host port — it is reachable only over the internal Docker networks.

To manage the key pair on the host instead, create it before the first start and
point the config at the mount:

```bash
sh scripts/generate-keys.sh ./keys   # then uncomment the ./keys mount in
                                     # docker-compose.yml and set jwt.public_key
                                     # / jwt.private_key to /app/keys/…
```

Issue a token:

```bash
docker exec gate gate token create --subject github --target n8n --expires 1h
```

## Configuration

`config/gate.yaml` is mounted at `/app/config/gate.yaml`. Every field below is
optional except `jwt.public_key`, `jwt.private_key`, `services` and `routes`.

```yaml
server:
  host: 0.0.0.0
  port: 8080
  max_body_size: 1MB      # 413 above this
  upstream_timeout: 30s   # 504 above this
  trust_proxy: true       # honour X-Forwarded-* from cloudflared

logging:
  level: info

jwt:
  algorithm: RS256                      # default; symmetric algorithms are rejected
  public_key: /data/keys/jwt_public.pem  # generated on first start if missing
  private_key: /data/keys/jwt_private.pem
  issuer: homelab-gateway               # default
  audience: [homelab]                   # default
  clock_tolerance: 5s

mapping:
  enabled: true

token_log:
  path: /data/tokens.jsonl
  issued_by: homelab                   # default for `--issued-by`

services:
  n8n:
    url: http://n8n:5678
  grafana-main:
    url: http://grafana:3000
  fallback:
    url: http://fallback:8080

routes:
  - target: grafana
    service: grafana-main   # defaults to the target name

  - target: n8n             # auth defaults to true
    mapping:
      path:
        strip_prefix: /n8n/

  - target: node-red
    auth: false

  - fallback:
      service: fallback     # exactly one, never authenticated, never mapped
```

Configuration is validated before the server starts; any problem is reported and
Gate exits without listening. Unknown fields are errors, not warnings.

## Routing

| Request | Result |
| --- | --- |
| valid JWT with `target` | that target — `X-Target` is ignored |
| valid JWT without `target` | `400 {"error":"jwt_target_missing"}` |
| present but invalid JWT | `401 {"error":"jwt_invalid"}` |
| no JWT, `X-Target` present | that target (case-insensitive, last value wins) |
| no JWT, no `X-Target` | fallback |
| target with no matching route | fallback |
| matched route with `auth: true`, no JWT | `401 {"error":"unauthorized"}` |

Once a normal route is selected the request is never re-routed to the fallback:
an authentication failure is an error, not a reroute.

`X-Target` and `Authorization` are consumed by Gate and are not forwarded
upstream. Method, path, query string, body and application headers are proxied
unchanged; `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and
`X-Request-Id` are added.

## Token CLI

```bash
gate token create --subject <sub> --target <target> (--expires <duration> | --no-expiry)
                  [--issued-by <who>] [--note <text>] [--config <path>]
```

A lifetime must always be stated explicitly: `--expires 15m|1h|24h` or
`--no-expiry`. Providing neither, or both, is an error. The JWT goes to stdout;
its metadata — never the token — is appended as one JSON line to
`/data/tokens.jsonl` in the `gate-data` volume:

```json
{"jti":"a1b2c3","sub":"github","target":"n8n","iat":1786500000,"exp":1786503600,"issued_by":"misha@laptop","note":"github webhook automation"}
```

## Operations

* `GET /health` → `{"status":"ok"}`. No target, no JWT, never proxied. The
  Docker `HEALTHCHECK` uses it (it assumes the default port `8080`).
* One structured log line per request: `request_id`, `target`, `service`,
  `method`, `path`, `status`, `duration_ms`. JWTs, `Authorization`, credentials
  and request bodies are never logged.
* The private key is never baked into the image. It is either generated at
  runtime into the `gate-data` volume or bind-mounted from the host — back up
  the volume, or the issued tokens stop verifying.
* Gate runs as `PUID:PGID` (non-root, `1000:1000` by default) and keeps no
  database; the only persistent state it writes is the token log and, on first
  start, the config and key pair. `docker exec gate gate …` runs the CLI as the
  owner of `/data`, so the token log keeps a single owner.

## Development

```bash
npm test          # vitest: config, JWT, routing, mapping, proxy, CLI
npm run typecheck
npm run build
```

Environment variables: `GATE_CONFIG` overrides the config path (default
`/app/config/gate.yaml`), `GATE_BOOTSTRAP` enables first-start generation (off
outside Docker, so a local run never writes files behind your back), and
`GATE_ISSUED_BY` provides the default `issued_by` for the CLI. Relative paths
inside a config file resolve against that file's own directory.

Running outside Docker needs a config with local paths — point `jwt.public_key`
/ `jwt.private_key` at `../keys/…` and `token_log.path` somewhere writable:

```bash
cp config/gate.example.yaml config/gate.dev.yaml   # edit the paths, then:
GATE_CONFIG=config/gate.dev.yaml npm run dev
```
