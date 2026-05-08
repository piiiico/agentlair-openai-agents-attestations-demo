/**
 * AgentLair behavioral attestation for the OpenAI Agents SDK.
 *
 * `AgentLairAttestationRecorder` wraps an `Agent` from `@openai/agents` so that
 * every tool invocation records a hash-chained audit event at agentlair.dev.
 * Reasoning and output events can also be attested explicitly. When the agent
 * task is complete, call `issueBcc()` to mint a Bonded Credibility Credential
 * that summarises the run and is publicly verifiable.
 *
 * Two notes on design:
 *
 *   1. The hash chain is computed server-side (Cloudflare worker). The client
 *      emits events; the server orders them, signs each one with Ed25519, and
 *      returns `prev_hash` plus a per-entry signature. Trust is anchored at
 *      agentlair.dev, not in this library.
 *
 *   2. The recorder uses `withAgentLair` from `@agentlair/openai-agents` to
 *      install an `onAuditEvent` callback on every wrapped tool. The SDK
 *      awaits the callback before returning the tool result, so by the time
 *      `tool.invoke()` resolves, the corresponding audit entries are already
 *      in `recorder.auditEvents`. Audit POSTs that fail do not throw — they
 *      log a warning and skip the event. The tool call still returns its
 *      real result.
 */

import {
  withAgentLair,
  logAuditEvent,
  type AuditEvent as SdkAuditEvent,
} from '@agentlair/openai-agents';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentLairAttestationRecorderOptions {
  /** Bearer key from agentlair.dev. Starts with `al_live_` or `al_test_`. */
  apiKey: string;
  /** Subject DID for the issued BCC. Format: `did:web:agentlair.dev:agents:acc_xxx`. */
  subjectDid: string;
  /** Audience for the AAT issued by `withAgentLair` (target service the tools call). */
  audience: string;
  /** Override the API base. Default: `https://agentlair.dev`. */
  apiBase?: string;
  /**
   * BCC stake medium. `claims` for assertions (default), `capital` for monetary
   * stake, `existence` for self-revealing tests. Maps 1:1 to the BCC profile.
   */
  bccProfile?: 'claims' | 'capital' | 'existence';
  /** Override the agent name in the AAT and audit metadata. */
  agentName?: string;
  /** Custom fetch (for tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Truncate audit `details` string fields to this many chars. Default 800. */
  maxFieldChars?: number;
  /** Suppress the warning printed when an audit POST fails. Default false. */
  silent?: boolean;
}

/** Hash-chained audit log entry, returned by AgentLair's `/v1/audit/log`. */
export interface RecordedEvent {
  /** Audit log entry id (nanoid, 20 chars). */
  id: string;
  /** ISO 8601 timestamp from the server. */
  timestamp: string;
  /** Base64 Ed25519 signature over the entry. */
  signature: string;
  /** SHA-256 of the previous chained entry. */
  prev_hash: string;
  /** AgentLair audit category (`tool_call`, `observation`, `reasoning`, `output`). */
  category: string;
  /** Dotted lowercase action identifier. */
  action: string;
}

export interface AttestationBundle {
  bccId: string;
  bccUrl: string;
  bccVerifyUrl: string;
  events: RecordedEvent[];
}

// ─── AgentLairAttestationRecorder ─────────────────────────────────────────────

export class AgentLairAttestationRecorder {
  private events: RecordedEvent[] = [];
  private readonly apiKey: string;
  private readonly subjectDid: string;
  private readonly audience: string;
  private readonly apiBase: string;
  private readonly bccProfile: 'claims' | 'capital' | 'existence';
  private readonly agentName?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxFieldChars: number;
  private readonly silent: boolean;

