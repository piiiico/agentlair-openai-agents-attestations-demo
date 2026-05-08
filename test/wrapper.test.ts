import { describe, expect, test } from 'bun:test';
import { Agent, tool } from '@openai/agents';
import { RunContext } from '@openai/agents-core';
import { z } from 'zod';
import { AgentLairAttestationRecorder } from '../lib/agentlair-openai-agents.ts';

// ─── Test helpers ────────────────────────────────────────────────────────────

interface FakeFetchCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function makeFakeFetch(opts?: {
  bccId?: string;
  failAuditWith?: number;
  failBccWith?: number;
}): { fn: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let counter = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const initSafe = init ?? {};
    const bodyText = typeof initSafe.body === 'string' ? initSafe.body : '';
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = {};
    }
    calls.push({ url, init: initSafe, body });
    if (url.endsWith('/v1/tokens/issue')) {
      // Stub the AAT issue endpoint so withAgentLair stops logging warnings
      // about token issuance failures during tests. The tokens are not used
      // anywhere — the wrapper just needs a structurally valid response.
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return new Response(
        JSON.stringify({
          token: 'eyJhbGciOiJFZERTQSJ9.test.signature',
          token_type: 'Bearer',
          expires_at: expiresAt,
          expires_in: 3600,
          jti: 'aat_testaaaaaaaaaaaa',
          audit_url: 'https://agentlair.dev/v1/audit/aat_testaaaaaaaaaaaa',
        }),
        { status: 201 },
      );
    }
    if (url.endsWith('/v1/audit/log')) {
      if (opts?.failAuditWith) {
        return new Response('{"error":"fail"}', { status: opts.failAuditWith });
      }
      counter++;
      const responseBody = {
        id: `ev_${counter.toString().padStart(20, '0')}`,
        timestamp: new Date(2026, 4, 8, counter).toISOString(),
        signature: `sig_${counter}`,
        prev_hash: counter === 1 ? '0'.repeat(64) : `hash_${counter - 1}`,
      };
      return new Response(JSON.stringify(responseBody), { status: 201 });
    }
    if (url.endsWith('/v1/bcc/issue')) {
      if (opts?.failBccWith) {
        return new Response('{"error":"fail"}', { status: opts.failBccWith });
      }
      const id = opts?.bccId ?? 'bcc_TestCredential01';
      return new Response(
        JSON.stringify({
          id: `https://agentlair.dev/v1/bcc/${id}`,
          credentialSubject: { id: (body as { subject_did?: string }).subject_did },
        }),
        { status: 201 },
      );
    }
    return new Response('{"error":"unhandled"}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function makeRecorder(fn: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new AgentLairAttestationRecorder({
    apiKey: 'al_test_x',
    subjectDid: 'did:web:test:agents:acc_x',
    audience: 'https://test.example.com',
    fetch: fn,
    silent: true,
    ...overrides,
  });
}

const SEARCH_TOOL = tool({
  name: 'search_availability',
  description: 'Search slots near a target time.',
  parameters: z.object({ slot: z.string() }),
  execute: async ({ slot }: { slot: string }) => `slots: ${slot}`,
});

const PROPOSE_TOOL = tool({
  name: 'propose',
  description: 'Propose a slot.',
  parameters: z.object({ slot: z.string() }),
  execute: async ({ slot }: { slot: string }) => `proposed: ${slot}`,
});

const ECHO_TOOL = tool({
  name: 'echo',
  description: 'Echo input back.',
  parameters: z.object({ x: z.string() }),
  execute: async ({ x }: { x: string }) => `echo: ${x}`,
});

const UGLY_NAMED_TOOL = tool({
  // The OpenAI SDK enforces ^[a-zA-Z0-9_-]+$ on tool names, so we use the
  // ugliest legal name it'll accept. The action sanitizer must lowercase
  // it and strip the dashes for the AgentLair regex.
  name: 'My-Weird_Tool-99',
  description: 'Tool with an ugly name.',
  parameters: z.object({ z: z.string() }),
  execute: async (_: { z: string }) => 'ok',
});

