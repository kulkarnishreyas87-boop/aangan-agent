# Aangan phone enquiry agent

Backend for Aangan Studio's phone enquiries. A caller rings; every enquiry is answered at once, qualified against the founder's own rubric, and the ones worth a designer's time arrive with everything already asked and a consultation already booked.

```
Caller ─ Vaani (voice, phone) ─ WebSocket per turn ─▶ this server
                                                      ├─ Gemini decides   (qualified.md only)
                                                      ├─ rules check      (service area, lead time, scope, price filter)
                                                      └─ Gemini speaks    (Aangan skill: policies and playbook)
After the call: Vaani webhook ─▶ Neon (system of record) ─▶ outbox worker
                                                      ├─ email to designers / escalation (Resend)
                                                      ├─ HubSpot contact + deal + dashboard data
                                                      └─ Qualify only: Cal.com booking, then Vaani confirmation call
```

The full picture, with every lane and arrow, is in [`docs/component-map.html`](docs/component-map.html) (images: [`docs/component-map.png`](docs/component-map.png)).

## Quick start

```bash
npm install
cp .env.example .env        # fill in every REQUIRED value, see "Configuration"
npm run migrate             # creates the Neon tables (safe to run again)
npm run setup:hubspot       # one time: custom deal properties and the "Aangan phone enquiries" pipeline
npm test                    # unit tests, no keys needed
npm start                   # refuses to boot and names anything missing
```

Node 22 or newer. The server needs a public HTTPS and WSS address, because Vaani, Cal.com and the email links call back into it (see Deploying on Vercel).

## Vaani setup (vaanivoice.ai)

Docs: <https://docs.vaanivoice.ai>

The agent can be created with BYOL already on by `node --env-file=.env scripts/vaani-create-agent.js "<name>" wss://<host>/vaani/llm`. BYOL must be set at creation: Vaani's PATCH persona endpoint accepts the request but silently drops `brain.llm.extra_params`, and the Auth Token has no documented API field. The dashboard stores `llm_websocket_url`, `custom_llm: true` and `llm_websocket_auth_token` there.

1. Create the voice agent and connect a phone number (Vaani: Set Up Telephony).
2. Brain, Reasoning Language Model, **BYOL** tab: WebSocket URL `wss://<host>/vaani/llm`, Auth Token = `VAANI_BYOL_TOKEN`. Vaani then connects to `/vaani/llm/<call_id>` for each call.
3. Settings, **Webhooks**: `https://<host>/vaani/webhook/<VAANI_WEBHOOK_SECRET>`. Vaani's docs describe no signature scheme, so the secret in the path is the protection: do not log it, and rotate it if it leaks.
4. Optional, for confirmation calls: a second agent using [`vaani/CONFIRM_AGENT_PROMPT.md`](vaani/CONFIRM_AGENT_PROMPT.md), then set `VAANI_API_KEY` and `VAANI_CONFIRM_AGENT_ID`. Without them the front desk gets an email asking them to call instead.
5. Cal.com: webhook to `https://<host>/calcom/webhook` with the secret `CALCOM_WEBHOOK_SECRET`.

Because the server writes every reply (BYOL), Vaani's own LLM and prompt are not used. The studio playbook lives in [`vaani/AGENT_PROMPT.md`](vaani/AGENT_PROMPT.md).

## The website and dashboard

- **Public site** at `/`: an animated landing page (rotating interior photos, a live call preview, how it works, a typed example call, a photo gallery). It shows only counts from `/api/public-stats`.
- **Dashboard** at `/dashboard`. By default it is **open: no login**. Because it is public, it shows only first names, areas, masked phone numbers and totals, and leaves out the handoff notes. To lock it, set `DASHBOARD_PASSWORD`: it then needs a login (signed HttpOnly cookie, 12 h, 6 wrong tries per 15 minutes per address) and shows full details. Live KPIs, a 14-day chart, outcome donut, lead funnel, decline reasons, recent calls, upcoming consultations, system health, connections and AI usage; refreshes every 10 s with a toast when a call arrives. The "Preview with sample data" button shows the design with clearly labelled fake data.
- Files live in `public/` (no build step, no front-end dependencies: charts are hand-drawn SVG). The server also serves them itself, so a plain Node host behaves like Vercel. Path traversal and source files are blocked and tested.
- Photos are open-licensed images from Wikimedia Commons, resized and stored in `public/img/`; `credits.json` has each photographer and licence and the footer credits them. Replace them with your own project photos any time.
- Dashboard data comes from `src/dashboard-data.js`; login from `src/auth.js`. Optionally set `DASHBOARD_PASSWORD` (and `DASHBOARD_SESSION_SECRET`) in `.env` to lock it.

