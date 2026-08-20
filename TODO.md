# TODO

## Features and improvements

- [x] **Make the fallback route optional**

      Done. Config load now allows zero fallbacks (still rejects two or more),
      and `GateConfig.fallback` / `RouteTable.fallback` are `FallbackRoute |
      undefined`. When no fallback is configured, `gatewayHandler` rejects an
      unroutable request with two distinct new `GateErrorCode`s: `no_target`
      (`400`) when no target could be resolved at all, and `no_route` (`404`)
      when a target resolved but matched no route. SPEC §1/§7/§9/§14/§22/§58/§64
      updated accordingly.

- [ ] **Config changes must take effect without a full restart**

      Verified: they currently do not. There is no watcher, no `SIGHUP` handler
      and no reload path anywhere in `src/` — the config is read once at
      `src/index.ts:51` and the route table is built once at
      `src/server.ts:45`, both captured in closures for the process lifetime.
      Editing `config/gate.yaml` does nothing until the container is restarted,
      which also drops in-flight connections.

      Natural split when implementing:

      - *Reloadable* — routes, services, mapping, `logging.level`,
        `max_body_size`, `upstream_timeout`, `trust_proxy`. The handler already
        reads these from a captured `config`; swapping a single config
        reference atomically covers most of it.
      - *Needs rebuilding on reload* — the JWT verifier (`loadPublicKey` runs
        once at startup, so rotated keys are not picked up either) and the
        undici `Agent` if timeouts changed.
      - *Requires a restart regardless* — `server.host` / `server.port`, since
        the listener is already bound.

      Reload must be atomic and fail-closed: parse and validate the new config
      first, keep serving the old one if it is invalid, and log the rejection.
      A bad edit must never take the gateway down. Trigger via `SIGHUP` plus
      optional `fs.watch` on the config path.