const FAILING_TOOL = tool({
  name: 'failer',
  description: 'A tool that always throws.',
  parameters: z.object({ x: z.string() }),
  // OpenAI Agents' default `errorFunction` swallows thrown errors and returns
  // a model-visible string. Set null to make the error propagate so we can
  // verify the wrapper records `tool.error` and rethrows.
  errorFunction: null,
  execute: async (_: { x: string }) => {
    throw new Error('intentional test failure');
  },
});

function makeAgent(tools: ReturnType<typeof tool>[]) {
  return new Agent({
    name: 'test-agent',
    instructions: 'Test instructions.',
    tools,
  });
}

async function invokeTool(
  t: unknown,
  args: Record<string, unknown>,
): Promise<string> {
  const ctx = new RunContext();
  const fn = (t as { invoke: (ctx: RunContext, input: string, details?: unknown) => Promise<unknown> }).invoke;
  return (await fn(ctx, JSON.stringify(args), {})) as string;
}

// ─── Construction ────────────────────────────────────────────────────────────

describe('AgentLairAttestationRecorder construction', () => {
  test('rejects missing api key', () => {
    expect(() =>
      new AgentLairAttestationRecorder({
        apiKey: '',
        subjectDid: 'did:web:test:agents:acc_x',
        audience: 'https://test.example.com',
      }),
    ).toThrow(/apiKey/);
  });

  test('rejects api key without al_ prefix', () => {
    expect(() =>
      new AgentLairAttestationRecorder({
        apiKey: 'not_a_real_key',
        subjectDid: 'did:web:test:agents:acc_x',
        audience: 'https://test.example.com',
      }),
    ).toThrow(/al_/);
  });

  test('rejects subjectDid without did: prefix', () => {
    expect(() =>
      new AgentLairAttestationRecorder({
        apiKey: 'al_test_x',
        subjectDid: 'acc_x',
        audience: 'https://test.example.com',
      }),
    ).toThrow(/did:/);
  });

  test('rejects empty audience', () => {
    expect(() =>
      new AgentLairAttestationRecorder({
        apiKey: 'al_test_x',
        subjectDid: 'did:web:test:agents:acc_x',
        audience: '',
      }),
    ).toThrow(/audience/);
  });

  test('strips trailing slash from apiBase', async () => {
    const { fn, calls } = makeFakeFetch();
    const recorder = makeRecorder(fn, { apiBase: 'https://example.com//' });
    await recorder.attestReasoning('hi');
    const auditCalls = calls.filter(c => c.url.endsWith('/v1/audit/log'));
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]!.url).toBe('https://example.com/v1/audit/log');
  });
});

// ─── Audit emission on tool invocations ──────────────────────────────────────

