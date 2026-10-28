/**
 * Server-side Ultravox call configuration, exercised through the real HTTP
 * route with a fake provider fetch.
 *
 * Proves what the server actually sends (prompt, output medium, first speaker,
 * optional language hint) and that the API key never reaches the response.
 * It does NOT prove the model's language behaviour; that requires real calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrototype2Server } from '../server';

process.env.ULTRAVOX_API_KEY = 'test-ultravox-key';

const post = async (base: string, path: string, body: unknown, key?: string) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const createSession = async (base: string, label: string) => {
  const created = await post(base, '/api/sessions', { label });
  assert.equal(created.status, 201);
  const inviteToken = decodeURIComponent(String(created.body.inviteUrl).split('invite=')[1]);
  const redeemed = await post(base, '/api/invitations/redeem', { inviteToken });
  assert.equal(redeemed.status, 200);
  return {
    sessionId: String(created.body.sessionId),
    customerKey: String(redeemed.body.customerKey),
  };
};

test('the server sends the multilingual prompt and only an operator-configured language hint', async (t) => {
  const bodies: any[] = [];
  const ultravoxFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(
      JSON.stringify({
        callId: `call_${bodies.length}`,
        joinUrl: `wss://ai.invalid/join-${bodies.length}?token=secret`,
        model: 'ultravox-v0.7',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxFetch,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const previousHint = process.env.ULTRAVOX_LANGUAGE_HINT;
  t.after(async () => {
    await server.close();
    if (previousHint === undefined) delete process.env.ULTRAVOX_LANGUAGE_HINT;
    else process.env.ULTRAVOX_LANGUAGE_HINT = previousHint;
  });

  // 1. No hint configured: no language is forced.
  delete process.env.ULTRAVOX_LANGUAGE_HINT;
  const first = await createSession(base, 'no-hint');
  const created = await post(
    base,
    `/api/sessions/${first.sessionId}/ultravox-call`,
    {},
    first.customerKey
  );
  assert.equal(created.status, 200);
  assert.equal(JSON.stringify(created.body).includes('test-ultravox-key'), false);
  const noHint = bodies.at(-1);
  assert.equal('languageHint' in noHint, false);
  assert.equal(noHint.initialOutputMedium, 'MESSAGE_MEDIUM_TEXT');
  assert.equal(noHint.firstSpeaker, 'FIRST_SPEAKER_USER');
  assert.match(noHint.systemPrompt, /reply in the language the customer clearly used/i);
  assert.match(noHint.systemPrompt, /code-switch/i);
  assert.match(noHint.systemPrompt, /never force a translation/i);

  // 2. A valid operator hint is forwarded exactly.
  process.env.ULTRAVOX_LANGUAGE_HINT = 'es-MX';
  const second = await createSession(base, 'hint');
  const withHint = await post(
    base,
    `/api/sessions/${second.sessionId}/ultravox-call`,
    {},
    second.customerKey
  );
  assert.equal(withHint.status, 200);
  assert.equal(bodies.at(-1).languageHint, 'es-MX');

  // 3. An invalid hint is ignored rather than sent to the provider.
  process.env.ULTRAVOX_LANGUAGE_HINT = 'not_a_language';
  const third = await createSession(base, 'bad-hint');
  const withoutHint = await post(
    base,
    `/api/sessions/${third.sessionId}/ultravox-call`,
    {},
    third.customerKey
  );
  assert.equal(withoutHint.status, 200);
  assert.equal('languageHint' in bodies.at(-1), false);
});