  constructor(opts: AgentLairAttestationRecorderOptions) {
    if (typeof opts.apiKey !== 'string' || !opts.apiKey.startsWith('al_')) {
      throw new Error(
        'AgentLairAttestationRecorder: apiKey must be a string starting with "al_". ' +
          'Get one at https://agentlair.dev/register or via curl -X POST https://agentlair.dev/v1/register.',
      );
    }
    if (typeof opts.subjectDid !== 'string' || !opts.subjectDid.startsWith('did:')) {
      throw new Error(
        'AgentLairAttestationRecorder: subjectDid must be a string starting with "did:" ' +
          '(e.g. "did:web:agentlair.dev:agents:acc_xxx").',
      );
    }
    if (typeof opts.audience !== 'string' || opts.audience.length === 0) {
      throw new Error(
        'AgentLairAttestationRecorder: audience must be a non-empty string ' +
          '(the target service the tools call, used as the AAT audience claim).',
      );
    }
    this.apiKey = opts.apiKey;
    this.subjectDid = opts.subjectDid;
    this.audience = opts.audience;
    this.apiBase = (opts.apiBase ?? 'https://agentlair.dev').replace(/\/+$/, '');
    this.bccProfile = opts.bccProfile ?? 'claims';
    this.agentName = opts.agentName;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxFieldChars = opts.maxFieldChars ?? 800;
    this.silent = opts.silent ?? false;
  }

  // ─── Public interface ──────────────────────────────────────────────────────

  /**
   * Wrap an OpenAI Agents SDK `Agent` so every tool emits hash-chained audit
   * events when invoked. The original agent is unchanged; a shallow clone with
   * wrapped tools is returned.
   *
   * Each tool invocation produces two audit log entries:
   *   - `tool_call` with the tool name and (truncated) arguments,
   *   - `observation` with the tool result (or `tool.error` on failure).
   *
   * Generic over the agent type so users get back the same `Agent<Ctx, Out>`
   * they passed in. Internally we delegate to `@agentlair/openai-agents`'s
   * `withAgentLair`, which works on any object that has a `tools` array of
   * objects with `invoke` or `execute` methods (the duck-type the live
   * SDK satisfies).
   */
  wrap<A extends { tools?: unknown[] }>(agent: A): A {
    return withAgentLair(agent as unknown as Parameters<typeof withAgentLair>[0], {
      apiKey: this.apiKey,
      audience: this.audience,
      agentLairBaseUrl: this.apiBase,
      agentName: this.agentName,
      fetchImpl: this.fetchImpl,
      onAuditEvent: (event) => this.handleSdkAuditEvent(event),
    }) as unknown as A;
  }

  /**
   * Attest the agent's reasoning at task start. Emits a `reasoning` audit
   * entry with the task prompt — the run anchor visible to anyone walking the
   * audit chain.
   */
  async attestReasoning(prompt: string): Promise<RecordedEvent> {
    return this.recordAudit('reasoning', 'agent.start', {
      task: this.truncate(prompt),
    });
  }

  /**
   * Attest the agent's final output. Emits an `output` audit entry — the
   * closing anchor that the BCC claim references via `last_event_id`.
   */
  async attestOutput(result: unknown): Promise<RecordedEvent> {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    return this.recordAudit('output', 'agent.complete', {
      result: this.truncate(resultStr),
    });
  }

