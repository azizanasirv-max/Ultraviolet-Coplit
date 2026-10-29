/**
 * Tests for the server-side self-hosted AI provider client.
 *
 * These are pure unit tests with an injected `fetch`: no network, no Modal, no
 * model. They prove configuration parsing, URL/host validation, error mapping
 * and that secrets/URLs are redacted. They do NOT prove that a deployed Modal
 * service answers or that audio streams.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiServiceError,
  aiServiceReadiness,
  createAiCall,
  endAiCallQuietly,
  resolveAiServiceSettings,
  sanitizeAiCallId,
  sanitizeProviderDetail,
} from '../server/aiService';

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

const settings = resolveAiServiceSettings(
  env({ AI_SERVICE_URL: 'https://sales--ai.modal.run', AI_SERVICE_TOKEN: 'service-token' })
);

interface Captured {
  url: string;
  init: RequestInit;
}

const fakeFetch = (respond: (captured: Captured) => Response | Promise<Response>) => {
  const calls: Captured[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
  return { impl, calls };
};

test('configuration requires an https Modal URL and a server-side token', () => {
  assert.ok(settings);
  assert.equal(settings?.baseUrl, 'https://sales--ai.modal.run');
  assert.equal(settings?.joinHost, 'sales--ai.modal.run');
  assert.equal(settings?.maxCallSeconds, 3600);

  assert.equal(resolveAiServiceSettings(env({})), null);
  assert.equal(
    resolveAiServiceSettings(env({ AI_SERVICE_URL: 'https://x.modal.run' })),
    null,
    'a token is required'
  );
  assert.equal(
    resolveAiServiceSettings(env({ AI_SERVICE_URL: 'MY_AI_SERVICE_URL', AI_SERVICE_TOKEN: 't' })),
    null,
    'placeholders are not configuration'
  );
  assert.equal(
    resolveAiServiceSettings(env({ AI_SERVICE_URL: 'http://x.modal.run', AI_SERVICE_TOKEN: 't' })),
    null,
    'plain http is refused outside localhost'
  );
  assert.equal(
    resolveAiServiceSettings(env({ AI_SERVICE_URL: 'not a url', AI_SERVICE_TOKEN: 't' })),
    null
  );
  assert.ok(
    resolveAiServiceSettings(
      env({ AI_SERVICE_URL: 'http://localhost:8000', AI_SERVICE_TOKEN: 't' })
    ),
    'localhost http is allowed for local development'
  );
});

test('call duration is clamped to one hour', () => {
  const withSeconds = (value: string) =>
    resolveAiServiceSettings(
      env({ AI_SERVICE_URL: 'https://x.modal.run', AI_SERVICE_TOKEN: 't', AI_MAX_CALL_SECONDS: value })
    )?.maxCallSeconds;
  assert.equal(withSeconds('99999'), 3600);
  assert.equal(withSeconds('600'), 600);
  assert.equal(withSeconds('abc'), 3600);
});

test('readiness reports missing variable names and never a value', () => {
  const ready = aiServiceReadiness(
    env({ AI_SERVICE_URL: 'https://x.modal.run', AI_SERVICE_TOKEN: 'super-secret-token' })
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.provider, 'modal-self-hosted');
  assert.deepEqual(ready.missing, []);
  assert.ok(!JSON.stringify(ready).includes('super-secret-token'));

  const missing = aiServiceReadiness(env({}));
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ['AI_SERVICE_URL', 'AI_SERVICE_TOKEN']);
  assert.match(missing.message, /Human-to-human audio is unaffected/i);
});

test('a created call is validated, bounded and uses the service token', async () => {
  assert.ok(settings);
  const expiresAt = Date.now() + 60_000;
  const { impl, calls } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          callId: 'call_abc123',
          joinUrl: 'wss://sales--ai.modal.run/v1/stream?call_id=call_abc123&sig=x',
          model: 'small.en+Qwen2.5-3B-Instruct',
          expiresAt,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );

  const call = await createAiCall(impl, settings!, {
    sessionId: 'session-1',
    systemPrompt: 'Be helpful.',
  });

  assert.equal(call.callId, 'call_abc123');
  assert.equal(call.model, 'small.en+Qwen2.5-3B-Instruct');
  assert.equal(call.expiresAt, expiresAt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sales--ai.modal.run/v1/calls');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer service-token');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.sessionId, 'session-1');
  assert.equal(body.systemPrompt, 'Be helpful.');
  assert.equal(body.maxDurationSeconds, 3600);
});

test('a join URL on another host is rejected', async () => {
  assert.ok(settings);
  const { impl } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({ callId: 'call_1', joinUrl: 'wss://attacker.example/stream' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );

  await assert.rejects(
    createAiCall(impl, settings!, { sessionId: 's', systemPrompt: 'p' }),
    (error: unknown) =>
      error instanceof AiServiceError && error.code === 'AI_SERVICE_INVALID_RESPONSE'
  );
});

test('provider failures are mapped to stable codes and redacted', async () => {
  assert.ok(settings);
  const { impl } = fakeFetch(
    () =>
      new Response('upstream error for wss://sales--ai.modal.run/stream?token=super-secret', {
        status: 503,
      })
  );

  await assert.rejects(
    createAiCall(impl, settings!, { sessionId: 's', systemPrompt: 'p' }),
    (error: unknown) => {
      assert.ok(error instanceof AiServiceError);
      assert.equal(error.code, 'AI_SERVICE_ERROR');
      assert.equal(error.status, 503);
      assert.ok(error.detail && !error.detail.includes('super-secret'));
      assert.ok(!error.message.includes('super-secret'));
      return true;
    }
  );
});

test('an unreachable service is reported without leaking the URL', async () => {
  assert.ok(settings);
  const impl = (async () => {
    throw new Error('connect ECONNREFUSED https://sales--ai.modal.run/v1/calls?token=secret');
  }) as unknown as typeof fetch;

  await assert.rejects(
    createAiCall(impl, settings!, { sessionId: 's', systemPrompt: 'p' }),
    (error: unknown) => {
      assert.ok(error instanceof AiServiceError);
      assert.equal(error.code, 'AI_SERVICE_UNREACHABLE');
      assert.equal(error.status, 502);
      assert.ok(!(error as Error).message.includes('secret'));
      return true;
    }
  );
});

test('an unreadable payload is rejected', async () => {
  assert.ok(settings);
  const { impl } = fakeFetch(() => new Response('not json', { status: 200 }));
  await assert.rejects(
    createAiCall(impl, settings!, { sessionId: 's', systemPrompt: 'p' }),
    (error: unknown) =>
      error instanceof AiServiceError && error.code === 'AI_SERVICE_INVALID_RESPONSE'
  );
});

test('a superseded call is deleted, invalid ids are ignored', async () => {
  assert.ok(settings);
  const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));

  assert.equal(await endAiCallQuietly(impl, settings!, 'call_abc123'), true);
  assert.equal(calls[0].url, 'https://sales--ai.modal.run/v1/calls/call_abc123');
  assert.equal(calls[0].init.method, 'DELETE');

  assert.equal(await endAiCallQuietly(impl, settings!, 'call id with spaces'), false);
  assert.equal(calls.length, 1, 'an invalid call id must not reach the service');
});

test('call ids and provider details are sanitised', () => {
  assert.equal(sanitizeAiCallId('call_abc-1:2'), 'call_abc-1:2');
  assert.equal(sanitizeAiCallId('call id'), null);
  assert.equal(sanitizeAiCallId('x'.repeat(101)), null);
  assert.equal(sanitizeAiCallId(42), null);

  const detail = sanitizeProviderDetail('failed token=abc123 at https://x.modal.run/a');
  assert.ok(detail);
  assert.ok(!detail.includes('abc123'));
  assert.ok(!detail.includes('https://'));
});

