/**
 * Browser-level Prototype 2 tests (Chromium, synthetic media).
 *
 * These drive the real UI and the real RTCPeerConnection stack in two isolated
 * browser contexts (two "devices"). Chromium's fake audio device supplies the
 * media, so this validates signaling, negotiation, track routing and playback
 * plumbing — NOT physical-device acoustics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import WebSocket from 'ws';

process.env.NODE_ENV = 'production';
process.env.ULTRAVOX_API_KEY = 'test-ultravox-key';

/** Chromium's shared libraries were unpacked locally (no root in this sandbox). */
const collectLibraryDirs = (): string[] => {
  const root = path.join(process.cwd(), '.browser-libs', 'root');
  const dirs = new Set<string>();
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes('.so')) dirs.add(dir);
    }
  };
  walk(root);
  return [...dirs];
};

const libDirs = collectLibraryDirs();
if (libDirs.length > 0) {
  process.env.LD_LIBRARY_PATH = [...libDirs, process.env.LD_LIBRARY_PATH || '']
    .filter(Boolean)
    .join(':');
}

// Chromium's font stack needs a config file when fontconfig is not installed
// system-wide (this sandbox has no root).
const fontConfig = path.join(process.cwd(), '.browser-libs', 'fonts.conf');
if (fs.existsSync(fontConfig)) process.env.FONTCONFIG_FILE = fontConfig;

// Imported after NODE_ENV is set so the server serves the production build.
const { createPrototype2Server } = await import('../server');

// Never contact the real Ultravox API from automated tests.
let ultravoxCallRequests = 0;
const fakeUltravoxFetch = (async () => {
  ultravoxCallRequests += 1;
  return new Response(
    JSON.stringify({
      callId: `call_browser_${ultravoxCallRequests}`,
      joinUrl: 'wss://ai.invalid/join',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}) as unknown as typeof fetch;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const snapshot = async (page: Page) =>
  page.evaluate(() => (window as any).__prototype2?.getSnapshot() ?? null);

const waitFor = async <T>(fn: () => Promise<T | null>, predicate: (value: T) => boolean, timeoutMs = 20000) => {
  const started = Date.now();
  let last: T | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last && predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
};

const openContext = async (
  browser: Browser,
  options: { delayIceMs?: number } = {}
): Promise<BrowserContext> => {
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addInitScript(() => {
    // esbuild/tsx keepNames can emit `__name(...)` in evaluated functions.
    if (typeof (window as any).__name !== 'function') (window as any).__name = (fn: any) => fn;
    const Original = window.RTCPeerConnection;
    (window as any).__pcs = [];
    (window as any).RTCPeerConnection = function (...args: any[]) {
      const pc = new (Original as any)(...args);
      (window as any).__pcs.push(pc);
      return pc;
    };
    (window as any).RTCPeerConnection.prototype = Original.prototype;

    // Count outgoing signaling messages without changing their content.
    const OriginalWs = window.WebSocket;
    (window as any).__wsSent = [];
    const Wrapped = function (url: string, protocols?: string | string[]) {
      const socket = protocols === undefined ? new OriginalWs(url) : new OriginalWs(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        try {
          const parsed = JSON.parse(String(data));
          (window as any).__wsSent.push(parsed.type);
        } catch {
          // Ignore non-JSON payloads.
        }
        return send(data);
      };
      (window as any).__ws = socket;
      return socket;
    } as any;
    Wrapped.prototype = OriginalWs.prototype;
    Wrapped.CONNECTING = 0;
    Wrapped.OPEN = 1;
    Wrapped.CLOSING = 2;
    Wrapped.CLOSED = 3;
    (window as any).WebSocket = Wrapped;
  });
  if (options.delayIceMs) {
    // Hold trickled candidates so ICE setup stays in `connecting` long enough
    // for the server's presence updates to arrive (the original defect window).
    await context.routeWebSocket(/\/ws(?:\?.*)?$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        let text = '';
        try {
          text = typeof message === 'string' ? message : Buffer.from(message as any).toString();
        } catch {
          // Ignore binary decode errors.
        }
        if (text.includes('"type":"ice_candidate"')) {
          setTimeout(() => {
            try {
              ws.send(message);
            } catch {
              // Socket closed.
            }
          }, options.delayIceMs);
        } else {
          ws.send(message);
        }
      });
    });
  }
  return context;
};

/**
 * Reads the invitation link and returns to the dashboard. A fresh visit opens
 * the separate invitation screen; creating an invitation never disturbs a call.
 */