describe('audit emission on tool invocations', () => {
  test('emits tool_call on entry and observation on result', async () => {
    const { fn, calls } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([SEARCH_TOOL]));

    const out = await invokeTool(agent.tools![0]! as typeof SEARCH_TOOL, {
      slot: '2026-05-09T14:00Z',
    });
    expect(out).toBe('slots: 2026-05-09T14:00Z');

    const auditCalls = calls.filter(c => c.url.endsWith('/v1/audit/log'));
    expect(auditCalls.length).toBe(2);

    const startCall = auditCalls[0]!;
    expect(startCall.body.category).toBe('tool_call');
    expect(startCall.body.action).toBe('tool.search_availability');
    expect((startCall.body.details as { tool_name: string }).tool_name).toBe('search_availability');

    const endCall = auditCalls[1]!;
    expect(endCall.body.category).toBe('observation');
    expect(endCall.body.action).toBe('tool.result');
  });

  test('action regex compliance for ugly tool names', async () => {
    const { fn, calls } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([UGLY_NAMED_TOOL]));

    await invokeTool(agent.tools![0]! as typeof UGLY_NAMED_TOOL, { z: 'a' });
    const start = calls.filter(c => c.url.endsWith('/v1/audit/log'))[0]!;
    // Server regex: ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$
    expect(start.body.action as string).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
  });

  test('accumulates events across two tool invocations', async () => {
    const { fn } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([SEARCH_TOOL, PROPOSE_TOOL]));

    await invokeTool(agent.tools![0]! as typeof SEARCH_TOOL, { slot: 'x' });
    await invokeTool(agent.tools![1]! as typeof PROPOSE_TOOL, { slot: 'x' });
    expect(recorder.auditEvents.length).toBe(4);
    expect(recorder.auditEvents.map(e => e.category)).toEqual([
      'tool_call',
      'observation',
      'tool_call',
      'observation',
    ]);
  });

  test('reset clears the accumulated buffer', async () => {
    const { fn } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([ECHO_TOOL]));
    await invokeTool(agent.tools![0]! as typeof ECHO_TOOL, { x: 'a' });
    expect(recorder.auditEvents.length).toBe(2);
    recorder.reset();
    expect(recorder.auditEvents.length).toBe(0);
  });

  test('emits observation with action tool.error when the tool throws', async () => {
    const { fn, calls } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([FAILING_TOOL]));

    let threw: unknown;
    try {
      await invokeTool(agent.tools![0]! as typeof FAILING_TOOL, { x: 'a' });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);

    const auditCalls = calls.filter(c => c.url.endsWith('/v1/audit/log'));
    expect(auditCalls.length).toBe(2);
    expect(auditCalls[1]!.body.category).toBe('observation');
    expect(auditCalls[1]!.body.action).toBe('tool.error');
  });
});

// ─── Reasoning and output explicit attests ──────────────────────────────────

describe('explicit reasoning + output attestation', () => {
  test('attestReasoning POSTs a reasoning entry with the truncated task', async () => {
    const { fn, calls } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    await recorder.attestReasoning('book a meeting near 2026-05-09T14:00Z');
    const c = calls.filter(x => x.url.endsWith('/v1/audit/log'))[0]!;
    expect(c.body.category).toBe('reasoning');
    expect(c.body.action).toBe('agent.start');
    expect((c.body.details as { task: string }).task).toContain('book a meeting');
  });

  test('attestOutput POSTs an output entry with the result', async () => {
    const { fn, calls } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    await recorder.attestOutput({ status: 'pending' });
    const c = calls.filter(x => x.url.endsWith('/v1/audit/log'))[0]!;
    expect(c.body.category).toBe('output');
    expect(c.body.action).toBe('agent.complete');
  });

  test('end-to-end produces 4 hash-chained events with one of each category', async () => {
    const { fn } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([ECHO_TOOL]));

    await recorder.attestReasoning('echo a thing');
    await invokeTool(agent.tools![0]! as typeof ECHO_TOOL, { x: 'a' });
    await recorder.attestOutput({ ok: true });

    const cats = recorder.auditEvents.map(e => e.category);
    expect(cats).toEqual(['reasoning', 'tool_call', 'observation', 'output']);
    expect(recorder.auditEvents.length).toBe(4);
  });
});

// ─── Wrapper non-invasiveness ────────────────────────────────────────────────

describe('wrapper does not change tool semantics', () => {
  test('output is identical with and without recorder wrap', async () => {
    const { fn } = makeFakeFetch();
    const recorder = makeRecorder(fn);

    const naked = makeAgent([ECHO_TOOL]);
    const governed = recorder.wrap(makeAgent([ECHO_TOOL]));

    const a = await invokeTool(naked.tools![0]! as typeof ECHO_TOOL, { x: 'hello' });
    const b = await invokeTool(governed.tools![0]! as typeof ECHO_TOOL, { x: 'hello' });
    expect(a).toBe(b);
  });

  test('audit failure does not break the tool call', async () => {
    const { fn } = makeFakeFetch({ failAuditWith: 503 });
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([ECHO_TOOL]));
    const r = await invokeTool(agent.tools![0]! as typeof ECHO_TOOL, { x: 'still works' });
    expect(r).toBe('echo: still works');
    // Audit POSTs all failed → no events recorded on the chain
    expect(recorder.auditEvents.length).toBe(0);
  });
});

