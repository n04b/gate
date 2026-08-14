# Gate — MVP Specification

## 1. Goal

Build a small self-hosted HTTP Gateway for a homelab environment using Node.js.

The project is called **Gate**.

Gate receives HTTP requests from the Internet through a Cloudflare Tunnel, determines the target local service using:

1. the `target` claim from a JWT;
2. the `X-Target` HTTP header.

JWT has priority over `X-Target`.

After resolving the target, Gate selects the corresponding route and proxies the original HTTP request to the configured local service.

If no target can be resolved, or if the resolved target does not have a configured route, the request is sent to the `fallback` service.

---

# 2. Architecture

```text
Internet
    │
    ▼
Cloudflare
    │
    │ Cloudflare Tunnel
    ▼
cloudflared
    │
    ▼
┌───────────────────────────────┐
│             Gate              │
│                               │
│  JWT validation               │
│  Target resolution            │
│  Route selection              │
│  Authentication               │
│  Path mapping                 │
│  Reverse proxy                │
│  Token issuing                │
│  Append-only token log        │
└──────────────┬────────────────┘
               │
       ┌───────┼──────────┬───────────┐
       ▼       ▼          ▼           ▼
      n8n     Grafana    Node-RED   fallback
```

Cloudflare Tunnel is not part of Gate.

Gate does not terminate external TLS.

Gate must not expose an HTTP port directly on the Docker host.

---

# 3. Technology Stack

* Node.js
* TypeScript
* Fastify
* HTTP reverse proxy
* JWT library with RS256 support
* YAML configuration
* Structured logging
* Docker
* Docker Compose

---

# 4. Configuration

The configuration should be intentionally simple.

Example:

```yaml
services:
  grafana-main:
    url: http://grafana:3000

  n8n:
    url: http://n8n:5678

  node-red:
    url: http://node-red:1880

  fallback:
    url: http://fallback:8080


routes:

  - target: grafana
    service: grafana-main

  - target: n8n

  - target: node-red
    auth: false

  - fallback:
      service: fallback
```

---

# 5. Services

`services` is a list of allowed upstream services.

Each service contains its physical URL:

```yaml
services:

  n8n:
    url: http://n8n:5678

  grafana-main:
    url: http://grafana:3000
```

A route may reference only a service defined under `services`.

Clients must never be able to provide an arbitrary upstream URL.

---

# 6. Route

A normal route has the following structure:

```yaml
- target: n8n
  service: n8n
  auth: true
```

### `target`

Required.

The logical target identifier used to select the route.

```yaml
target: n8n
```

### `service`

Optional.

Defines the physical service to which the request is proxied.

If `service` is omitted:

```text
service = target
```

Therefore:

```yaml
- target: n8n
```

is equivalent to:

```yaml
- target: n8n
  service: n8n
```

### `auth`

Optional.

Default:

```text
auth: true
```

Therefore:

```yaml
- target: n8n
```

is equivalent to:

```yaml
- target: n8n
  auth: true
```

---

# 7. Fallback

Fallback is a special route.

Example:

```yaml
- fallback:
    service: fallback
```

Fallback:

* has no `target`;
* has no `name`;
* requires `service`;
* always has authentication disabled;
* must not accept an `auth` property.

Invalid configuration:

```yaml
- fallback:
    service: fallback
    auth: true
```

Gate must reject this configuration.

Exactly one fallback must exist in the configuration.

---

# 8. No Route Name

A separate `name` field is not used.

`target` is the identifier of a normal route.

For example:

```yaml
- target: n8n
```

does not require:

```yaml
name: n8n
```

Normal routes with duplicate `target` values are invalid.

---

# 9. Target Resolution

Target resolution follows this order:

```text
HTTP request
     │
     ▼
Authorization header present?
     │
     ├── No ───────────────────► X-Target
     │                              │
     │                              ├── present → target = X-Target
     │                              │
     │                              └── absent → fallback
     │
     ▼
JWT validation
     │
     ├── invalid → 401
     │
     ▼
JWT contains target?
     │
     ├── No → 400
     │
     ▼
target = JWT.target
     │
     ▼
Route with target exists?
     │
     ├── No → fallback
     │
     ▼
Route selected
     │
     ▼
Authentication
     │
     ├── error → error
     │
     ▼
Mapping
     │
     ▼
Proxy
```

Rules:

1. If JWT is absent, use `X-Target`.
2. If JWT is present but invalid, return `401 Unauthorized`.
3. If JWT is valid but does not contain `target`, return `400 Bad Request`.
4. If a valid JWT contains `target`, use only the JWT target.
5. `X-Target` must not be used as a fallback when a valid JWT does not contain `target`.
6. If JWT is absent and `X-Target` is absent, use fallback.
7. If a target is resolved but no matching route exists, use fallback.
8. Once a normal route has been selected, fallback must never be used.

---

# 10. JWT Priority

JWT has priority over `X-Target`.

If the request contains:

```http
X-Target: grafana
Authorization: Bearer <JWT>
```

and the JWT contains:

```json
{
  "target": "n8n"
}
```

the selected target is:

```text
n8n
```

`X-Target` is ignored for route selection.

---

# 11. Missing JWT

If `Authorization` is absent, JWT processing is skipped.

Gate proceeds to `X-Target`.

Example:

```http
POST /webhook/github
X-Target: n8n
```

results in:

```text
target = n8n
```

The absence of a JWT by itself does not cause fallback.

---

# 12. JWT Without Target

If a JWT is present and successfully validated, but does not contain the `target` claim:

```json
{
  "sub": "github"
}
```

Gate must return:

```http
400 Bad Request
```

Example response:

```json
{
  "error": "jwt_target_missing"
}
```

`X-Target` must not be used in this case.

The request must not be sent to fallback.

---

# 13. Invalid JWT

If a JWT is present but fails validation:

```http
Authorization: Bearer <invalid JWT>
```

Gate must return:

```http
401 Unauthorized
```

`X-Target` must not be used in this case.

Fallback must not be used either.

A present but invalid JWT is an explicit authentication error and must not be treated as if no JWT were provided.

---

# 14. Fallback

Fallback is used only before a normal route has been selected.

Fallback is selected in the following cases.

### No JWT and no X-Target

```text
JWT absent
AND
X-Target absent
```

Result:

```text
fallback
```

### Unknown target

For example:

```http
X-Target: unknown
```

when no `unknown` route exists.

Result:

```text
fallback
```

### After route selection

Once a normal route has been selected, fallback must never be used.

---

# 15. Route Selection Invariant

Once a target has been resolved and a matching normal route has been found, the request can never be sent to fallback.

Processing of the selected route can result in:

* successful proxying;
* `400 Bad Request`;
* `401 Unauthorized`;
* another error related to the selected route.

It must not result in fallback.

For example:

```text
target = n8n
     │
     ▼
n8n route found
     │
     ▼
auth = true
     │
     ├── JWT missing  → 401
     ├── JWT invalid → 401
     └── JWT valid   → proxy
```

This is invalid:

```text
target = n8n
     │
     ▼
n8n route found
     │
     ▼
authentication error
     │
     ▼
fallback
```

---

# 16. X-Target

Routing uses the fixed HTTP header:

```http
X-Target: n8n
```

The header name is not configurable.

Target comparison is case-insensitive.

The following values are equivalent:

```text
n8n
N8N
N8n
```

---

# 17. Multiple X-Target Headers

If a request contains multiple `X-Target` headers, the last value must be used.

Example:

```http
X-Target: grafana
X-Target: n8n
```

Result:

```text
target = n8n
```

This behavior must be explicitly implemented and covered by tests.

---

# 18. Target Is Not a URL

A target is always a logical identifier:

```text
n8n
grafana
node-red
```

The following are not valid targets:

```text
http://192.168.1.20:5678
https://example.com
```

