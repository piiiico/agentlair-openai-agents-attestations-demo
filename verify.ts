#!/usr/bin/env bun
/**
 * Standalone BCC verifier. Pass a credential id, get back the structured
 * verification result. No account, no key, no payment required.
 *
 * Usage:
 *   bun run verify bcc_xxx
 *   bun run verify https://agentlair.dev/v1/bcc/bcc_xxx
 */

const API = process.env.AGENTLAIR_API_BASE ?? 'https://agentlair.dev';

export interface VerifyResult {
  credential_id: string;
  valid: boolean;
  profile: string;
  stake: { medium: string; amount: number | null; unit: string | null };
  oracle_state: string;
  evidence_chain: Array<{ type: string; ref: string; timestamp: string }>;
  issuer: string;
  subject: string;
  window: { start: string; end: string | null };
}

export async function verifyBcc(idOrUrl: string): Promise<VerifyResult> {
  let id = idOrUrl;
  const m = idOrUrl.match(/(bcc_[A-Za-z0-9_-]+)/);
  if (m) id = m[1]!;
  if (!id.startsWith('bcc_')) {
    throw new Error(`Invalid BCC id: ${idOrUrl}. Expected bcc_xxx or full URL.`);
  }
  const url = `${API}/v1/bcc/${id}/verify`;
  const res = await fetch(url);
  if (res.status === 404) {
    throw new Error(`BCC ${id} not found. The id may be wrong or the credential was issued against a different worker.`);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as VerifyResult;
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: bun run verify <bcc_id_or_url>');
    process.exit(1);
  }
  const r = await verifyBcc(arg);
  console.log(`credential ${r.credential_id}`);
  console.log(`valid      ${r.valid}`);
  console.log(`profile    ${r.profile}`);
  console.log(`oracle     ${r.oracle_state}`);
  console.log(`issuer     ${r.issuer}`);
  console.log(`subject    ${r.subject}`);
  console.log(`window     ${r.window.start} -> ${r.window.end ?? '(open)'}`);
  console.log(`evidence   ${r.evidence_chain.length} step(s)`);
  for (const e of r.evidence_chain) {
    console.log(`           ${e.type.padEnd(13)} ${e.ref}`);
  }
  if (!r.valid) process.exit(1);
}