## Deploying on Vercel

Deployed at <https://aangan-agent-one.vercel.app> (Vercel project `aangan-agent`, region Singapore to sit next to Neon). `api/server.js` is the function entry point: Vercel serves WebSockets from a function that default-exports an `http.Server` with `ws` attached ([docs](https://vercel.com/docs/functions/websockets)). `vercel.json` rewrites every path to it, passing the original path as `?__p=` (restored by `src/url.js`).

```bash
npx vercel link                       # once
node scripts/vercel-env.js            # pushes .env to Vercel production (secrets stored as sensitive); never prints values
npx vercel deploy --prod
node --env-file=.env scripts/remote-smoke.js https://<your-host>   # real end-to-end check of the deployment
```

Things that differ from a normal server, all handled in code:

- **No background timer.** A Vercel function is frozen between requests, so a timer would freeze a half-done job. `bin/start.js` (the long-running entry for any normal host) starts the worker only when `VERCEL` is not set. On Vercel the outbox is drained by the webhook handlers (which wait up to 45 s for the work before answering) and by `GET /cron/drain`, protected by `CRON_SECRET`.
- **Hobby plan limits.** Cron can run once a day, so `vercel.json` uses a daily schedule; a job that is cut off is retried on the next webhook or the daily run. A WebSocket closes at the function's maximum duration (300 s on Hobby, 800 s on Pro), so a phone call longer than 5 minutes loses its connection. Call state (availability asked, price line said) is saved in Neon so a reconnect resumes, but whether Vaani reconnects is not documented. On Pro set `maxDuration` to 800 and the cron to `* * * * *`.
- **Entry-point names matter.** Vercel auto-detects files called `index.js`, `server.js` and similar as the app. The long-running entry is therefore `bin/start.js` and the router `src/http-server.js`, and `package.json` `main` points at `api/server.js`.
- A push to `main` redeploys automatically because the repository is connected to the Vercel project.

## How a call is handled

| Step | What happens |
|---|---|
| Each caller turn | Vaani sends the conversation. Gemini scores five criteria from `src/knowledge/qualified.md`. The rules check can overrule it. Gemini then writes the reply from the playbook. The price filter runs on every reply before Vaani speaks it. |
| Routes | **Qualify** (asks when the caller is free, then wraps up), **Clarify** (one question, loops), **Decline** (polite, with reason), **Escalate** (existing-client complaint, senior call-back), **Log only** (dropped call, or still unclear at hang-up, a person follows up). |
| End of call | Vaani's `call_postprocessing` webhook delivers the transcript. The call is finalised once (duplicate webhooks are ignored), then saved to Neon together with its outbox jobs in one transaction. |
| After | Email handoff (qualify), escalation email, HubSpot sync (all calls), and for **Qualify only**: Gemini reads the transcript for availability, the backend books a Cal.com slot, and Vaani calls the customer to confirm. |

Rules enforced in code, not left to the model: service-area list, the 6-week lead-time floor, restaurant / hotel / retail / gym are out of scope, any failed criterion declines, unclear budget or decision-maker still qualifies with a flag, at most 3 clarifying questions, and no price ever reaches a caller.

## Configuration

Everything is in environment variables; see [`.env.example`](.env.example). Nothing is defaulted for values a vendor or the founder must decide, and `npm start` lists whatever is missing.

| Service | Values | Where to get them |
|---|---|---|
| Neon | `DATABASE_URL` | Neon console, Connect. Use the pooled string. |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL` | Google AI Studio. Pick a fast model; a lite model answers in about 2 s, a full flash model took 8 to 14 s and is too slow for a phone turn. |
| Vaani | `VAANI_WEBHOOK_SECRET`, `VAANI_BYOL_TOKEN` (you generate); `VAANI_API_KEY`, `VAANI_CONFIRM_AGENT_ID` (optional) | Vaani dashboard |
| Resend | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_DESIGNERS`, `EMAIL_ESCALATION`, `EMAIL_FRONTDESK`, `PUBLIC_BASE_URL`, `ACTION_LINK_SECRET` | Resend. Without a verified domain you can only send from Resend's test sender. |
| Cal.com | `CALCOM_API_KEY`, two event type ids, version headers, `CALCOM_WEBHOOK_SECRET` | Cal.com. Event types must make email optional and phone required, or phone-only bookings are rejected. Cal.com's three default event types require an email. |
| HubSpot | `HUBSPOT_ACCESS_TOKEN`, pipeline and six stage ids, association id | A Service Key or private app with contacts and deals read/write plus `crm.schemas.deals.write`. `npm run setup:hubspot` creates the properties and pipeline and prints the ids. |
| Costs | `RATE_*` (optional) | Left blank, rupee amounts stay empty. Token and call-second units are always stored. Nothing is guessed. |