For example:

```http
X-Target: http://192.168.1.20:5678
```

must not allow the client to access that URL.

---

# 19. SSRF Protection

Gate must use only URLs defined in `services`.

Example:

```yaml
services:
  n8n:
    url: http://n8n:5678
```

Route:

```yaml
- target: n8n
```

resolves to:

```text
n8n
 ↓
services.n8n
 ↓
http://n8n:5678
```

The client must not be able to control the final upstream URL.

---

# 20. Route Selection

After resolving the target, Gate searches for:

```text
routes[].target
```

Example:

```yaml
routes:

  - target: grafana
    service: grafana-main

  - target: n8n
```

For:

```text
target = grafana
```

the selected route is:

```yaml
target: grafana
service: grafana-main
```

For:

```text
target = n8n
```

the selected route is:

```yaml
target: n8n
service: n8n
```

---

# 21. Authentication

Authentication is configured independently for each normal route.

Default:

```text
auth: true
```

Example:

```yaml
- target: n8n
```

means:

```yaml
- target: n8n
  auth: true
```

A public route can explicitly disable authentication:

```yaml
- target: node-red
  auth: false
```

---

# 22. Authentication for Fallback

Fallback always operates without authentication.

```yaml
- fallback:
    service: fallback
```

`auth` is not supported for fallback.

Fallback never requires a JWT.

---

# 23. Authentication and Routes

If the selected route has:

```yaml
auth: true
```

the request must pass authentication.

If JWT is missing:

```http
401 Unauthorized
```

If JWT is invalid:

```http
401 Unauthorized
```

If JWT is valid:

```text
authentication successful
```

If the selected route has:

```yaml
auth: false
```

JWT is not required for authentication.

However, if a JWT is present, it is still processed according to the general target-resolution rules.

---

# 24. Authorization in MVP

No separate authorization mechanism is implemented in the MVP.

Any valid JWT that:

* has a valid signature;
* matches the configured issuer;
* matches the configured audience;
* has not expired;
* contains a valid `target`;

may use the corresponding target route if that route requires authentication.

For example:

```json
{
  "sub": "anything",
  "target": "n8n"
}
```

may access:

```yaml
- target: n8n
```

when `auth: true`.

This is an intentional MVP simplification.

`sub` is not used for authorization in the MVP.

Future authorization mechanisms may include:

* allowed subjects;
* scopes;
* permissions;
* ACLs;
* target-specific authorization.

---

# 25. JWT Configuration

Example:

```yaml
jwt:
  algorithm: RS256

  public_key: /app/keys/jwt_public.pem
  private_key: /app/keys/jwt_private.pem

  issuer: homelab-gateway

  audience:
    - homelab
```

`issuer` and `audience` are optional.

---

# 26. JWT Defaults

If `issuer` is not specified:

```text
homelab-gateway
```

If `audience` is not specified:

```text
homelab
```

If `algorithm` is not specified:

```text
RS256
```

Minimal JWT configuration:

```yaml
jwt:
  public_key: /app/keys/jwt_public.pem
  private_key: /app/keys/jwt_private.pem
```

---

# 27. JWT Algorithm

The MVP uses:

```text
RS256
```

Gate must not automatically accept the algorithm declared by the JWT.

The expected algorithm must be explicitly configured or default to `RS256`.

Gate must reject the JWT if:

```text
token.alg != configured algorithm
```

The following are prohibited:

* `alg: none`;
* automatic algorithm detection from the token;
* algorithm confusion;
* RS256 → HS256 substitution;
* using the RSA public key as an HMAC secret.

---

# 28. JWT Validation

Gate must validate:

* JWT presence when required;
* JWT structure;
* signature;
* algorithm;
* `exp`, if present;
* `nbf`, if present;
* `iss`;
* `aud`.

Configured values:

```text
issuer   = configured value or homelab-gateway
audience = configured value or homelab
algorithm = configured value or RS256
```

---

