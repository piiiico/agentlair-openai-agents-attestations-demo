#!/usr/bin/env bun
/**
 * agentlair-openai-agents-attestations-demo. Wrap an OpenAI Agents SDK agent
 * with AgentLair behavioral attestation. Tools emit signed audit events; the
 * agent issues a publicly verifiable Bonded Credibility Credential at the end.
 *
 * The OpenAI model is mocked. Tool execution is real, audit events are real,
 * the BCC is real. The point of this demo is the attestation surface, not
 * the language model — so no OpenAI key required, no tokens consumed.
 *
 * Usage:
 *   AGENTLAIR_API_KEY=al_live_... bun run demo
 *   bun run demo                  # auto-registers a fresh anonymous account
 */

import { Agent, tool } from '@openai/agents';
import { RunContext } from '@openai/agents-core';
import { z } from 'zod';
import {
  AgentLairAttestationRecorder,
  type AttestationBundle,
} from './lib/agentlair-openai-agents.ts';

const API = process.env.AGENTLAIR_API_BASE ?? 'https://agentlair.dev';

// ─── Mock calendar tools ─────────────────────────────────────────────────────
// These are deterministic so the demo runs without a live LLM and the audit
// chain is reproducible across runs.

const searchAvailability = tool({
  name: 'search_availability',
  description: 'Search calendar slots near a target time.',
  parameters: z.object({
    slot: z.string().describe('ISO 8601 target time, e.g. 2026-05-09T14:00Z'),
  }),
  execute: async ({ slot }: { slot: string }) => {
    const next = (s: string): string => {
      const d = new Date(s);
      d.setUTCHours(d.getUTCHours() + 1);
      return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    };
    const options = [slot, next(slot)];
    return JSON.stringify({ slot, options });
  },
});

const propose = tool({
  name: 'propose',
  description: 'Propose a slot to the counterparty.',
  parameters: z.object({
    slot: z.string().describe('ISO 8601 slot to propose, e.g. 2026-05-09T14:00Z'),
  }),
  execute: async ({ slot }: { slot: string }) => {
    return JSON.stringify({
      proposed_slot: slot,
      status: 'pending_confirmation',
      sent_to: 'counterparty@example.com',
    });
  },
});

// ─── Anonymous registration fallback ─────────────────────────────────────────

interface AccountResolution {
  apiKey: string;
  accountId: string;
  subjectDid: string;
}

async function ensureAccount(): Promise<AccountResolution> {
  let apiKey = process.env.AGENTLAIR_API_KEY;
  if (!apiKey || !apiKey.startsWith('al_')) {
    console.log('No AGENTLAIR_API_KEY set; registering an anonymous account.');
    const r = await fetch(`${API}/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) {
      throw new Error(`POST /v1/register failed: ${r.status} ${await r.text()}`);
    }
    const acc = (await r.json()) as { api_key: string; account_id: string };
    apiKey = acc.api_key;
    console.log(`registered ${acc.account_id} (free tier, anonymous, 100 reqs/day).`);
    console.log('');
  }
  const me = await fetch(`${API}/v1/account/me`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (me.status === 401) {
    throw new Error('AGENTLAIR_API_KEY rejected (401). Register a fresh one or check the value.');
  }
  if (!me.ok) {
    throw new Error(`GET /v1/account/me failed: ${me.status} ${await me.text()}`);
  }
  const meBody = (await me.json()) as { id?: string; account_id?: string };
  const accountId = meBody.id ?? meBody.account_id;
  if (!accountId) {
    throw new Error(`Unexpected /v1/account/me shape: ${JSON.stringify(meBody).slice(0, 200)}`);
  }
  return {
    apiKey: apiKey,
    accountId,
    subjectDid: `did:web:agentlair.dev:agents:${accountId}`,
  };
}

// ─── Demo run ─────────────────────────────────────────────────────────────────

export interface DemoResult {
  subjectDid: string;
  bundle: AttestationBundle;
  toolResults: { search: string; propose: string };
}

export async function runDemo(): Promise<DemoResult> {
  const { apiKey, subjectDid } = await ensureAccount();

  const recorder = new AgentLairAttestationRecorder({
    apiKey,
    subjectDid,
    audience: 'https://calendar.example.com',
    apiBase: API,
    agentName: 'meeting-booker',
  });

  const slot = '2026-05-09T14:00Z';
  const taskPrompt = `book a meeting near ${slot}`;

  // Build the agent the way an OpenAI Agents SDK user would. The wrap()
  // call below replaces every tool's invoke() with one that emits hash-chained
  // audit events to agentlair.dev — without changing tool semantics.
  const meetingBooker = new Agent({
    name: 'meeting-booker',
    instructions: 'Search for a free slot, then propose it to the counterparty.',
    tools: [searchAvailability, propose],
  });
  const governed = recorder.wrap(meetingBooker);

  console.log(`agent      ${subjectDid}`);
  console.log(`task       ${taskPrompt}`);
  console.log('');

  // 1. Attest the agent's reasoning at task start.
  console.log('step 0     reasoning attest (agent.start)');
  await recorder.attestReasoning(taskPrompt);

  // 2. Mock the OpenAI model: invoke each wrapped tool directly with a stub
  //    RunContext. The wrapper records audit events identically whether the
  //    LLM picked the call or we did. This keeps the demo offline and free.
  const runContext = new RunContext();
  const toolDetails = {} as { signal?: AbortSignal };

  console.log('step 1     tool: search_availability');
  const searchTool = governed.tools![0]! as typeof searchAvailability;
  const searchOut = (await searchTool.invoke(
    runContext,
    JSON.stringify({ slot }),
    toolDetails,
  )) as string;
  console.log(`           result: ${searchOut}`);
  console.log('');

  console.log('step 2     tool: propose');
  const proposeTool = governed.tools![1]! as typeof propose;
  const proposeOut = (await proposeTool.invoke(
    runContext,
    JSON.stringify({ slot }),
    toolDetails,
  )) as string;
  console.log(`           result: ${proposeOut}`);
  console.log('');

  // 3. Attest the agent's final output.
  const outcome = {
    slot,
    steps_completed: 2,
    tools_invoked: ['search_availability', 'propose'],
    final: JSON.parse(proposeOut),
  };
  await recorder.attestOutput(outcome);

  console.log(`audit events emitted to agentlair.dev: ${recorder.auditEvents.length}`);
  for (const e of recorder.auditEvents) {
    console.log(`  ${e.id || '(skipped)'.padEnd(20)} ${e.category.padEnd(12)} ${e.action}`);
  }
  console.log('');

  // 4. Issue the BCC summarising the run. The first and last audit event ids
  //    are written into the credential's claim, anchoring the BCC to the
  //    chain so a dispute reviewer can replay the run end-to-end.
  console.log('step 3     issue BCC summarising the run');
  const bundle = await recorder.issueBcc({
    task: 'book_meeting',
    outcome,
    confidence: 0.9,
  });
  console.log('');
  console.log(`bcc        ${bundle.bccId}`);
  console.log(`url        ${bundle.bccUrl}`);
  console.log(`verify     ${bundle.bccVerifyUrl}`);
  console.log('');
  console.log('Anyone can verify, no account needed:');
  console.log(`  curl ${bundle.bccVerifyUrl}`);

  return {
    subjectDid,
    bundle,
    toolResults: { search: searchOut, propose: proposeOut },
  };
}

if (import.meta.main) {
  await runDemo();
}
