# agentlair-openai-agents-attestations-demo

![BCC](https://agentlair.dev/v1/bcc/bcc_8gkhJjgw0JM7mMIsqUW1/badge.svg)

Agent runs leave no trace. This demo wraps an OpenAI Agents SDK agent with AgentLair so every tool call is hash-chained into a Bonded Credibility Credential — cryptographically verifiable by anyone, no account needed:

```bash
curl https://agentlair.dev/v1/bcc/bcc_8gkhJjgw0JM7mMIsqUW1/verify
```

## The footgun

`tool({execute})` installs `defaultToolErrorFunction`, which swallows thrown errors and returns a model-readable string. To make errors propagate so the wrapper records `tool.error`, set `errorFunction: null` on the tool (see `test/wrapper.test.ts` `FAILING_TOOL`):

```typescript
const failingTool = tool({
  description: '...',
  parameters: z.object({ input: z.string() }),
  execute: async () => { throw new Error('downstream failure'); },
  errorFunction: null,  // without this, errors become silent model-readable strings
});
```

Without `errorFunction: null`, your audit chain shows success where the tool actually failed.

## Quickstart

```bash
git clone https://github.com/piiiico/agentlair-openai-agents-attestations-demo
cd agentlair-openai-agents-attestations-demo
bun install
bun run demo
```

Three steps. No credentials needed up front. The demo registers a fresh anonymous account at agentlair.dev if you do not export `AGENTLAIR_API_KEY` first. The OpenAI model is mocked. The demo invokes wrapped tools directly, so it runs offline and consumes zero OpenAI tokens. The attestation surface is what this demo proves, not the language model.

## What just happened

An OpenAI Agents SDK `Agent` was wrapped with `recorder.wrap()` so each of its tools' `invoke` got swapped for one that emits two hash-chained audit events at agentlair.dev: `tool_call` on entry, `observation` on exit. Two explicit attests (`reasoning` at the start, `output` at the end) bookend the run. When everything finished, `recorder.issueBcc()` minted a Bonded Credibility Credential whose `claim` body anchors the credential to the audit chain via the first and last event ids.

You can curl that BCC right now without an account:

```bash
curl https://agentlair.dev/v1/bcc/bcc_8gkhJjgw0JM7mMIsqUW1/verify
```

Returns `valid:true`. Issuer, subject, audit window, and the self-anchor are all in the response.

## The wrapper, in three lines

```typescript
import { Agent, tool } from '@openai/agents';
import { AgentLairAttestationRecorder } from './lib/agentlair-openai-agents.ts';

const recorder = new AgentLairAttestationRecorder({ apiKey, subjectDid, audience });
const governed = recorder.wrap(new Agent({ name: 'demo', tools: [...], instructions: '...' }));
const bcc = await recorder.issueBcc({ task: 'book_meeting', outcome });
```

`AgentLairAttestationRecorder` delegates to `withAgentLair` from `@agentlair/openai-agents` under the hood. `wrap()` returns a shallow clone with each tool's `invoke` replaced. The replacement does three things on every call: issue (or reuse) an AAT, run the original tool, post one `tool_call` and one `observation` entry to AgentLair's L3 hash-chained audit log. The wrapper awaits the audit POST before returning the tool result, so by the time `await tool.invoke(...)` resolves, both audit entries are already in `recorder.auditEvents`.

## Sample output (real artifacts)

```
agent      did:web:agentlair.dev:agents:acc_o5wvN67psmfMdFv0
task       book a meeting near 2026-05-09T14:00Z

step 0     reasoning attest (agent.start)
step 1     tool: search_availability
           result: {"slot":"2026-05-09T14:00Z","options":[...]}

step 2     tool: propose
           result: {"proposed_slot":"2026-05-09T14:00Z","status":"pending_confirmation"}

audit events emitted to agentlair.dev: 6
  UA0n8MaeDKJgOjHXJp56 reasoning    agent.start
  Gpbod8NVPzDtYFXc0qpX tool_call    tool.search_availability
  vg9Ud027Y3UrVJIQv6IA observation  tool.result
  3fiYKpw6kSUOCoJhHzVq tool_call    tool.propose
  fWcQCwsIvaIdGHoUqEyu observation  tool.result
  BfmwsWG27gIbaTJxaxYM output       agent.complete

bcc        bcc_8gkhJjgw0JM7mMIsqUW1
url        https://agentlair.dev/v1/bcc/bcc_8gkhJjgw0JM7mMIsqUW1
verify     https://agentlair.dev/v1/bcc/bcc_8gkhJjgw0JM7mMIsqUW1/verify
```

That `bcc_8gkhJjgw0JM7mMIsqUW1` is real. It was issued at 11:42 UTC on 2026-05-08 against AgentLair production. Curl the verify URL above and you get `valid:true`.

## Use it with your own OpenAI Agents SDK agent

The recorder does not care what shape your agent has. Pass any `Agent` with a `tools` array and you get back a wrapped clone:

```typescript
// 1. Wrap the whole agent
const governed = recorder.wrap(myAgent);
const result = await run(governed, 'first input');  // tools fire, audits land

// 2. Or attest reasoning and output explicitly when run() is too coarse
await recorder.attestReasoning('book a meeting near 2026-05-09T14:00Z');
const result = await run(governed, 'first input');
await recorder.attestOutput(result.finalOutput);

// 3. Then mint the BCC summarising the audit chain
const bundle = await recorder.issueBcc({ task: 'book_meeting', outcome: result.finalOutput });
```

The recorder hooks at the tool-invoke layer, so it does not interfere with handoffs, parallel tool calls, or streaming. A handoff is just another tool call as far as the SDK is concerned, and the audit chain reflects that.

## Why mock the LLM

Two reasons: the demo runs offline (clone, install, run — no OpenAI key, no usage costs), and the audit chain is reproducible (no model variance to make every run look different). The wrapper records audit events identically whether the LLM picked the call or `demo.ts` did. If you want to see what a live LLM run looks like with this wrapper, set `OPENAI_API_KEY` in your shell, replace the direct `tool.invoke()` calls in `demo.ts` with `await run(governed, '...')`, and re-run. The audit chain output is the same shape, just with whichever tool calls the model decided to make.

## What gets emitted

Two audit categories cover the tool path:

- `tool_call` on tool entry. The `action` is `tool.<tool_name>`, sanitized against the AgentLair regex `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`. The `details` field carries the tool name, the JSON-stringified input (truncated to 800 chars by default), and the SDK-reported `started_at`.
- `observation` on tool exit. The `action` is `tool.result` on success or `tool.error` on failure. The `details` field carries the tool name, the truncated output (or error message), and the duration in milliseconds.

Two more cover the agent itself:

- `reasoning` for `agent.start`. Posted by `recorder.attestReasoning(prompt)` at the top of the run.
- `output` for `agent.complete`. Posted by `recorder.attestOutput(result)` after the agent finishes.

The BCC issued by `recorder.issueBcc()` is a W3C Verifiable Credential, profile `BCC-Claims`, signed with `eddsa-jcs-2022`. The `claim` body includes:

```json
{
  "task": "book_meeting",
  "outcome": { ... },
  "framework": "openai-agents",
  "audit_event_count": 6,
  "first_event_id": "UA0n8MaeDKJgOjHXJp56",
  "last_event_id": "BfmwsWG27gIbaTJxaxYM",
  "issued_at": "2026-05-08T11:42:12.482Z"
}
```

The first and last event ids anchor the BCC into the audit chain. A dispute reviewer can pull both events from `GET /v1/audit/log` and walk the hash chain between them.

## Verify the chain

```bash
curl https://agentlair.dev/v1/bcc/bcc_8gkhJjgw0JM7mMIsqUW1/verify
```

Expected shape:

```json
{
  "credential_id": "bcc_8gkhJjgw0JM7mMIsqUW1",
  "valid": true,
  "profile": "BCC-Claims",
  "issuer": "did:web:agentlair.dev:agents:acc_o5wvN67psmfMdFv0",
  "evidence_chain": [{ "type": "self_anchor", "ref": "self:bcc_8gkhJjgw0JM7mMIsqUW1" }]
}
```

The audit chain behind this BCC has 6 events. Walk them at `GET /v1/audit/log`.

## Verify standalone

```bash
bun run verify bcc_8gkhJjgw0JM7mMIsqUW1
```

Calls `GET /v1/bcc/<id>/verify` and prints the structured response. Exits 1 if invalid or revoked. Pass any BCC id, including ones issued by other accounts.

## Where the OpenAI Agents SDK does NOT match LangChain

LangChain.js exposes `BaseCallbackHandler` with separate `handleToolStart` and `handleToolEnd` hooks, so a callback can record a `tool_call` event before the tool runs and an `observation` event after. The OpenAI Agents SDK is shaped differently: the framework wraps your `tool({execute})` into a `FunctionTool` whose `invoke(runContext, input, details)` runs the whole call inside an internal try/catch. The `@agentlair/openai-agents` wrapper hooks at the FunctionTool layer by replacing `invoke` with one that times the call from start to finish and emits a single `AuditEvent` per invocation.

This recorder splits that single SDK event into two L3 hash-chained entries (`tool_call`, then `observation`) so the chain layout matches the LangChain demo. The order is preserved across multiple tool calls (tool A's pair lands before tool B's), but the two entries within one call are posted back-to-back rather than around the tool. Server-side hash ordering is what proves chain integrity, not client wall-clock ordering.

One footgun specific to the OpenAI Agents SDK that bit during development: `tool({execute})` installs a `defaultToolErrorFunction` that swallows thrown errors and returns a model-readable string. If you want errors to actually propagate so the wrapper records `tool.error`, set `errorFunction: null` on the tool (see `test/wrapper.test.ts` `FAILING_TOOL`).

## Honest limits of v1

Things you should know before using this for anything beyond experimentation:

- The hash chain is computed per Cloudflare worker isolate. Concurrent isolates run independent chains, so two events from the same agent at the same millisecond may land on parallel chains. Worker isolates serialise within themselves; cross-isolate ordering is not guaranteed yet.
- `evidence_anchor` on the BCC is a `self:<id>` placeholder. There is no SCITT receipt or on-chain anchor in v1, so the audit timeline is anchored only by AgentLair's signing key.
- The wrapper truncates audit `details.args` and `details.result` to 800 characters by default. If your tool returns large structured payloads, the audit log only sees a prefix. The original output flows through the SDK unchanged.
- Reasoning attests are explicit (`recorder.attestReasoning(prompt)`). There is no automatic per-LLM-call reasoning hook because the OpenAI Agents SDK does not surface model events at the runner level. If you want finer-grained capture, add `recorder.attestReasoning` calls at the boundaries you care about.

## How to get an API key

Anonymous, no email, no card:

```bash
curl -s -X POST https://agentlair.dev/v1/register \
  | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).api_key)'
```

Save the output. It begins with `al_live_`. Free tier covers 100 requests per day. Each demo run consumes around eight requests (register, account/me, AAT issue, six audit events, plus the BCC issue). You can issue around twelve BCCs per day on free tier.

## Files

- `lib/agentlair-openai-agents.ts` is the recorder. `AgentLairAttestationRecorder` plus types.
- `demo.ts` builds an Agent with two tools, wraps it, attests reasoning, invokes both tools, attests output, mints the BCC.
- `verify.ts` calls the public verify endpoint for any `bcc_xxx` id.
- `test/wrapper.test.ts` mocks `fetch` and asserts the audit and BCC payloads (20 tests covering construction, audit emission, the action regex, error propagation, secret-leak guards, and BCC issuance).

## License

MIT.