// ─── Token / secret leak guard ───────────────────────────────────────────────

describe('audit and BCC payloads do not leak secrets', () => {
  test('api key never appears in any request body', async () => {
    const apiKey = 'al_test_DO_NOT_LEAK_THIS_VALUE_ABC123';
    const { fn, calls } = makeFakeFetch();
    const recorder = new AgentLairAttestationRecorder({
      apiKey,
      subjectDid: 'did:web:test:agents:acc_x',
      audience: 'https://test.example.com',
      fetch: fn,
    });
    const agent = recorder.wrap(makeAgent([ECHO_TOOL]));
    await invokeTool(agent.tools![0]! as typeof ECHO_TOOL, { x: 'data' });
    await recorder.issueBcc({ task: 't', outcome: 'o' });

    for (const c of calls) {
      const headers = c.init.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe(`Bearer ${apiKey}`);
      const bodyStr = typeof c.init.body === 'string' ? c.init.body : '';
      // The wrapper must never embed the key in any request body.
      expect(bodyStr).not.toContain(apiKey);
    }
  });
});

// ─── BCC issuance ────────────────────────────────────────────────────────────

describe('issueBcc', () => {
  test('returns a bundle with id, url, verifyUrl', async () => {
    const { fn, calls } = makeFakeFetch({ bccId: 'bcc_XYZ123' });
    const recorder = makeRecorder(fn);
    const agent = recorder.wrap(makeAgent([ECHO_TOOL]));
    await invokeTool(agent.tools![0]! as typeof ECHO_TOOL, { x: 'a' });

    const bundle = await recorder.issueBcc({
      task: 'book_meeting',
      outcome: { ok: true },
      confidence: 0.85,
    });

    expect(bundle.bccId).toBe('bcc_XYZ123');
    expect(bundle.bccUrl).toBe('https://agentlair.dev/v1/bcc/bcc_XYZ123');
    expect(bundle.bccVerifyUrl).toBe('https://agentlair.dev/v1/bcc/bcc_XYZ123/verify');
    expect(bundle.events.length).toBe(2);

    const issueCall = calls.find(c => c.url.endsWith('/v1/bcc/issue'))!;
    const body = issueCall.body as {
      subject_did: string;
      claim: { task: string; framework: string; audit_event_count: number; first_event_id: string; last_event_id: string };
      stake_medium: string;
      confidence: number;
    };
    expect(body.subject_did).toBe('did:web:test:agents:acc_x');
    expect(body.claim.task).toBe('book_meeting');
    expect(body.claim.framework).toBe('openai-agents');
    expect(body.claim.audit_event_count).toBe(2);
    expect(body.claim.first_event_id).toMatch(/^ev_/);
    expect(body.claim.last_event_id).toMatch(/^ev_/);
    expect(body.stake_medium).toBe('claims');
    expect(body.confidence).toBe(0.85);
  });

  test('rejects out-of-range confidence', async () => {
    const { fn } = makeFakeFetch();
    const recorder = makeRecorder(fn);
    await expect(recorder.issueBcc({ task: 't', outcome: 'o', confidence: 1.5 })).rejects.toThrow(/confidence/);
    await expect(recorder.issueBcc({ task: 't', outcome: 'o', confidence: -0.1 })).rejects.toThrow(/confidence/);
  });

  test('throws on BCC issuance HTTP failure', async () => {
    const { fn } = makeFakeFetch({ failBccWith: 403 });
    const recorder = makeRecorder(fn);
    await expect(recorder.issueBcc({ task: 't', outcome: 'o' })).rejects.toThrow(/POST.*\/v1\/bcc\/issue/);
  });

  test('uses configured stake_medium', async () => {
    const { fn, calls } = makeFakeFetch();
    const recorder = makeRecorder(fn, { bccProfile: 'capital' });
    await recorder.issueBcc({ task: 't', outcome: 'o' });
    const issueCall = calls.find(c => c.url.endsWith('/v1/bcc/issue'))!;
    expect((issueCall.body as { stake_medium: string }).stake_medium).toBe('capital');
  });
});