const readInvitationAndOpenDashboard = async (page: Page): Promise<string> => {
  await page.waitForSelector('[data-testid="role-salesperson"]', { timeout: 20000 });
  if ((await page.locator('[data-testid="back-to-dashboard"]').count()) === 0) {
    await page.waitForSelector('[data-testid="show-invitation"]', { timeout: 20000 });
    await page.click('[data-testid="show-invitation"]');
    await page.waitForSelector('[data-testid="salesperson-invite-url"]', { timeout: 20000 });
  }
  const inviteUrl = await page.inputValue('[data-testid="salesperson-invite-url"]');
  await page.click('[data-testid="back-to-dashboard"]');
  await page.waitForSelector('[data-testid="join-call"]', { timeout: 20000 });
  return inviteUrl;
};

const launchBrowser = (): Promise<Browser> =>
  chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

test('prototype2 role-specific interfaces', async (t) => {
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const salesContext = await openContext(browser);
  const salesPage = await salesContext.newPage();
  await salesPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  await salesPage.waitForSelector('[data-testid="salesperson-invitation"]', { timeout: 20000 });

  await t.test('salesperson sees only the salesperson interface', async () => {
    assert.equal(await salesPage.locator('[data-testid="role-salesperson"]').count(), 1);
    assert.equal(await salesPage.locator('[data-testid="role-customer"]').count(), 0);
    assert.equal(await salesPage.getByText('Prototype 1 (Engine Test)').count(), 0);

    const inviteUrl = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
    assert.match(inviteUrl, /\/join\?invite=[A-Za-z0-9_-]{40,}$/);
    // The invitation lives on its own screen with copy + back actions.
    assert.equal(await salesPage.locator('[data-testid="copy-invite"]').count(), 1);
    assert.equal(await salesPage.locator('[data-testid="back-to-dashboard"]').count(), 1);
    assert.equal(await salesPage.locator('[data-testid="join-call"]').count(), 0);
  });

  const inviteUrl = await readInvitationAndOpenDashboard(salesPage);
  const customerContext = await openContext(browser);
  const customerPage = await customerContext.newPage();
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

  await t.test('customer sees only the customer interface', async () => {
    assert.equal(await customerPage.locator('[data-testid="role-customer"]').count(), 1);
    assert.equal(await customerPage.locator('[data-testid="role-salesperson"]').count(), 0);
    assert.equal(await customerPage.getByText('Prototype 1 (Engine Test)').count(), 0);
    assert.equal(await customerPage.getByText('AI copilot responses').count(), 0);

    // No AI status, AI-listening indicators, suggestions or private diagnostics.
    const text = (await customerPage.textContent('[data-testid="role-customer"]')) || '';
    assert.doesNotMatch(text, /AI heard|AI suggested|AI session|AI assistant|suggestion|diagnostic|sales note/i);
    assert.equal(await customerPage.locator('[data-testid="ai-suggestions"]').count(), 0);
    assert.equal(await customerPage.locator('[data-testid="ai-suggestion-latest"]').count(), 0);
    assert.equal(await customerPage.locator('[data-testid="diagnostics-panel"]').count(), 0);
    assert.equal(await customerPage.locator('[data-testid="captions-status"]').count(), 0);
  });

  await t.test('the invitation resolves to the salesperson\'s session', async () => {
    const salespersonSession = await salesPage.evaluate(
      () => JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}').sessionId as string
    );
    const customerSession = await customerPage.evaluate(() =>
      (window as any).__prototype2?.getSessionId()
    );
    assert.equal(customerSession, salespersonSession);
  });

  await t.test('a consumed invitation link cannot be used by another browser', async () => {
    const intruderContext = await openContext(browser);
    const intruderPage = await intruderContext.newPage();
    await intruderPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
    await intruderPage.waitForSelector('[data-testid="role-customer-invalid"]', { timeout: 20000 });
    assert.match((await intruderPage.textContent('[data-testid="role-customer-invalid"]')) || '', /already been used/i);
    await intruderContext.close();
  });

  await t.test('a query parameter cannot authorize a customer or salesperson', async () => {
    const legacyContext = await openContext(browser);
    const legacyPage = await legacyContext.newPage();
    await legacyPage.goto(`${base}/?prototype=2&room=main&role=customer`, { waitUntil: 'domcontentloaded' });
    await legacyPage.waitForSelector('[data-testid="role-customer-invalid"]', { timeout: 20000 });
    assert.equal(await legacyPage.locator('[data-testid="customer-prejoin"]').count(), 0);

    const bogusPage = await legacyContext.newPage();
    await bogusPage.goto(`${base}/join?invite=made-up-token`, { waitUntil: 'domcontentloaded' });
    await bogusPage.waitForSelector('[data-testid="role-customer-invalid"]', { timeout: 20000 });
    await legacyContext.close();
  });

  await salesContext.close();
  await customerContext.close();
});