  /**
   * Issue a Bonded Credibility Credential summarising the run.
   *
   * The credential's `claim` includes the audit event count plus the first
   * and last event ids, anchoring the BCC to the audit chain. The BCC is
   * signed with the AgentLair issuer key (eddsa-jcs-2022) and persisted in
   * D1. The returned URLs are public — anyone can verify without an account.
   */
  async issueBcc(claim: {
    task: string;
    outcome: unknown;
    confidence?: number;
  }): Promise<AttestationBundle> {
    const confidence = claim.confidence ?? 0.9;
    if (confidence < 0 || confidence > 1) {
      throw new Error('confidence must be between 0 and 1.');
    }
    const body = {
      subject_did: this.subjectDid,
      claim: {
        task: claim.task,
        outcome: claim.outcome,
        framework: 'openai-agents',
        audit_event_count: this.events.length,
        first_event_id: this.events[0]?.id ?? null,
        last_event_id: this.events[this.events.length - 1]?.id ?? null,
        issued_at: new Date().toISOString(),
      },
      stake_medium: this.bccProfile,
      confidence,
    };
    const res = await this.fetchImpl(`${this.apiBase}/v1/bcc/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /v1/bcc/issue failed: ${res.status} ${text}`);
    }
    const credential = (await res.json()) as { id?: string };
    const bccUrl = credential.id;
    if (typeof bccUrl !== 'string' || !bccUrl.includes('/v1/bcc/bcc_')) {
      throw new Error(
        `Unexpected credential id from /v1/bcc/issue: ${JSON.stringify(credential).slice(0, 200)}`,
      );
    }
    const bccId = bccUrl.split('/').pop()!;
    return {
      bccId,
      bccUrl,
      bccVerifyUrl: `${bccUrl}/verify`,
      events: [...this.events],
    };
  }

  /** Read-only snapshot of accumulated audit events. */
  get auditEvents(): readonly RecordedEvent[] {
    return this.events;
  }

  /** Reset the accumulated event buffer between runs. */
  reset(): void {
    this.events = [];
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Translate one SDK `AuditEvent` (one per tool invocation) into two L3
   * audit log entries: `tool_call` with the captured args, then `observation`
   * with the result (or `tool.error` if the tool threw). The SDK awaits this
   * callback before returning the tool result, so both entries are recorded
   * in chain order before the user reads `recorder.auditEvents`.
   */
  private async handleSdkAuditEvent(event: SdkAuditEvent): Promise<void> {
    const toolName = event.toolName ?? 'unnamed';
    await this.recordAudit('tool_call', this.actionFor('tool', toolName), {
      tool_name: toolName,
      args: this.truncate(stringify(event.toolArgs)),
      started_at: event.startedAt,
    });

    if (event.toolError) {
      await this.recordAudit('observation', 'tool.error', {
        tool_name: toolName,
        error: this.truncate(event.toolError),
        duration_ms: event.durationMs,
      });
    } else {
      await this.recordAudit('observation', 'tool.result', {
        tool_name: toolName,
        result: this.truncate(stringify(event.toolResult)),
        duration_ms: event.durationMs,
      });
    }
  }

  /**
   * POST a single audit envelope to AgentLair's L3 hash-chained log via the
   * SDK's `logAuditEvent` helper. Validation runs client-side before the
   * network call. Failures are logged once and swallowed — never block the
   * tool path.
   */
  private async recordAudit(
    category: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<RecordedEvent> {
    try {
      const entry = await logAuditEvent(
        { category, action, details },
        {
          apiKey: this.apiKey,
          agentLairBaseUrl: this.apiBase,
          fetchImpl: this.fetchImpl,
        },
      );
      const recorded: RecordedEvent = { ...entry, category, action };
      this.events.push(recorded);
      return recorded;
    } catch (e) {
      if (!this.silent) {
        console.warn(
          `[agentlair] audit POST failed (${category} ${action}): ${
            e instanceof Error ? e.message : String(e)
          }. Continuing.`,
        );
      }
      // Return a sentinel so the SDK callback still resolves — but DO NOT
      // push it onto the recorded chain. Audit gaps are visible by
      // length(events) < expected; better than fabricating a fake entry.
      return {
        id: '',
        timestamp: new Date().toISOString(),
        signature: '',
        prev_hash: '',
        category,
        action,
      };
    }
  }

  /**
   * Build a valid AgentLair `action` string. Server enforces
   * `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` so we sanitize aggressively.
   * Tool names like "My-Weird Tool 99!" become "my_weird_tool_99".
   */
  private actionFor(prefix: string, suffix: string): string {
    const safeSuffix = suffix
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
    if (!safeSuffix || !/^[a-z]/.test(safeSuffix)) {
      return `${prefix}.run`;
    }
    return `${prefix}.${safeSuffix}`;
  }

  private truncate(s: string): string {
    if (s.length <= this.maxFieldChars) return s;
    return s.slice(0, this.maxFieldChars) + '...[truncated]';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