# 29. JWT Keys

Gate uses an asymmetric key pair:

```text
private key
public key
```

The private key is used to issue JWTs.

The public key is used to validate JWTs.

The private key must not be included in the Docker image.

---

# 30. JWT Issuing

Gate must provide a CLI for issuing JWTs.

The CLI is executed inside the running container using `docker exec`.

Example:

```bash
docker exec gate \
  gate token create \
  --subject github \
  --target n8n \
  --expires 1h
```

The private key is available to Gate inside the container.

---

# 31. JWT CLI

JWT creation uses:

```bash
gate token create
```

Required parameters:

```text
--subject
--target
```

A token lifetime must be specified explicitly using one of:

```text
--expires
--no-expiry
```

These options are mutually exclusive.

---

# 32. JWT Expiration Policy

JWTs are temporary by default.

Example:

```bash
gate token create \
  --subject github \
  --target n8n \
  --expires 1h
```

creates a JWT containing `exp`.

If neither:

```text
--expires
```

nor:

```text
--no-expiry
```

is provided, the CLI must fail.

Example:

```text
error: either --expires or --no-expiry is required
```

A non-expiring JWT must be created explicitly:

```bash
gate token create \
  --subject github \
  --target n8n \
  --no-expiry
```

In this case the JWT does not contain `exp`.

Using both:

```bash
--expires 1h --no-expiry
```

is an error.

---

# 33. JWT Claims

A JWT must contain:

```json
{
  "iss": "homelab-gateway",
  "aud": "homelab",
  "sub": "github",
  "target": "n8n",
  "iat": 1786500000,
  "jti": "a1b2c3"
}
```

When expiration is configured:

```json
{
  "iss": "homelab-gateway",
  "aud": "homelab",
  "sub": "github",
  "target": "n8n",
  "iat": 1786500000,
  "exp": 1786503600,
  "jti": "a1b2c3"
}
```

Required claims:

* `iss`;
* `aud`;
* `sub`;
* `target`;
* `iat`;
* `jti`.

`exp` is optional only for an explicitly created non-expiring token.

---

# 34. JWT Subject

`sub` identifies the subject for which the token was issued.

Examples:

```text
sub = github
sub = automation
sub = laptop
```

The MVP does not use `sub` for authorization.

It is retained for identification and future authorization features.

---

# 35. JWT Expiration

The CLI must support:

```bash
--expires 15m
--expires 1h
--expires 24h
```

When `--expires` is specified:

```text
exp = iat + duration
```

When `--no-expiry` is specified:

```text
exp is absent
```

---

# 36. Append-Only Token Log

Every successful JWT creation must append token metadata to an append-only log.

The log is stored in a Docker volume.

Format:

```text
JSON Lines
```

One line represents one issued token.

Example:

```json
{"jti":"a1b2c3","sub":"github","target":"n8n","iat":1786500000,"exp":1786503600,"issued_by":"misha@laptop","note":"github webhook automation"}
```

---

# 37. Token Log Contents

The log must never contain the actual JWT.

Do not write:

```text
eyJhbGciOiJSUzI1NiIs...
```

The log contains only token metadata.

Minimum fields:

```json
{
  "jti": "a1b2c3",
  "sub": "github",
  "target": "n8n",
  "iat": 1786500000,
  "issued_by": "misha@laptop"
}
```

If the JWT has an `exp` claim, `exp` must also be logged.

For a non-expiring JWT, `exp` is omitted.

`note` is optional.

---

# 38. `issued_by`

The CLI must support:

```bash
--issued-by misha@laptop
```

The value is written to the token log.

If `--issued-by` is not provided, a default may be taken from configuration or an environment variable.

---

# 39. `note`

The CLI must support an optional note:

```bash
--note "github webhook automation"
```

It is written to the append-only log:

```json
{
  "jti": "a1b2c3",
  "sub": "github",
  "target": "n8n",
  "iat": 1786500000,
  "exp": 1786503600,
  "issued_by": "misha@laptop",
  "note": "github webhook automation"
}
```