test('prototype2 three-path audio with synthetic media', async (t) => {
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const salespersonContext = await openContext(browser);
  const customerContext = await openContext(browser);
  const salespersonPage = await salespersonContext.newPage();
  const customerPage = await customerContext.newPage();

  const consoleErrors: string[] = [];
  for (const page of [salespersonPage, customerPage]) {
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
  }

  await salespersonPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  const inviteUrl = await readInvitationAndOpenDashboard(salespersonPage);

  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

  // The salesperson joins first and waits; negotiation starts when the customer
  // arrives. This exercises the offerer/answerer policy end to end.
  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');

  const connected = await waitFor(
    () => snapshot(salespersonPage),
    (value) =>
      value.callState === 'connected' &&
      value.diagnostics.bytesSent > 0 &&
      value.diagnostics.bytesReceived > 0 &&
      value.diagnostics.localSenderCount === 1,
    30000
  );

  await t.test('salesperson sends audio to the customer and receives customer audio', async () => {
    assert.equal(connected.diagnostics.localSenderCount, 1);
    assert.equal(connected.diagnostics.remoteTrackState, 'live');
    assert.ok(connected.diagnostics.bytesSent > 0, 'salesperson must send RTP');
    assert.ok(connected.diagnostics.bytesReceived > 0, 'salesperson must receive RTP');
    assert.equal(connected.diagnostics.candidates.relay >= 0, true);

    const salespersonAudio = await salespersonPage.evaluate(() => {
      const element = document.querySelector('audio') as HTMLAudioElement;
      return {
        paused: element.paused,
        muted: element.muted,
        hasStream: Boolean(element.srcObject),
        pcCount: (window as any).__pcs.length,
        openPcs: (window as any).__pcs.filter((pc: any) => pc.connectionState !== 'closed').length,
        senderTracks: (window as any).__pcs[0]
          .getSenders()
          .filter((sender: any) => sender.track)
          .map((sender: any) => sender.track.kind),
      };
    });
    assert.equal(salespersonAudio.paused, false, 'remote audio must be playing');
    assert.equal(salespersonAudio.muted, false);
    assert.equal(salespersonAudio.hasStream, true);
    assert.equal(salespersonAudio.openPcs, 1);
    assert.deepEqual(salespersonAudio.senderTracks, ['audio']);
  });

  await t.test('customer sends audio to the salesperson and receives salesperson audio', async () => {
    const customer = await waitFor(
      () => snapshot(customerPage),
      (value) => value.callState === 'connected' && value.diagnostics.bytesSent > 0 && value.diagnostics.bytesReceived > 0,
      30000
    );
    assert.equal(customer.diagnostics.localSenderCount, 1);
    assert.equal(customer.diagnostics.remoteTrackState, 'live');

    const customerAudio = await customerPage.evaluate(() => {
      const element = document.querySelector('audio') as HTMLAudioElement;
      return {
        paused: element.paused,
        muted: element.muted,
        hasStream: Boolean(element.srcObject),
        openPcs: (window as any).__pcs.filter((pc: any) => pc.connectionState !== 'closed').length,
        audioElements: document.querySelectorAll('audio').length,
      };
    });
    assert.equal(customerAudio.paused, false);
    assert.equal(customerAudio.muted, false);
    assert.equal(customerAudio.hasStream, true);
    assert.equal(customerAudio.openPcs, 1);
    assert.equal(customerAudio.audioElements, 1);
  });

  await t.test('mute stops the outbound track while the call stays connected', async () => {
    await customerPage.click('[data-testid="mic-toggle"]');
    const muted = await waitFor(() => snapshot(customerPage), (value) => value.micMuted === true, 5000);
    assert.equal(muted.diagnostics.localTrackState.includes('disabled'), true);

    const senderEnabled = await customerPage.evaluate(() => {
      const pc = (window as any).__pcs.find((item: any) => item.connectionState !== 'closed');
      return pc.getSenders().filter((sender: any) => sender.track).map((sender: any) => sender.track.enabled);
    });
    assert.deepEqual(senderEnabled, [false]);
    assert.equal((await snapshot(salespersonPage)).callState, 'connected');

    await customerPage.click('[data-testid="mic-toggle"]');
    const unmuted = await waitFor(() => snapshot(customerPage), (value) => value.micMuted === false, 5000);
    assert.equal(unmuted.diagnostics.localTrackState.includes('disabled'), false);
  });

  await t.test('salesperson mute does not mute the customer and is reversible', async () => {
    await salespersonPage.click('[data-testid="mic-toggle"]');
    const muted = await waitFor(() => snapshot(salespersonPage), (value) => value.micMuted === true, 5000);
    assert.equal(muted.diagnostics.localTrackState.includes('disabled'), true);
    const customer = await snapshot(customerPage);
    assert.equal(customer.micMuted, false);
    await salespersonPage.click('[data-testid="mic-toggle"]');
    await waitFor(() => snapshot(salespersonPage), (value) => value.micMuted === false, 5000);
  });

  await t.test('AI session failure is isolated from the human audio path and visible to the salesperson', async () => {
    // No reachable Ultravox in this environment: the customer AI request must
    // fail visibly, while peer audio keeps flowing.
    const customer = await snapshot(customerPage);
    assert.ok(
      ['off', 'creating', 'reconnecting', 'error', 'connecting', 'disconnected', 'closed', 'idle'].includes(
        String(customer.aiStatus)
      ),
      `unexpected AI status ${customer.aiStatus}`
    );
    assert.equal(customer.ai.connected, false, 'the dashboard must not claim a live AI session');
    const salesperson = await snapshot(salespersonPage);
    assert.equal(salesperson.callState, 'connected');
    assert.ok(salesperson.diagnostics.bytesSent > 0);
    assert.equal(salesperson.ai.connected, false, 'salesperson also sees a non-connected AI');
    assert.ok(
      ['creating', 'connecting', 'reconnecting', 'error', 'disconnected', 'closed', 'off'].includes(
        String(salesperson.ai.state)
      )
    );

    // The salesperson dashboard surfaces the AI state and failure explanation.
    await salespersonPage.waitForSelector('[data-testid="ai-state"]', { timeout: 10000 });
    const chip = (await salespersonPage.textContent('[data-testid="ai-state-chip"]')) || '';
    assert.doesNotMatch(chip, /AI connected/);
    const panel = (await salespersonPage.textContent('[data-testid="ai-panel"]')) || '';
    assert.match(panel, /AI/);
    const aiStateText = (await salespersonPage.textContent('[data-testid="ai-state"]')) || '';
    assert.ok(
      /Creating AI session|Connecting AI|Reconnecting AI|AI error|AI disconnected|AI session closed|AI not started/.test(
        aiStateText
      ),
      `unexpected salesperson AI label: ${aiStateText}`
    );
  });

  await t.test('a salesperson AI restart requests a fresh call without interrupting the audio call', async () => {
    const before = await snapshot(salespersonPage);
    assert.equal(before.callState, 'connected');
    const callsBefore = ultravoxCallRequests;

    await salespersonPage.click('[data-testid="ai-reconnect"]');
    await waitFor(
      () => Promise.resolve(ultravoxCallRequests > callsBefore),
      (advanced) => advanced === true,
      15000
    );

    // A genuinely new Ultravox call was requested (replace=true path).
    assert.ok(ultravoxCallRequests > callsBefore, 'a new AI call was requested');

    // The human call is untouched by the AI restart.
    const after = await snapshot(salespersonPage);
    assert.equal(after.callState, 'connected');
    assert.equal(after.participantId, before.participantId);
    assert.equal(after.peerParticipantId, before.peerParticipantId);
    assert.ok(after.diagnostics.bytesReceived > 0);
  });

  await t.test('reconnect replaces the connection without duplicating participants or tracks', async () => {
    const before = await snapshot(customerPage);
    await customerPage.click('[data-testid="reconnect"]');
    // The engine stops the old call first; wait until it has actually left.
    await waitFor(() => snapshot(customerPage), (value) => value.callState !== 'connected', 10000);
    const after = await waitFor(
      () => snapshot(customerPage),
      (value) =>
        value.callState === 'connected' &&
        value.diagnostics.bytesSent > 0 &&
        value.diagnostics.bytesReceived > 0 &&
        Boolean(value.participantId),
      30000
    );
    assert.equal(after.participantId, before.participantId, 'identity must survive reconnect');

    const pageState = await customerPage.evaluate(() => ({
      openPcs: (window as any).__pcs.filter((pc: any) => pc.connectionState !== 'closed').length,
      audioElements: document.querySelectorAll('audio').length,
      senderTracks: (window as any).__pcs
        .filter((pc: any) => pc.connectionState !== 'closed')
        .flatMap((pc: any) => pc.getSenders().filter((sender: any) => sender.track).map(() => 1)).length,
    }));
    assert.equal(pageState.openPcs, 1, 'exactly one live peer connection after reconnect');
    assert.equal(pageState.audioElements, 1);
    assert.equal(pageState.senderTracks, 1, 'exactly one live audio sender after reconnect');

    const salespersonKey = await salespersonPage.evaluate(
      () => JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}').salespersonKey as string
    );
    const sessionId = await salespersonPage.evaluate(
      () => JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}').sessionId as string
    );
    const response = await fetch(`${base}/api/sessions/${sessionId}/diagnostics`, {
      headers: { Authorization: `Bearer ${salespersonKey}` },
    });
    const diagnostics = await response.json();
    assert.equal(diagnostics.diagnostics.participants.length, 2, 'no duplicate participants');
    const roles = diagnostics.diagnostics.participants.map((participant: any) => participant.role).sort();
    assert.deepEqual(roles, ['customer', 'salesperson']);
  });

  await t.test('AI response text reaches this salesperson dashboard', async () => {
    // The customer leaves so a protocol-level customer connection can stand in
    // for the Ultravox agent. This exercises the real server route and the real
    // salesperson UI render path (text relay: customer -> server -> dashboard).
    await customerPage.click('[data-testid="leave-call"]');
    await sleep(400);

    const inviteToken = decodeURIComponent(inviteUrl.split('invite=')[1]);
    const customerKey = await customerPage.evaluate(
      (token) =>
        JSON.parse(sessionStorage.getItem(`sc.prototype2.customer.${token}`) || '{}').customerKey as string,
      inviteToken
    );
    const sessionId = await salespersonPage.evaluate(
      () => JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}').sessionId as string
    );

    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'join', sessionId, role: 'customer', credential: customerKey }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('join ack timeout')), 5000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'joined') {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    socket.send(
      JSON.stringify({
        type: 'ai_suggestion',
        sessionId,
        text: 'TEST-AI-SUGGESTION-123: ask about the renewal date.',
        isFinal: true,
        ordinal: 7,
        timestamp: '10:00',
      })
    );

    await salespersonPage.waitForFunction(
      () =>
        document.querySelector('[data-testid="ai-suggestion-latest"]')?.textContent?.includes('TEST-AI-SUGGESTION-123'),
      { timeout: 8000 }
    );
    const rendered = await salespersonPage.textContent('[data-testid="ai-suggestion-latest"]');
    assert.match(rendered || '', /renewal date/);
    socket.close();
  });

  await t.test('server receives client diagnostics from the salesperson', async () => {
    await sleep(5500);
    const salespersonKey = await salespersonPage.evaluate(
      () => JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}').salespersonKey as string
    );
    const sessionId = await salespersonPage.evaluate(
      () => JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}').sessionId as string
    );
    const response = await fetch(`${base}/api/sessions/${sessionId}/diagnostics`, {
      headers: { Authorization: `Bearer ${salespersonKey}` },
    });
    const diagnostics = await response.json();
    const salespersonDiagnostics = diagnostics.diagnostics.participants.find(
      (participant: any) => participant.role === 'salesperson'
    );
    assert.ok(salespersonDiagnostics?.diagnostics, 'salesperson must report diagnostics');
    assert.equal(salespersonDiagnostics.diagnostics.micPermission, 'granted');
    assert.equal(salespersonDiagnostics.diagnostics.wsStatus, 'connected');
    assert.ok(diagnostics.diagnostics.signals.offers > 0);
    assert.ok(diagnostics.diagnostics.signals.answers > 0);
    assert.ok(diagnostics.diagnostics.signals.iceCandidates > 0);
    assert.equal(diagnostics.diagnostics.signals.rejectedMessages, 0);
  });

  await t.test('no unexpected page errors were logged', async () => {
    const relevant = consoleErrors.filter(
      (text) => !/favicon|Ultravox|Failed to load resource|net::ERR/i.test(text)
    );
    assert.deepEqual(relevant, []);
  });

  await salespersonContext.close();
  await customerContext.close();
});