- [x] **Routing to external servers (Cloudflare Workers)**

      Done for Cloudflare; see SPEC §65/§66.

      - The TLS path is now covered end to end, against a real HTTPS upstream
        with a per-run self-signed CA (`test/external.test.ts`), rather than
        assumed to work.
      - **Outbound authentication** is a Cloudflare Access service token per
        service: `access.client_id` plus `client_secret_env` or
        `client_secret_file`, presented as `CF-Access-Client-Id` /
        `CF-Access-Client-Secret`. The secret is never expressible inline —
        `gate.yaml` is bind-mounted and edited by hand — is read once at
        startup (missing/empty ⇒ Gate refuses to start), and never enters
        `GateConfig`, so it cannot reach the startup log. `access` on an
        `http://` URL is rejected.
      - **Header hygiene:** every inbound `cf-access-*` header is dropped, so a
        client can neither pick the credential Gate presents nor forge the
        `cf-access-jwt-assertion` identity an origin behind Access trusts —
        same class as [#1](https://github.com/n04b/gate/issues/1).
      - **Egress:** `services.<name>.timeout` overrides
        `server.upstream_timeout` per service and covers connection setup
        (one undici `Agent` per distinct timeout), since DNS/TCP/TLS to an
        internet origin is where the extra latency lives.

      Deliberately not done: **per-request dynamic targets**. Services stay a
      fixed allowlist (SPEC §18/§19) — a client still cannot supply a URL.
      Anything dynamic needs its own bounded mechanism; see *Rule-based target
      assignment on the fallback path*.

      Not done: **AWS Lambda**. Function URLs need SigV4 request signing, which
      is a different mechanism from a static header pair — the credential is
      derived per request from the method, path, headers and a hash of the
      body. That last part conflicts with Gate never buffering a body, so it
      needs its own design (streaming SigV4, or `UNSIGNED-PAYLOAD`, which not
      every Lambda URL auth mode accepts).

- [ ] **Rule-based target assignment on the fallback path**

      Idea: fallback receives the request, evaluates it against a rule list,
      assigns a `target`, and sends it round a second time, tagging the request
      with a header naming the rule that fired.

      Design questions to settle before building:

      - **Body replay is the blocking problem.** `gatewayHandler` streams
        `request.raw` straight upstream through `limitBodyStream`
        (`src/server.ts:187`) and nothing is buffered — that is a deliberate
        memory guarantee. A stream can only be consumed once, so a genuine
        second pass would need the body buffered up to `max_body_size`, which
        gives that guarantee away.
      - **Consider the subrequest shape instead.** Asking a decision service
        "what target for this request?" with headers only, then routing on the
        answer, gets the same outcome with no re-entrancy and no body replay.
        This is the established pattern — Traefik `forwardAuth`, nginx
        `auth_request`, Envoy `ext_authz` — and worth evaluating before the
        loop design, since it sidesteps the next two points entirely.
      - **Loop termination.** Second pass with an unmatched target lands on
        fallback again. Needs a hop counter with a hard cap and a defined
        terminal error, not just a "rule fired" marker.
      - **The rule marker header must be gate-only.** If a client can send it,
        it can claim a rule already fired and skip evaluation — same class as
        [#1](https://github.com/n04b/gate/issues/1). Add it to
        `GATE_ONLY_REQUEST_HEADERS`.
      - **Auth must not be short-circuited by the second pass.** Fallback is
        unauthenticated by definition (SPEC §22), so whatever assigns the
        target is reachable without a JWT. If the second pass carries any
        "already authorised" state, that is a full auth bypass to every
        `auth: true` route. The second pass must re-derive auth from the JWT
        exactly as the first does — a rule may choose the target, never the
        authentication outcome.
      - Interacts with SPEC §14/§15; the invariant is written for a single
        resolution pass and would need restating.

- [ ] **GUI for configuration and token generation**

      Pairs with the hot-reload item above — a GUI that edits config is
      pointless while changes need a container restart, so reload should land
      first.

      Constraints this has to respect:

      - **Token generation moves the private key onto a network surface.**
        Today `loadPrivateKey` is only ever called by the CLI over
        `docker exec` (`src/cli.ts:135`), so the signing key is not reachable
        from any listener. A GUI that issues tokens changes the threat model
        more than any other item in this file.
      - **Separate listener, not the proxy port.** Anything on `server.port` is
        reachable through the tunnel and sits in front of every route. The
        admin surface needs its own port, unpublished and bound to an admin
        network or localhost.
      - **Its own authentication, which cannot be the JWT it mints** — that is
        circular. Needs a distinct credential, plus CSRF protection on every
        mutating route.
      - **Config writing conflicts with a current invariant.** Bootstrap is
        strictly create-if-missing and the generated file says Gate never
        rewrites it (`src/config/template.ts:9`). A GUI that writes config
        needs that invariant restated, atomic writes, validation before commit,
        and ideally a backup of the previous version.
      - **Token log identity.** `issued_by` currently defaults to `user@host`
        from the CLI (`src/cli.ts:151`); the GUI needs an equivalent tied to
        the logged-in admin, not a generic "gui" string.
      - Show the minted token exactly once, matching the CLI's stdout
        behaviour, and keep it out of logs and browser history.

- [ ] **Implement the jti revocation denylist** (remainder of [#4](https://github.com/n04b/gate/issues/4))

      `require_expiry` now stops expiry-less tokens by default, so every token
      dies on its own — but a leaked token still cannot be killed early. The
      `RevocationChecker` interface and `noRevocationChecker` default are the
      seam to fill; `appendTokenLog` already records every `jti`. Needs storage,
      a `gate token revoke` command, and a reload path so a revocation takes
      effect without a restart (see the config reload item above).

- [ ] **Dashboard for requests that hit the fallback route**

      Surface every request that resolved to fallback — i.e. no target, an
      unknown target, or no JWT/X-Target at all. These are the requests Gate
      could not route to a real service, and today they are only visible by
      grepping logs.

      The data already exists: `gatewayHandler` records `route: 'fallback'`
      plus `target`, `target_source`, `method`, `path`, `status` and the
      client/peer IPs in the per-request log line (`src/server.ts:89`). A
      dashboard is a consumer of that stream, not new instrumentation.

      Design questions:

      - **Source of truth.** The request log is currently ephemeral stdout
        (pino). A dashboard needs it queryable — either ship logs to something
        external (Loki/Grafana, which the compose stack is already shaped for),
        or add a small append-only fallback-request log next to the token log.
        Prefer the external route: Gate should stay a gateway, not grow a
        datastore.
      - **What it answers.** Top unresolved targets (candidates for a missing
        route or a typo), fallback volume over time, and source IPs — useful
        both operationally and as a probe/scan signal.
      - **Security.** Same boundary as the config/token GUI item above: this is
        an admin surface, so it belongs on a separate unpublished port with its
        own auth, never on the proxy port. Log fields may contain
        attacker-controlled paths/hosts — render them escaped, never as HTML.
      - **Privacy.** Fallback requests can carry arbitrary client paths and
        headers; decide a retention window rather than keeping them forever.

      Pairs naturally with the identity-logging already added for
      [#5](https://github.com/n04b/gate/issues/5) — `sub`/`jti` are absent on
      unauthenticated fallback hits, which is itself a signal worth showing.

      **Feeds the rule-builder below:** the natural action on a fallback row is
      "make a route for requests like this" — see *Build a routing filter from
      a captured request*.

- [ ] **Build a routing filter from a captured request**

      A tool that takes a concrete request — method, path, query, headers, and
      (when present) JWT claims — and helps an operator turn it into a routing
      rule: pick the fields to match on, choose exact / prefix / regex per
      field, assign a target, and preview which past requests the rule would
      have caught.

      Sits between two existing backlog items:

      - *Dashboard for requests that hit the fallback route* is the source —
        you spot an unrouted request there and click "make a rule from this".
      - *Rule-based target assignment on the fallback path* is the consumer —
        this tool authors the rules that feature evaluates. Their data shapes
        must agree, so design the rule schema once and share it.

      Design questions:

      - **Rule schema first.** One representation of "match these fields with
        these operators → assign this target", serialisable into config and
        replayable against logged requests. Everything else (UI, preview,
        the fallback evaluator) depends on it.
      - **Only match on trustworthy fields.** Headers are client-controlled;
        a rule keying on `X-Webauth-User` or similar spoofable identity headers
        would reintroduce [#1](https://github.com/n04b/gate/issues/1). Restrict
        matchable fields to method / path / query / host and *verified* JWT
        claims, and warn loudly on anything a client can forge.
      - **A rule only picks the target, never the auth outcome.** Same
        invariant as the rule-based fallback item: the second pass must still
        derive authentication from the JWT, so a filter can route a request but
        cannot grant it access to an `auth: true` route.
      - **Preview before commit.** Run the candidate rule against the captured
        fallback history and show matches / near-misses, so an operator sees
        the blast radius before writing it to config.
      - **Writes config, so it inherits the config-GUI constraints** — admin
        surface off the proxy port, atomic validated writes, and the hot-reload
        item so a new rule takes effect without a restart.

- [ ] **Build an end-to-end testing pipeline**

      The 118 vitest cases are in-process integration tests: they drive Fastify
      through `app.inject` against throwaway HTTP upstreams (`test/helpers.ts`),
      never a built image or a real listener. That leaves a gap nothing covers —
      the Docker build, the entrypoint (`PUID`/`PGID` chown, bootstrap key and
      config generation), the non-root runtime, `/health` over a real socket,
      and proxying across the `services` network as wired in `docker-compose.yml`.

      What an e2e pipeline should exercise, end to end against the actual image:

      - **Bootstrap on first start.** Empty `config`/`data` volumes → container
        writes `gate.yaml`, generates the key pair into the volume, comes up and
        answers `/health`. Second start must not overwrite either.
      - **Real proxying.** Stand up `gate` plus a stub upstream (traefik/whoami,
        already the compose fallback) on the `services` network; mint a token
        with the CLI over `docker exec` and confirm a JWT-routed request, an
        `X-Target` request, the fallback path, and — now that it is optional —
        the `no_target` / `no_route` responses when no fallback is configured.
      - **Security invariants over the wire.** The header-hygiene and
        `X-Forwarded-For` behaviour the raw-socket unit probes assert should be
        re-checked against a real listener, since the in-process harness can mask
        connection-level framing.

      Design questions to settle:

      - **Runner.** Either a `docker compose` fixture driven from vitest (spin
        up, poll `/health`, run assertions with `fetch`, tear down) or a shell
        script invoked from CI. Keep it separate from the fast unit run so
        `npm test` stays quick; a dedicated `test:e2e` script and compose file.
      - **CI.** There is no `.github/workflows` yet. The pipeline needs one that
        builds the image, runs the unit suite, then the e2e suite, and fails the
        build on any of them — the natural home for the "test suite is the
        acceptance harness" point in the Go-rewrite item below.
      - **Determinism.** Fixed image tag, pinned upstream stub, and generated
        (not committed) keys per run, so nothing leaks between runs or bakes a
        private key into the repo.

- [ ] **Rewrite in Go** 🙂

      Aspirational, but not unreasonable — Gate is a streaming reverse proxy,
      which is squarely Go's wheelhouse (`net/http` + `httputil.ReverseProxy`,
      single static binary, no node_modules in the runtime image).

      What makes this a realistic rewrite rather than a from-scratch guess:

      - **The spec is the asset, not the TypeScript.** `docs/SPEC.md` is
        language-agnostic and numbered, and the security fixes are written up in
        this file with the invariants spelled out ([#1](https://github.com/n04b/gate/issues/1)–[#7](https://github.com/n04b/gate/issues/7)).
        A Go port implements the spec; it doesn't reverse-engineer the JS.
      - **The test suite is the acceptance harness.** The 114 vitest cases —
        especially the raw-socket header/smuggling probes — encode the
        behaviour that must survive. Port them (Go `httptest`) first, then make
        them pass; that is the definition of done.

      Carry these over deliberately, since they are where a naive port regresses:

      - **Header hygiene.** The identity-header denylist and the
        peer-derived `X-Forwarded-For` ([#1](https://github.com/n04b/gate/issues/1)/[#3](https://github.com/n04b/gate/issues/3))
        must be reproduced — `httputil.ReverseProxy` will happily forward
        everything by default.
      - **Trust model.** Go has no built-in `trust_proxy`; the CIDR-pinned
        trust from [#2](https://github.com/n04b/gate/issues/2) has to be hand-rolled around
        `X-Forwarded-For` parsing.
      - **JWT.** Pin the algorithm from config and reject the token's own `alg`
        (the Go JWT libraries have a long history of `alg`-confusion footguns) —
        keep `require_expiry` on by default.
      - **Streaming + body limit.** Use `http.MaxBytesReader` for the cap, and
        make sure bodies stream rather than buffer, matching `bodyLimit.ts`.

      Net: probably fewer moving parts and a smaller image, at the cost of
      re-earning trust in code that is currently well-tested. Worth it only once
      the feature set settles — doing it mid-flight through the backlog above
      means porting a moving target.