`note` must not be included in the JWT.

---

# 40. Token Log Volume

The token log must be stored in a dedicated Docker volume.

Example:

```yaml
volumes:
  gate-data:
```

and:

```yaml
services:
  gate:
    volumes:
      - gate-data:/data
```

Log file:

```text
/data/tokens.jsonl
```

The log must survive container recreation.

---

# 41. Append-Only Semantics

The token log uses append-only semantics.

When a new JWT is issued, a new JSON line is appended to the end of the file.

Existing records must not be modified.

Gate must not rewrite or delete existing records during normal `token create` operation.

---

# 42. Request Body Limit

Gate must enforce a maximum request body size.

Example:

```yaml
server:
  max_body_size: 1MB
```

When the limit is exceeded:

```http
413 Payload Too Large
```

---

# 43. Upstream Timeout

Gate must support a global upstream timeout.

Example:

```yaml
server:
  upstream_timeout: 30s
```

Future versions may allow overriding this value per service or route.

---

# 44. Request Proxying

After selecting a route, Gate proxies the original HTTP request to the configured service.

By default, the following are preserved:

* HTTP method;
* path;
* query string;
* request body;
* application headers.

Example:

```http
POST /webhook/github?source=github
Content-Type: application/json
X-Custom: test
X-Target: n8n
```

is proxied as:

```http
POST http://n8n:5678/webhook/github?source=github
Content-Type: application/json
X-Custom: test
```

with the original request body.

---

# 45. Mapping

Gate must support optional path mapping.

Global configuration:

```yaml
mapping:
  enabled: true
```

When:

```yaml
mapping:
  enabled: false
```

the path is passed to the upstream service unchanged.

---

# 46. Route Mapping

Mapping may be configured on a normal route.

Example:

```yaml
routes:

  - target: n8n
    mapping:
      path:
        strip_prefix: /n8n/
```

Request:

```text
/n8n/webhook/github
```

is proxied as:

```text
/webhook/github
```

---

# 47. Path Prefix Mapping

With:

```yaml
mapping:
  path:
    strip_prefix: /n8n/
```

the result is:

```text
/n8n/               → /
/n8n/test           → /test
/n8n/webhook/github → /webhook/github
/n8n/api/v1/test    → /api/v1/test
```

Everything after the prefix is preserved and passed to the upstream service.

---

# 48. Mapping Defaults

If a route does not define mapping:

```yaml
- target: n8n
```

the path is passed unchanged.

Mapping is applied only after a normal route has been selected.

---

# 49. Fallback Mapping

Mapping is never applied to fallback.

Fallback always receives the original path unchanged.

For example:

```text
POST /unknown/path
```

sent to fallback must remain:

```text
POST /unknown/path
```

even when:

```yaml
mapping:
  enabled: true
```

---

# 50. Response Proxying

Gate is a reverse proxy.

It routes the request to the upstream service and proxies the upstream response back to the client.

```text
Client
  │
  │ request
  ▼
Gate
  │
  │ routed request
  ▼
Service
  │
  │ response
  ▼
Gate
  │
  │ proxied response
  ▼
Client
```

For the MVP:

* response body is not modified;
* HTTP status is preserved;
* valid response headers are proxied back to the client.

---

# 51. Request Headers

`X-Target` is used by Gate for routing and must not be forwarded upstream by default.

`Authorization` must not be forwarded upstream by default.

Other application headers should be proxied.

Gate must correctly handle proxy-specific headers, including:

* `Host`;
* `Connection`;
* `Content-Length`;
* `Transfer-Encoding`;
* `X-Forwarded-*`.

---

# 52. Logging

Every HTTP request receives a `request_id`.

The request log should contain:

* request ID;
* target;
* service;
* HTTP method;
* path;
* status;
* duration.

The following must not be logged:

* JWT;
* `Authorization`;
* private keys;
* credentials;
* request body.