// ---------------------------------------------------------------------------
// TURN configuration path (Chromium + a mock TURN endpoint; no real relay)
//
// The TURN URLs below intentionally point at .invalid. These tests prove the
// client fetches the session-authenticated config, applies it to the peer
// connection, applies relay-only policy, and refuses to start when relay-only
// mode is misconfigured. They do NOT prove a real relay carries media.
// ---------------------------------------------------------------------------

const ICE_ENV_KEYS = [
  'TURN_URLS',
  'TURN_USERNAME',
  'TURN_CREDENTIAL',
  'TURN_SECRET',
  'ICE_TRANSPORT_POLICY',
  'STUN_URLS',
] as const;

const applyIceEnv = (values: Partial<Record<(typeof ICE_ENV_KEYS)[number], string | null>>) => {
  const saved: Record<string, string | undefined> = {};
  for (const key of ICE_ENV_KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ICE_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
};

test('prototype2 a rotated invitation starts a fresh AI call', async (t) => {
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const salesContext = await openContext(browser);
  const salesPage = await salesContext.newPage();
  await salesPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  await salesPage.waitForSelector('[data-testid="salesperson-invitation"]', { timeout: 20000 });
  const firstInvite = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
  await salesPage.click('[data-testid="back-to-dashboard"]');
  // Join the session on the salesperson device (offerer) before the customer.
  await salesPage.click('[data-testid="join-call"]');
  await waitFor(() => snapshot(salesPage), (value) => value.wsStatus === 'connected', 20000);

  // First customer establishes the human call and requests an AI call.
  const firstContext = await openContext(browser);
  const firstPage = await firstContext.newPage();
  await firstPage.goto(firstInvite, { waitUntil: 'domcontentloaded' });
  await firstPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });
  await firstPage.click('[data-testid="join-call"]');
  const firstConnected = await waitFor(
    () => snapshot(firstPage),
    (value) =>
      value.callState === 'connected' && value.diagnostics.bytesSent > 0 && Boolean(value.ai.callId),
    30000
  );
  const firstCallId = firstConnected.ai.callId;
  assert.ok(firstCallId, 'the first customer requested an AI call');

  // The customer leaves; rotate the invitation for a new device. The invitation
  // lives on its own screen in the merged UI.
  await firstContext.close();
  await waitFor(() => snapshot(salesPage), (value) => value.callState !== 'connected', 15000);

  await salesPage.click('[data-testid="show-invitation"]');
  await salesPage.waitForSelector('[data-testid="salesperson-invite-url"]', { timeout: 20000 });
  const previousInvite = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
  const callsBeforeRotation = ultravoxCallRequests;
  await salesPage.click('[data-testid="regenerate-invite"]');
  await salesPage.waitForFunction(
    (oldUrl) => {
      const input = document.querySelector('[data-testid="salesperson-invite-url"]') as HTMLInputElement | null;
      return Boolean(input && input.value && input.value !== oldUrl);
    },
    previousInvite,
    { timeout: 10000 }
  );
  const secondInvite = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
  assert.notEqual(secondInvite, previousInvite);
  await salesPage.click('[data-testid="back-to-dashboard"]');

  // A brand new invitation must produce its own AI session, not reuse the dead one.
  const secondContext = await openContext(browser);
  t.after(() => secondContext.close());
  const secondPage = await secondContext.newPage();
  await secondPage.goto(secondInvite, { waitUntil: 'domcontentloaded' });
  await secondPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });
  await secondPage.click('[data-testid="join-call"]');

  const secondConnected = await waitFor(
    () => snapshot(secondPage),
    (value) =>
      value.callState === 'connected' &&
      value.diagnostics.bytesSent > 0 &&
      Boolean(value.ai.callId) &&
      value.ai.callId !== firstCallId,
    30000
  );
  assert.notEqual(secondConnected.ai.callId, firstCallId, 'a new AI call was created');
  assert.ok(ultravoxCallRequests > callsBeforeRotation, 'the server created another Ultravox call');
  assert.equal(secondConnected.ai.connected, false, 'unreachable provider is not reported as connected');

  // The salesperson dashboard reflects the new session and keeps human audio.
  const salesState = await waitFor(
    () => snapshot(salesPage),
    (value) => value.callState === 'connected' && value.diagnostics.bytesReceived > 0,
    20000
  );
  assert.equal(salesState.callState, 'connected');
  assert.notEqual(salesState.ai.connected, true);
});


