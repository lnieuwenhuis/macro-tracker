# CLIProxyAPI service (food-photo AI gateway)

Runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) as its own
Railway service so the backend can use a ChatGPT/Codex subscription
(GPT-5.6 Luna) for food-photo macro estimates instead of the free OpenRouter
models. The backend talks to it over Railway's private network as a normal
OpenAI-compatible chat-completions endpoint.

Heads-up before relying on it: this rides the unofficial ChatGPT Codex
backend. OpenAI has publicly tolerated personal use of your own
subscription through third-party clients, but the endpoint can change or
break without notice (Luna specifically has broken for third-party clients
before). If it breaks, unset `AI_GATEWAY_URL` on the backend service and
food photos fall back to the OpenRouter path unchanged. Keep this to your
own subscription; don't pool accounts or serve strangers' traffic with it.

## Railway setup

1. **Create the service.** In the Railway project: New Service → GitHub Repo
   → this repository (do not repurpose the web or backend service), and set
   the service's *Root Directory* to `infra/cliproxyapi`. Railway detects
   the Dockerfile automatically.
2. **Point config-as-code at this directory.** Settings → Config-as-code →
   file path `infra/cliproxyapi/railway.toml`. Skipping this applies the
   repo-root `railway.toml` (the web service's default), whose `pnpm`
   start command overrides the container entrypoint and fails the deploy
   with "The executable `pnpm` could not be found".
3. **Attach a volume** mounted at `/data`. Codex OAuth credentials live
   there (`/data/auths`) and survive redeploys. Without it you re-login
   after every deploy.
4. **Set service variables:**
   - `AI_GATEWAY_API_KEY` — long random string; the backend authenticates
     to the proxy with it. Generate with `openssl rand -hex 32`. Use only
     letters/digits/dashes (it is templated into a quoted YAML string).
   - `CLIPROXY_MANAGEMENT_KEY` — second long random string; password for
     the management panel. Same character advice.
   - `PORT=8317` — pins the listen port so the private-network URL below
     is predictable (Railway may otherwise inject its own `PORT`, which
     the entrypoint honors).
5. **Expose a public domain** (Settings → Networking → Generate Domain).
   Needed once for the login panel; you can remove the public domain after
   logging in if you prefer, the backend uses the private network.

## Log in with the Codex subscription

1. Open `https://<public-domain>/management.html` and enter
   `CLIPROXY_MANAGEMENT_KEY` when prompted.
2. Auth Files → Add → **Codex OAuth**. The panel shows an
   `auth.openai.com` URL — open it, sign in with the ChatGPT account that
   has the Codex subscription, and approve.
3. The redirect lands on `http://localhost:1455/...`, which errors in the
   browser (nothing listens there). Copy that full localhost URL from the
   address bar and paste it back into the panel's callback field. The
   panel exchanges it and writes the credential to `/data/auths`.
4. Verify: `curl -H "Authorization: Bearer $AI_GATEWAY_API_KEY"
   https://<public-domain>/v1/models` should list `gpt-5.6-*` models.

Fallback if the panel flow fails: run the proxy locally with Docker
(`docker run --rm -it -p 1455:1455 -v ${PWD}/auths:/root/.cli-proxy-api
eceasy/cli-proxy-api:v7.2.132 /CLIProxyAPI/CLIProxyAPI --codex-login`),
complete the browser login it opens, then upload the JSON file it writes
into `auths/` through the management panel's Auth Files upload.

## Point the app at it

On the **backend** Railway service set:

```
AI_GATEWAY_URL=http://<cliproxyapi-service-name>.railway.internal:8317/v1/chat/completions
AI_GATEWAY_API_KEY=<same value as on the proxy service>
```

On the **web** Railway service set `AI_GATEWAY_URL` (and `AI_GATEWAY_MODELS`
if customized) so the admin AI-benchmark page reflects the gateway models;
it does not need the API key.

`AI_GATEWAY_MODELS` is optional and defaults to
`gpt-5.6-luna(low),gpt-5.6-luna(medium)` — low effort first (~2s to first
token), medium as the retry fallback. `OPENROUTER_MODEL_TIMEOUT_MS` still
bounds each model attempt (defaults to 20s in gateway mode, clamped to
3–30s).

The private network URL is plain `http`; that is expected — Railway's
private network is isolated and has no TLS. The backend refuses `http`
gateway URLs for any host other than loopback or `*.railway.internal`.

Note that food-photo requests now consume the Codex subscription's usage
allowance (shared with any Codex coding you do). At typical volumes —
hundreds of Luna messages per 5-hour window on a Plus plan — a personal
tracker won't dent it.