Example:

```text
request_id=abc123
target=n8n
service=n8n
method=POST
path=/n8n/webhook/github
status=200
duration=124ms
```

---

# 53. Healthcheck

Provide:

```http
GET /health
```

Response:

```json
{
  "status": "ok"
}
```

`/health`:

* does not require a target;
* does not require JWT;
* does not use fallback;
* is not proxied upstream.

A Docker `HEALTHCHECK` must also be provided.

---

# 54. Stateless

Gate must not use a database in the MVP.

Do not use:

* PostgreSQL;
* Redis;
* queues;
* persistent request storage.

Configuration, JWT keys, and the token log are external persistent data.

---

# 55. Docker

Example:

```yaml
services:

  gate:
    image: homelab-gate:latest
    restart: unless-stopped

    volumes:
      - ./config:/app/config:ro
      - ./keys:/app/keys:ro
      - gate-data:/data

    networks:
      - gateway
      - services


volumes:
  gate-data:


networks:
  gateway:
  services:
```

Gate must not publish its HTTP port on the host.

Do not use:

```yaml
ports:
  - "8080:8080"
```

Gate must be reachable only through Docker networks.

Cloudflared connects to Gate through the internal Docker network.

---

# 56. Docker Networks

Recommended topology:

```text
gateway-network
    │
    ├── cloudflared
    └── gate

services-network
    │
    ├── gate
    ├── n8n
    ├── grafana
    ├── node-red
    └── fallback
```

Gate is connected only to the networks it needs.

Cloudflared should not have direct access to all internal services.

---

# 57. Cloudflare Tunnel

Cloudflare Tunnel routes the public hostname to Gate:

```text
https://gateway.example.com
        │
        ▼
Cloudflare Tunnel
        │
        ▼
gate:8080
```

Inside Docker:

```text
cloudflared
     │
     ▼
http://gate:8080
```

Gate does not require a public IP or a host-published port.

---

# 58. Configuration Validation

At startup, Gate must validate:

* YAML syntax;
* presence of `services`;
* presence of `routes`;
* exactly one fallback;
* unique normal route `target` values;
* presence of `service` on fallback;
* existence of every referenced service;
* validity of service URLs;
* validity of JWT configuration;
* presence of JWT keys;
* validity of mapping configuration;
* absence of `auth` on fallback;
* absence of unknown route fields.

If configuration validation fails, Gate must not start.

---

# 59. Out of Scope for MVP

Do not implement:

* routing by HTTP method;
* routing by path;
* routing by query parameters;
* routing by arbitrary headers;
* routing by request body;
* complex `AND` / `OR` match rules;
* route priority;
* API key authentication;
* OAuth;
* external Identity Providers;
* JWT revocation;
* rate limiting;
* Web UI;
* request history;
* request/response transformation;
* dynamic target from path;
* dynamic target from request body;
* load balancing;
* WebSocket.

---

# 60. Future Features

## WebSocket

Add WebSocket proxying.

Gate should be able to route WebSocket connections similarly to HTTP:

```text
Client
  │
  │ WebSocket
  ▼
Gate
  │
  ▼
Service
```

WebSocket support is not part of the MVP.

## JWT Revocation

Add the ability to revoke JWTs by `jti`.

For example:

```text
jti = a1b2c3
```

can be added to a revocation list.

After revocation, Gate must reject the JWT even if:

* its signature is valid;
* `exp` has not expired;
* issuer is valid;
* audience is valid.

The append-only token log should eventually provide the history of issued tokens, but it is not itself a revocation list.

---

# 61. Future Target Resolver Architecture

Current Target Resolver:

```text
Target Resolver
    │
    ├── JWT.target
    └── X-Target
```

Future:

```text
Target Resolver
    │
    ├── JWT claim
    ├── X-Target
    ├── API key
    ├── path
    ├── query
    ├── body
    └── static target
```

---

# 62. Future Route Matcher

Currently, routes are selected only by `target`.