test('TURN configuration is fetched with session auth and applied to every peer connection', async asyncTest => {
  const restoreEnv = applyIceEnv({
    TURN_URLS: 'turn:turn.invalid:3478?transport=udp,turns:turn.invalid:5349?transport=tcp',
    TURN_USERNAME: 'mock-turn-user',
    TURN_CREDENTIAL: 'mock-turn-pass',
    TURN_SECRET: null,
    ICE_TRANSPORT_POLICY: 'all',
    STUN_URLS: null,
  });
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  asyncTest.after(async () => {
    await browser.close();
    await server.close();
    restoreEnv();
  });

  const salespersonContext = await openContext(browser);
  const customerContext = await openContext(browser);
  const salespersonPage = await salespersonContext.newPage();
  const customerPage = await customerContext.newPage();

  await salespersonPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  const inviteUrl = await readInvitationAndOpenDashboard(salespersonPage);
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');
  await waitFor(() => snapshot(salespersonPage), (value) => value.callState === 'connected', 30000);

  const readConfig = (page: Page) =>
    page.evaluate(() => {
      const pc = (window as any).__pcs.find((item: any) => item.connectionState !== 'closed');
      const configuration = pc.getConfiguration();
      return {
        iceTransportPolicy: configuration.iceTransportPolicy,
        iceServers: configuration.iceServers.map((entry: any) => ({
          urls: Array.isArray(entry.urls) ? entry.urls : [entry.urls],
          username: entry.username,
          credential: entry.credential,
        })),
      };
    });

  for (const page of [salespersonPage, customerPage]) {
    const configuration = await readConfig(page);
    assert.equal(configuration.iceTransportPolicy, 'all');
    const turn = configuration.iceServers.find((entry: any) =>
      entry.urls.some((url: string) => url.startsWith('turn'))
    );
    assert.ok(turn, 'peer connection must include the TURN server from the server payload');
    assert.deepEqual(turn.urls, [
      'turn:turn.invalid:3478?transport=udp',
      'turns:turn.invalid:5349?transport=tcp',
    ]);
    assert.equal(turn.username, 'mock-turn-user');
    assert.equal(turn.credential, 'mock-turn-pass');
  }

  // Diagnostics must not leak the credentials even though the PC holds them.
  for (const page of [salespersonPage, customerPage]) {
    const state = await snapshot(page);
    const rendered = await page.evaluate(() => document.body.innerText);
    for (const secret of ['mock-turn-pass', 'mock-turn-user']) {
      assert.ok(!JSON.stringify(state).includes(secret), `snapshot leaked ${secret}`);
      assert.ok(!rendered.includes(secret), `DOM leaked ${secret}`);
    }
    assert.equal(state.iceConfigLoaded, true);
    assert.equal(state.turnConfigured, true);
    assert.equal(state.turnCredentialMode, 'static');
  }

  // A reconnected peer connection must still receive the same ICE config.
  await customerPage.click('[data-testid="reconnect"]');
  await waitFor(() => snapshot(customerPage), (value) => value.callState !== 'connected', 10000);
  await waitFor(
    () => snapshot(customerPage),
    (value) => value.callState === 'connected' && value.mediaFlowing,
    30000
  );
  const reconnected = await readConfig(customerPage);
  const reconnectedTurn = reconnected.iceServers.find((entry: any) =>
    entry.urls.some((url: string) => url.startsWith('turn'))
  );
  assert.ok(reconnectedTurn, 'reconnect must keep the TURN server configuration');
  assert.equal(reconnectedTurn.username, 'mock-turn-user');

  await salespersonContext.close();
  await customerContext.close();
});