Never commit `.env`; it is git-ignored. Rotate any key that has been pasted into a chat or a ticket.

## Testing

| Command | Needs | What it proves |
|---|---|---|
| `npm test` | nothing | 40 unit tests: rules and routing against the real transcripts, price filter, signed links, Vaani helpers, prompt directives. |
| `npm run e2e:http` | Neon | Email links, Cal.com webhook signature, health, malformed input, dashboard login and cookie, data API shape, masked numbers, lockout, static files and path traversal. 38 checks. |
| `npm run e2e:concurrency` | Neon, Gemini | Races real workers: one HubSpot deal and one Cal.com booking under parallel jobs, retry after a vendor failure, backoff, dead-lettering with an alert. 12 checks. |
| `npm run e2e:mock` | Neon, Gemini | Full flow with stand-in Cal.com, HubSpot and Resend. 14 checks. |
| `npm run simulate:vaani` | Neon, Gemini | A stand-in Vaani talks to the real server over a real WebSocket and webhooks, following Vaani's documented contract. 21 checks. |
| `scripts/remote-smoke.js <url>` | all keys | A deployed server end to end with real services: WebSocket call, webhooks, Cal.com booking, HubSpot deal, background jobs, then cleanup. 12 checks. |
| `npm run e2e:live` | all keys | The real Cal.com and HubSpot: books, creates the deal and properties, moves it to Won, then cleans up. 9 checks. |
| `npm run live:calcom`, `live:hubspot` | keys | Individual live checks, with cleanup. |
| `npm run eval -- <enquiries.txt> <model>` | Gemini | Scores the model on the September phone transcripts. |

Test scripts only delete rows that belong to their own test calls.

**CI.** A ready workflow is in [`docs/ci-workflow.yml`](docs/ci-workflow.yml) (installs, checks syntax, runs the unit tests; no keys needed). GitHub only accepts workflow files from a token with the `workflow` scope, so enable it with `gh auth refresh -h github.com -s workflow`, then `mkdir -p .github/workflows && git mv docs/ci-workflow.yml .github/workflows/test.yml` and push.

## Known limits

- **Not run against a real Vaani call.** The stand-in follows the docs. Still to confirm on a real call: that the webhook `room_name` equals the BYOL `call_id`, that `phone_number` on `call_started` is the caller, and the exact `call_postprocessing` shape (the docs' own example is inconsistent; the code accepts both).
- **Latency.** Each turn runs two Gemini calls in a row, about 3 seconds, against Vaani's advertised 450 ms. If callers notice, merge decision and speech into one call or add a short spoken filler.
- **Answer time** is recorded as the webhook arrival time for both start and answer, so it is about zero by design (the agent answers at once). It becomes meaningful only as a before/after comparison.
- The Cal.com webhook payload and its signature header are implemented from memory of Cal.com's docs and marked `VERIFY` in the code; reschedules are matched by old and new uid.
- Graceful shutdown on SIGTERM was written for Linux hosts and not exercised on Windows.
- Open business questions for the founder: lead time 6 versus 8 to 10 weeks, commercial minimum size, fringe areas such as Talegaon (the rubric declines them; the skill says escalate), who handles escalations out of hours.

## Layout

```
src/rules.js         hard limits, routing, price filter (pure, tested)
src/gemini.js        decision, speech, handoff note, slot choice, confirmation reading
src/byol.js          Vaani per-turn WebSocket
src/vaani.js         Vaani client and webhook helpers
src/vaani-events.js  Vaani webhooks
src/pipeline.js      in-call decision and end-of-call finalise
bin/start.js         long-running entry point (any normal Node host); api/server.js is the Vercel entry
src/worker.js        outbox: email, HubSpot, scheduler, confirmation, retries and dead-lettering
src/http-server.js   HTTP endpoints (router)
src/auth.js          dashboard login and sessions
src/dashboard-data.js  dashboard and public statistics
src/static.js        serves public/
public/              landing page, dashboard, CSS, JS, photos
api/server.js        Vercel entry point
src/db.js            Neon queries, locks
src/email.js         Resend and signed links
src/hubspot.js       HubSpot client
src/calcom.js        Cal.com client
db/schema.sql        tables (idempotent)
vaani/               agent prompt and confirmation-agent prompt
docs/                component map
scripts/             tests, live checks, setup
```