Future versions may support:

```text
Route Matcher
    │
    ├── target
    ├── method
    ├── path
    ├── headers
    ├── query
    ├── JWT claims
    └── body
```

Potential matching operators:

* AND;
* OR;
* priority;
* exact;
* prefix;
* glob;
* regex.

These features are not part of the MVP.

---

# 63. Future Route Model

Current normal route:

```text
Route
├── target
├── service
├── auth
└── mapping
```

Fallback:

```text
Fallback
└── service
```

Future:

```text
Route
├── target
├── match
├── auth
├── authorization
├── service
├── mapping
├── request transformation
└── response transformation
```

The current configuration model should not prevent these future capabilities from being added.

---

# 64. MVP Acceptance Criteria

The MVP is considered complete when:

1. Gate is implemented using Node.js and TypeScript.
2. Gate runs in Docker.
3. Gate is accessible through Cloudflare Tunnel.
4. Gate does not publish an HTTP port on the host.
5. Target can be resolved from JWT or `X-Target`.
6. JWT has priority over `X-Target`.
7. `X-Target` is used when JWT is absent.
8. A valid JWT without `target` returns `400 Bad Request`.
9. An invalid JWT returns `401 Unauthorized`.
10. An invalid JWT never falls back.
11. If both JWT and `X-Target` are absent, fallback is used.
12. If a target is resolved but no matching route exists, fallback is used.
13. `X-Target` matching is case-insensitive.
14. When multiple `X-Target` headers are present, the last value is used.
15. Authentication is configurable independently for each normal route.
16. Authentication defaults to enabled.
17. Fallback always operates without authentication.
18. Once a normal route has been selected, fallback is never used.
19. Normal routes do not have a `name` field.
20. Normal route `target` values are unique.
21. `service` defaults to `target`.
22. Fallback requires `service`.
23. Exactly one fallback exists in the configuration.
24. Target cannot be an arbitrary URL.
25. Upstream URLs can only come from configured `services`.
26. JWT uses RS256 by default.
27. JWT algorithm is never autodetected from the token.
28. `alg: none` is rejected.
29. Algorithm confusion is prevented.
30. `issuer` defaults to `homelab-gateway`.
31. `audience` defaults to `homelab`.
32. JWTs with `exp` are validated for expiration.
33. JWTs without `exp` can only be created explicitly using `--no-expiry`.
34. The CLI fails if neither `--expires` nor `--no-expiry` is provided.
35. `--expires` and `--no-expiry` are mutually exclusive.
36. JWTs can be issued through `docker exec`.
37. Every JWT contains a `jti`.
38. Every successfully issued JWT is recorded in an append-only JSON Lines log.
39. The actual JWT is never written to the token log.
40. The token log is stored in a Docker volume.
41. The token log contains at least `jti`, `sub`, `target`, `iat`, and `issued_by`.
42. `exp` is logged only for tokens that have expiration.
43. An optional `note` is supported.
44. HTTP method is proxied unchanged.
45. Query string is proxied unchanged.
46. Request body is proxied unchanged.
47. Application headers are proxied.
48. `X-Target` is not forwarded upstream by default.
49. `Authorization` is not forwarded upstream by default.
50. Mapping can be enabled or disabled.
51. Path prefix stripping is supported when mapping is enabled.
52. The remaining path is forwarded upstream.
53. Mapping is never applied to fallback.
54. Fallback always receives the original path.
55. Upstream responses are proxied back to the client.
56. Request IDs and structured request logging are implemented.
57. JWTs and credentials are not written to HTTP request logs.
58. A request body size limit is implemented.
59. An upstream timeout is implemented.
60. `/health` is available.
61. A Docker healthcheck is provided.
62. Gate runs as a non-root user.
63. Configuration is validated before startup.
64. The internal architecture allows a future rule engine.
65. The internal architecture allows future JWT revocation by `jti`.
66. The internal architecture allows future WebSocket proxying.

```
```