test('relay-only policy is applied and never reported as working audio without relay candidates', async asyncTest => {
  const restoreEnv = applyIceEnv({
    TURN_URLS: 'turn:turn.invalid:3478?transport=udp',
    TURN_USERNAME: 'mock-turn-user',
    TURN_CREDENTIAL: 'mock-turn-pass',
    TURN_SECRET: null,
    ICE_TRANSPORT_POLICY: 'relay',
    STUN_URLS: null,
  });
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  asyncTest.after(async () => {
    await browser.close();
    await server.close();
    restoreEnv();
  });

  const salespersonContext = await openContext(browser);
  const customerContext = await openContext(browser);
  const salespersonPage = await salespersonContext.newPage();
  const customerPage = await customerContext.newPage();

  await salespersonPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  const inviteUrl = await readInvitationAndOpenDashboard(salespersonPage);
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');

  const state = await waitFor(
    () => snapshot(salespersonPage),
    (value) => value.iceConfigLoaded === true,
    15000
  );
  assert.equal(state.diagnostics.iceTransportPolicy, 'relay');

  // Wait until the peer connection exists (it is created after the peer joins).
  await waitFor(
    async () => ({ count: await salespersonPage.evaluate(() => ((window as any).__pcs || []).length) }),
    (value) => value.count > 0,
    15000
  );
  const policy = await salespersonPage.evaluate(() => {
    const pc = (window as any).__pcs[0];
    return pc?.getConfiguration().iceTransportPolicy ?? 'no-pc';
  });
  assert.equal(policy, 'relay', 'relay-only policy must reach RTCPeerConnection');

  // The mock TURN host does not exist: no relay candidates can be gathered, so
  // the UI must not claim audio is flowing.
  await sleep(4000);
  const relayState = await snapshot(customerPage);
  assert.equal(relayState.relayCandidates, 0);
  assert.equal(relayState.mediaFlowing, false);
  assert.notEqual(relayState.callState, 'connected');
  assert.equal(relayState.diagnostics.iceTransportPolicy, 'relay');
  assert.equal(await customerPage.locator('[data-testid="relay-warning"]').count(), 1);

  await salespersonContext.close();
  await customerContext.close();
});

test('relay-only mode without TURN refuses to start instead of silently using STUN', async asyncTest => {
  const restoreEnv = applyIceEnv({
    TURN_URLS: null,
    TURN_USERNAME: null,
    TURN_CREDENTIAL: null,
    TURN_SECRET: null,
    ICE_TRANSPORT_POLICY: 'relay',
    STUN_URLS: null,
  });
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  asyncTest.after(async () => {
    await browser.close();
    await server.close();
    restoreEnv();
  });

  const context = await openContext(browser);
  const page = await context.newPage();
  await page.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  await readInvitationAndOpenDashboard(page);
  await page.click('[data-testid="join-call"]');

  const state = await waitFor(() => snapshot(page), (value) => value.callState === 'failed', 15000);
  assert.match(String(state.iceConfigError), /relay requires a usable TURN relay/i);
  assert.equal(state.iceConfigLoaded, false);
  assert.equal(state.wsStatus, 'disconnected', 'no signaling socket may be opened');
  assert.equal(state.micPermission, 'unknown', 'microphone must not be captured for a call that cannot work');

  const pcs = await page.evaluate(() => ((window as any).__pcs || []).length);
  assert.equal(pcs, 0, 'no peer connection may be created with unverified ICE settings');
  assert.equal(await pcs, 0);
  assert.equal(await page.locator('[data-testid="ice-error"]').count(), 1);

  await context.close();
});

test('presence refreshes during slow ICE setup do not create duplicate offers', async (t) => {
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  // Delay trickled candidates so the PC stays in `connecting` while the server
  // sends presence updates (the window that used to trigger a second offer).
  const salespersonContext = await openContext(browser, { delayIceMs: 1500 });
  const customerContext = await openContext(browser, { delayIceMs: 1500 });
  const salespersonPage = await salespersonContext.newPage();
  const customerPage = await customerContext.newPage();

  await salespersonPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  const inviteUrl = await readInvitationAndOpenDashboard(salespersonPage);
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });
  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');

  const connected = await waitFor(
    () => snapshot(salespersonPage),
    (value) => value.callState === 'connected' && value.mediaFlowing,
    45000
  );

  const sales = await salespersonPage.evaluate(() => ({
    pcs: ((window as any).__pcs as any[]).map((pc) => ({
      connectionState: pc.connectionState,
      signalingState: pc.signalingState,
    })),
  }));
  const customer = await customerPage.evaluate(() => ({
    pcs: ((window as any).__pcs as any[]).map((pc) => ({
      connectionState: pc.connectionState,
      signalingState: pc.signalingState,
    })),
  }));

  const stored = await salespersonPage.evaluate(() =>
    JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}')
  );
  const diagnosticsResponse = await fetch(`${base}/api/sessions/${stored.sessionId}/diagnostics`, {
    headers: { Authorization: `Bearer ${stored.salespersonKey}` },
  });
  assert.equal(diagnosticsResponse.status, 200);
  const diagnostics = (await diagnosticsResponse.json()).diagnostics;

  assert.equal(connected.diagnostics.bytesSent > 0, true);
  assert.equal(sales.pcs.length, 1, 'exactly one peer connection on the offerer');
  assert.equal(customer.pcs.length, 1, 'exactly one peer connection on the answerer');
  assert.equal(sales.pcs[0].signalingState, 'stable');
  assert.equal(customer.pcs[0].signalingState, 'stable');
  assert.equal(diagnostics.signals.offers, 1, 'the server relayed exactly one offer');
  assert.equal(diagnostics.signals.restartRequests, 0);
  assert.equal(
    connected.logs.some((line: string) => /presence refresh: session_state\]/i.test(line)),
    false,
    'presence refresh must not send an offer'
  );
  const customerSnapshot = await snapshot(customerPage);
  assert.equal(
    customerSnapshot.logs.some((line: string) => /Ignoring duplicate offer/i.test(line)),
    false,
    'the answerer must not have received a duplicate offer'
  );
});

test('an unreachable relay ends in a terminal, actionable failure without peer-connection churn', async (t) => {
  const restoreEnv = applyIceEnv({
    TURN_URLS: 'turn:127.0.0.1:9?transport=udp',
    TURN_USERNAME: 'mock-turn-user',
    TURN_CREDENTIAL: 'mock-turn-pass',
    TURN_SECRET: null,
    ICE_TRANSPORT_POLICY: 'relay',
    STUN_URLS: null,
  });
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
    restoreEnv();
  });

  const salespersonContext = await openContext(browser);
  const customerContext = await openContext(browser);
  const salespersonPage = await salespersonContext.newPage();
  const customerPage = await customerContext.newPage();

  await salespersonPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  const inviteUrl = await readInvitationAndOpenDashboard(salespersonPage);
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });
  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');

  // ICE failure is detected after ~15 s; the bounded restarts then run to
  // exhaustion. This is intentionally the longest browser test.
  const failed = await waitFor(
    () => snapshot(salespersonPage),
    (value) => value.callState === 'failed' && Boolean(value.lastError),
    120000
  );

  assert.match(String(failed.lastError), /Could not restore|did not answer|Retry the connection/i);
  assert.equal(failed.recovery.phase, 'exhausted');
  assert.equal(failed.mediaFlowing, false);
  assert.notEqual(failed.callState, 'connected');

  const readPcs = () =>
    salespersonPage.evaluate(() => ({
      total: ((window as any).__pcs as any[]).length,
      open: ((window as any).__pcs as any[]).filter((pc) => pc.connectionState !== 'closed').length,
    }));

  const first = await readPcs();
  assert.equal(first.total, 1, 'terminal failure must not recreate the peer connection');
  assert.equal(first.open, 0, 'the failed connection is closed');

  // Presence updates continue; none may recreate the PC after terminal failure.
  await sleep(6000);
  const second = await readPcs();
  assert.equal(second.total, 1, 'no peer-connection churn after terminal failure');
  assert.equal((await snapshot(salespersonPage)).callState, 'failed');
  assert.equal((await snapshot(salespersonPage)).mediaFlowing, false);
});
