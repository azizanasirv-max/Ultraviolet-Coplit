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
import os from 'node:os';
import path from 'node:path';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import WebSocket from 'ws';

process.env.NODE_ENV = 'production';
process.env.AI_SERVICE_URL = 'https://ai.invalid';
process.env.AI_SERVICE_TOKEN = 'test-ai-token';

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

// Never contact the real AI service from automated tests.
let aiCallRequests = 0;
const fakeAiServiceFetch = (async () => {
  aiCallRequests += 1;
  return new Response(
    JSON.stringify({
      callId: `call_browser_${aiCallRequests}`,
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

const openContext = async (browser: Browser): Promise<BrowserContext> => {
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addInitScript(() => {
    // tsx/esbuild annotates function names inside page.evaluate() bodies with a
    // `__name()` helper. Define it so serialized test callbacks can run.
    (window as any).__name = (fn: unknown) => fn;
    const Original = window.RTCPeerConnection;
    (window as any).__pcs = [];
    // Registry of every microphone track handed to this page, so a test can
    // prove that recovery/reconnect leaves exactly one live capture.
    (window as any).__micTracks = [];
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices?.getUserMedia) {
      const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
      mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const stream = await originalGetUserMedia(constraints);
        (window as any).__micTracks.push(...stream.getAudioTracks());
        return stream;
      };
    }
    const originalCreateOffer = (Original.prototype as any).createOffer as (
      this: any,
      ...args: any[]
    ) => Promise<RTCSessionDescriptionInit>;
    (Original.prototype as any).createOffer = function (this: any, ...args: any[]) {
      this.__createOfferCalls = (this.__createOfferCalls || 0) + 1;
      return originalCreateOffer.apply(this, args);
    };
    (window as any).RTCPeerConnection = function (...args: any[]) {
      const pc = new (Original as any)(...args);
      (window as any).__pcs.push(pc);
      return pc;
    };
    (window as any).RTCPeerConnection.prototype = Original.prototype;
  });
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
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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

    // No internal networking/API detail either.
    for (const token of CUSTOMER_FORBIDDEN_TEXT) {
      assert.ok(!text.includes(token), `customer DOM leaked "${token}"`);
    }
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
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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
    // No reachable AI service in this environment: the customer AI request must
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
    const callsBefore = aiCallRequests;

    await salespersonPage.click('[data-testid="ai-reconnect"]');
    await waitFor(
      () => Promise.resolve(aiCallRequests > callsBefore),
      (advanced) => advanced === true,
      15000
    );

    // A genuinely new AI call was requested (replace=true path).
    assert.ok(aiCallRequests > callsBefore, 'a new AI call was requested');

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
    // for the AI agent. This exercises the real server route and the real
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
      (text) => !/favicon|Failed to load resource|net::ERR/i.test(text)
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
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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
  const callsBeforeRotation = aiCallRequests;
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
  assert.ok(aiCallRequests > callsBeforeRotation, 'the server created another AI call');
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
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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

/**
 * Real-Chromium presence-refresh smoke test (NOT the D1 regression proof).
 *
 * The deterministic suite in `tests/negotiation.test.ts` is the regression test
 * for the duplicate-offer defect: it fails against the unfixed base engine.
 * Loopback Chromium negotiates too quickly to reproduce the original
 * `stable`/`connecting` presence-refresh window reliably; this browser test also
 * passes against the unfixed base. It is retained only as a real-browser smoke
 * test that a presence flood leaves one healthy, stable peer connection.
 *
 * Loopback Chromium is not proof of NAT traversal.
 */
test('presence refresh flood during real Chromium negotiation leaves one healthy connection (smoke)', async (t) => {
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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

  await salespersonPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  const inviteUrl = await readInvitationAndOpenDashboard(salespersonPage);
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

  const inviteToken = decodeURIComponent(inviteUrl.split('invite=')[1]);
  const credentials = await customerPage.evaluate((token) => {
    const stored = JSON.parse(sessionStorage.getItem(`sc.prototype2.customer.${token}`) || '{}');
    return { sessionId: stored.sessionId as string, customerKey: stored.customerKey as string };
  }, inviteToken);
  assert.ok(credentials.sessionId && credentials.customerKey);

  // Flood server presence broadcasts while ICE/DTLS is still being set up.
  const presenceFlood = (async () => {
    for (let index = 0; index < 12; index += 1) {
      await fetch(`${base}/api/sessions/${credentials.sessionId}/ai-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.customerKey}`,
        },
        body: JSON.stringify({ replace: true }),
      }).catch(() => undefined);
      await sleep(40);
    }
  })();

  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');

  await waitFor(
    () => snapshot(salespersonPage),
    (value) =>
      value.callState === 'connected' &&
      value.diagnostics.bytesSent > 0 &&
      value.diagnostics.bytesReceived > 0,
    30000
  );
  await presenceFlood;
  await sleep(500);

  const state = await salespersonPage.evaluate(() => {
    const open = (window as any).__pcs.filter((pc: any) => pc.connectionState !== 'closed');
    return open.map((pc: any) => ({
      signalingState: pc.signalingState,
      createOfferCalls: pc.__createOfferCalls || 0,
      connectionState: pc.connectionState,
    }));
  });

  assert.equal(state.length, 1, 'exactly one active peer connection');
  assert.equal(state[0].connectionState, 'connected');
  assert.equal(state[0].signalingState, 'stable', 'presence refreshes must not leave an unanswered offer');
  assert.equal(state[0].createOfferCalls, 1, 'presence refreshes must not create duplicate offers');

  const customerState = await customerPage.evaluate(() =>
    (window as any).__pcs
      .filter((pc: any) => pc.connectionState !== 'closed')
      .map((pc: any) => ({ signalingState: pc.signalingState, createOfferCalls: pc.__createOfferCalls || 0 }))
  );
  assert.equal(customerState.length, 1);
  assert.equal(customerState[0].signalingState, 'stable');
  assert.equal(customerState[0].createOfferCalls, 0, 'the customer is always the answerer');

  await salespersonContext.close();
  await customerContext.close();
});

// ---------------------------------------------------------------------------
// Customer privacy: raw networking/API errors must never be rendered
// ---------------------------------------------------------------------------

/** Tokens that would prove an internal networking/API detail reached the DOM. */
const CUSTOMER_FORBIDDEN_TEXT = [
  'ICE',
  'TURN',
  'SDP',
  'candidate',
  'WebSocket',
  'signaling',
  'Failed to fetch',
  'UNAUTHORIZED',
  'TURN_MISCONFIGURED',
  'SESSION_NOT_FOUND',
  'HTTP 4',
  'HTTP 5',
  '401',
  '403',
  '404',
  '500',
  '503',
];

const assertCustomerDomIsClean = async (page: Page, context: string) => {
  const text = (await page.textContent('[data-testid="role-customer"]')) || '';
  for (const token of CUSTOMER_FORBIDDEN_TEXT) {
    assert.ok(!text.includes(token), `${context}: customer DOM leaked "${token}" in: ${text}`);
  }
};

test('customer never sees technical errors when the ICE configuration request keeps failing', async (t) => {
  const restoreEnv = applyIceEnv({
    TURN_URLS: null,
    TURN_USERNAME: null,
    TURN_CREDENTIAL: null,
    TURN_SECRET: null,
    ICE_TRANSPORT_POLICY: 'all',
    STUN_URLS: null,
  });
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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

  // Simulate a server that cannot answer the ICE endpoint (restart, cold start,
  // dropped request). Before the fix this aborted the whole customer call.
  await customerPage.route('**/api/sessions/*/ice-config', (route) => route.abort('connectionreset'));

  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');

  await waitFor(
    () => snapshot(salespersonPage),
    (value) => value.callState === 'connected' && value.mediaFlowing,
    30000
  );
  const customer = await waitFor(
    () => snapshot(customerPage),
    (value) => value.callState === 'connected' && value.mediaFlowing,
    30000
  );

  // The technical detail exists internally (salesperson diagnostics) ...
  assert.equal(customer.iceConfigLoaded, false);
  assert.match(String(customer.iceConfigError), /could not reach the server/i);
  // ... but it is not rendered for the customer.
  await assertCustomerDomIsClean(customerPage, 'ICE endpoint unavailable');
  assert.equal(await customerPage.locator('[data-testid="ice-error"]').count(), 0);
  assert.equal(await customerPage.locator('[data-testid="customer-notice"]').count(), 0);

  await salespersonContext.close();
  await customerContext.close();
});

test('relay-only ICE failure shows the customer a plain message after recovery is exhausted', async (t) => {
  const restoreEnv = applyIceEnv({
    TURN_URLS: 'turn:turn.invalid:3478?transport=udp',
    TURN_USERNAME: 'mock-turn-user',
    TURN_CREDENTIAL: 'mock-turn-pass',
    TURN_SECRET: null,
    ICE_TRANSPORT_POLICY: 'relay',
    STUN_URLS: null,
  });
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
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

  // The mock TURN host cannot be reached: bounded ICE restarts run first, then
  // the terminal state is shown.
  const customer = await waitFor(
    () => snapshot(customerPage),
    (value) => value.callState === 'failed',
    90000
  );
  // The ICE payload itself was valid; the relay is simply unreachable.
  assert.equal(customer.iceConfigError, null);
  assert.equal(customer.iceConfigLoaded, true);

  await assertCustomerDomIsClean(customerPage, 'relay-only failure');
  assert.equal(await customerPage.locator('[data-testid="ice-error"]').count(), 1);
  assert.match(
    (await customerPage.textContent('[data-testid="ice-error"]')) || '',
    /Unable to connect\. Please try again\./
  );
  assert.equal(customer.turnConfigured, true, 'the relay was configured, just unreachable');
  assert.equal(customer.relayCandidates, 0);

  // The salesperson keeps the technical diagnostics.
  const salesperson = await snapshot(salespersonPage);
  assert.equal(salesperson.diagnostics.iceTransportPolicy, 'relay');
  const salespersonText = (await salespersonPage.textContent('[data-testid="role-salesperson"]')) || '';
  assert.match(salespersonText, /TURN is unreachable or rejected the credentials/i);

  await salespersonContext.close();
  await customerContext.close();
});

// ---------------------------------------------------------------------------
// Real audio energy, both directions, independent per browser instance
//
// Each browser captures a DIFFERENT tone as its microphone. That makes the two
// directions distinguishable: if the salesperson's remote stream carries the
// customer's tone (and not its own), the customer audio genuinely travelled over
// WebRTC, and vice versa. Energy, not "a track exists", is the assertion.
// ---------------------------------------------------------------------------

const toneDir = path.join(os.tmpdir(), `uv-tones-${process.pid}`);

/** Writes a 16-bit mono WAV tone that Chromium loops as the fake microphone. */
const writeToneWav = (file: string, hz: number, sampleRate = 48000, seconds = 2): string => {
  const frames = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * hz * index) / sampleRate) * 12000),
      44 + index * 2
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return file;
};

const SALESPERSON_TONE_HZ = 440;
const CUSTOMER_TONE_HZ = 1200;

/** One browser instance whose fake microphone plays one specific tone. */
const launchToneBrowser = (wav: string): Promise<Browser> =>
  chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

interface AudioProbe {
  remote: { rms: number; peak: number; dominantHz: number; frames: number };
  local: { rms: number; peak: number; dominantHz: number };
  micTracks: Array<{ id: string; readyState: string; enabled: boolean; muted: boolean }>;
  liveMicrophoneTracks: number;
  element: { paused: boolean; muted: boolean; hasStream: boolean; tracks: number };
  stats: {
    inbound: { bytes: number; packets: number } | null;
    outbound: { bytes: number; packets: number } | null;
    pair: { localType: string | null; remoteType: string | null } | null;
  };
  openPcs: number;
}

/**
 * Measures the decoded remote audio (the <audio> element's stream) and the
 * local capture, plus the real RTP counters, inside one browser context.
 */
const probeAudio = (page: Page, durationMs = 2600): Promise<AudioProbe> =>
  page.evaluate(async (duration) => {
    const element = document.querySelector('[data-testid="remote-audio"]') as HTMLAudioElement | null;
    const remote = (element?.srcObject as MediaStream | null) ?? null;
    const pcs = ((window as any).__pcs || []).filter((pc: any) => pc.connectionState !== 'closed');
    const pc = pcs[0];
    const localTrack = pc
      ?.getSenders()
      .map((sender: any) => sender.track)
      .find((track: any) => track && track.kind === 'audio') ?? null;

    const context = new AudioContext();
    await context.resume();
    const buffer = new Float32Array(4096);

    const measure = async (stream: MediaStream | null, withSpectrum: boolean) => {
      if (!stream) return { rms: 0, peak: 0, dominantHz: 0 };
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      // Only frequencyBinCount (fftSize / 2) entries are ever written.
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const bins = new Float64Array(analyser.frequencyBinCount);
      const binHz = context.sampleRate / analyser.fftSize;
      let peak = 0;
      let sumSq = 0;
      let samples = 0;
      const started = Date.now();
      while (Date.now() - started < duration) {
        analyser.getFloatTimeDomainData(buffer);
        for (let index = 0; index < buffer.length; index += 1) {
          peak = Math.max(peak, Math.abs(buffer[index]));
          sumSq += buffer[index] * buffer[index];
        }
        samples += buffer.length;
        if (withSpectrum) {
          analyser.getFloatFrequencyData(spectrum);
          for (let index = 0; index < spectrum.length; index += 1) {
            bins[index] += Number.isFinite(spectrum[index]) ? Math.pow(10, spectrum[index] / 20) : 0;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      let best = 0;
      for (let index = 1; index < bins.length; index += 1) if (bins[index] > bins[best]) best = index;
      source.disconnect();
      analyser.disconnect();
      return {
        rms: Math.sqrt(sumSq / Math.max(1, samples)),
        peak,
        dominantHz: Math.round(best * binHz),
      };
    };

    const remoteResult = await measure(remote, true);
    const localResult = await measure(localTrack ? new MediaStream([localTrack]) : null, true);
    await context.close();

    const stats: AudioProbe['stats'] = { inbound: null, outbound: null, pair: null };
    if (pc) {
      const report = await pc.getStats();
      const candidates = new Map<string, any>();
      report.forEach((entry: any) => {
        if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') {
          candidates.set(entry.id, entry);
        }
      });
      report.forEach((entry: any) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
          stats.inbound = { bytes: entry.bytesReceived, packets: entry.packetsReceived };
        }
        if (entry.type === 'outbound-rtp' && entry.kind === 'audio') {
          stats.outbound = { bytes: entry.bytesSent, packets: entry.packetsSent };
        }
        if (entry.type === 'candidate-pair' && (entry.nominated || entry.selected) && entry.state === 'succeeded') {
          stats.pair = {
            localType: candidates.get(entry.localCandidateId)?.candidateType ?? null,
            remoteType: candidates.get(entry.remoteCandidateId)?.candidateType ?? null,
          };
        }
      });
    }

    const micTracks = ((window as any).__micTracks || []).map((track: MediaStreamTrack) => ({
      id: track.id,
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
    }));

    return {
      remote: { ...remoteResult, frames: 1 },
      local: localResult,
      micTracks,
      liveMicrophoneTracks: micTracks.filter((track: any) => track.readyState === 'live').length,
      element: {
        paused: element?.paused ?? true,
        muted: element?.muted ?? true,
        hasStream: Boolean(remote),
        tracks: remote ? remote.getAudioTracks().length : 0,
      },
      stats,
      openPcs: pcs.length,
    };
  }, durationMs);

test('prototype2 participant audio is non-silent in both directions and independent of the AI path', async (t) => {
  const salesWav = writeToneWav(path.join(toneDir, 'sales.wav'), SALESPERSON_TONE_HZ);
  const customerWav = writeToneWav(path.join(toneDir, 'customer.wav'), CUSTOMER_TONE_HZ);

  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: true,
    aiServiceFetch: fakeAiServiceFetch,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const salesBrowser = await launchToneBrowser(salesWav);
  const customerBrowser = await launchToneBrowser(customerWav);
  t.after(async () => {
    await salesBrowser.close();
    await customerBrowser.close();
    await server.close();
  });

  const salespersonContext = await openContext(salesBrowser);
  const salespersonPage = await salespersonContext.newPage();
  const customerContext = await openContext(customerBrowser);
  const customerPage = await customerContext.newPage();

  // Which page asked the server to create an AI call. Only the customer device
  // is allowed to; the salesperson microphone must never be forwarded to the AI.
  const aiCallRequestsByPage: Array<{ url: string; page: string }> = [];
  for (const [page, label] of [
    [salespersonPage, 'salesperson'],
    [customerPage, 'customer'],
  ] as Array<[Page, string]>) {
    page.on('request', (request) => {
      if (request.url().includes('/ai-call')) aiCallRequestsByPage.push({ url: request.url(), page: label });
    });
  }

  await salespersonPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  const inviteUrl = await readInvitationAndOpenDashboard(salespersonPage);
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

  await salespersonPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');

  await waitFor(
    () => snapshot(salespersonPage),
    (value) => value.callState === 'connected' && value.mediaFlowing === true,
    40000
  );
  await waitFor(
    () => snapshot(customerPage),
    (value) => value.callState === 'connected' && value.mediaFlowing === true,
    40000
  );

  const near = (actual: number, expected: number, tolerance = 90) => Math.abs(actual - expected) <= tolerance;

  await t.test('customer microphone reaches the salesperson as non-silent audio', async () => {
    const probe = await probeAudio(salespersonPage);
    assert.equal(probe.element.hasStream, true, 'the salesperson must have a remote stream');
    assert.equal(probe.element.tracks, 1);
    assert.equal(probe.element.paused, false, 'remote audio must actually be playing');
    assert.equal(probe.element.muted, false);
    assert.ok(probe.remote.rms > 0.004, `customer audio energy too low (rms ${probe.remote.rms})`);
    assert.ok(probe.remote.peak > 0.02, `customer audio peak too low (peak ${probe.remote.peak})`);
    assert.ok(
      near(probe.remote.dominantHz, CUSTOMER_TONE_HZ),
      `salesperson must receive the customer tone (${CUSTOMER_TONE_HZ} Hz), got ${probe.remote.dominantHz} Hz`
    );
    // The salesperson's own capture is the other tone: the two directions are
    // not the same stream and nothing is duplicated.
    assert.ok(
      near(probe.local.dominantHz, SALESPERSON_TONE_HZ),
      `salesperson local capture should be ${SALESPERSON_TONE_HZ} Hz, got ${probe.local.dominantHz} Hz`
    );
    assert.ok(probe.stats.inbound && probe.stats.inbound.bytes > 0, 'inbound RTP bytes must increase');
    assert.ok(probe.stats.inbound && probe.stats.inbound.packets > 0, 'inbound RTP packets must arrive');
    assert.equal(probe.openPcs, 1);
  });

  await t.test('salesperson microphone reaches the customer as non-silent audio', async () => {
    const probe = await probeAudio(customerPage);
    assert.equal(probe.element.hasStream, true, 'the customer must have a remote stream');
    assert.equal(probe.element.paused, false);
    assert.equal(probe.element.muted, false);
    assert.ok(probe.remote.rms > 0.004, `salesperson audio energy too low (rms ${probe.remote.rms})`);
    assert.ok(probe.remote.peak > 0.02, `salesperson audio peak too low (peak ${probe.remote.peak})`);
    assert.ok(
      near(probe.remote.dominantHz, SALESPERSON_TONE_HZ),
      `customer must receive the salesperson tone (${SALESPERSON_TONE_HZ} Hz), got ${probe.remote.dominantHz} Hz`
    );
    assert.ok(
      near(probe.local.dominantHz, CUSTOMER_TONE_HZ),
      `customer local capture should be ${CUSTOMER_TONE_HZ} Hz, got ${probe.local.dominantHz} Hz`
    );
    assert.ok(probe.stats.inbound && probe.stats.inbound.bytes > 0);
    assert.ok(probe.stats.outbound && probe.stats.outbound.bytes > 0);
    assert.equal(probe.openPcs, 1);
  });

  await t.test('the AI path is separate: its capture is not the participant audio path', async () => {
    // The customer device is the only one that may start an AI session.
    assert.equal(
      aiCallRequestsByPage.filter((entry) => entry.page === 'salesperson').length,
      0,
      'the salesperson device must never request an AI call'
    );
    assert.ok(
      aiCallRequestsByPage.some((entry) => entry.page === 'customer'),
      'the customer device must still request the AI call'
    );

    // The AI transport (LiveKit) opens its own microphone capture. Reproduce
    // exactly that: a second capture while the call is live must carry audio,
    // and closing it must not disturb the participant audio path.
    const aiCapture = await customerPage.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      context.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      let peak = 0;
      const started = Date.now();
      while (Date.now() - started < 900) {
        analyser.getFloatTimeDomainData(buffer);
        for (let index = 0; index < buffer.length; index += 1) peak = Math.max(peak, Math.abs(buffer[index]));
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const info = {
        peak,
        tracks: stream.getAudioTracks().map((track) => track.readyState),
      };
      // Exactly what the AI session teardown does to its local track.
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      return info;
    });
    assert.ok(aiCapture.peak > 0.02, 'the AI capture must receive the customer microphone');
    assert.deepEqual(aiCapture.tracks, ['live']);

    // An AI failure (this environment has no reachable AI service) must not end
    // the human call: it stays connected and audio keeps flowing.
    const customer = await waitFor(
      () => snapshot(customerPage),
      (value) => value.callState === 'connected' && value.mediaFlowing === true,
      20000
    );
    assert.ok(['error', 'reconnecting', 'creating', 'connecting'].includes(customer.ai.state));

    const salespersonAfterAiFailure = await waitFor(
      () => snapshot(salespersonPage),
      (value) => value.callState === 'connected' && value.mediaFlowing === true,
      20000
    );
    assert.equal(salespersonAfterAiFailure.callState, 'connected');

    // Audio in both directions survives the AI capture closing and the AI error.
    const salesProbe = await probeAudio(salespersonPage);
    assert.ok(salesProbe.remote.peak > 0.02, 'customer audio must continue after the AI capture closes');
    assert.ok(near(salesProbe.remote.dominantHz, CUSTOMER_TONE_HZ), `got ${salesProbe.remote.dominantHz} Hz`);

    const customerProbe = await probeAudio(customerPage);
    assert.ok(customerProbe.remote.peak > 0.02, 'salesperson audio must continue after the AI error');
    assert.ok(near(customerProbe.remote.dominantHz, SALESPERSON_TONE_HZ), `got ${customerProbe.remote.dominantHz} Hz`);
  });

  await t.test('reconnecting leaves one live microphone track and working audio', async () => {
    await customerPage.click('[data-testid="reconnect"]');

    await waitFor(
      () => snapshot(customerPage),
      (value) => value.callState === 'connected' && value.mediaFlowing === true,
      45000
    );
    await waitFor(
      () => snapshot(salespersonPage),
      (value) => value.callState === 'connected' && value.mediaFlowing === true,
      45000
    );

    const customerProbe = await probeAudio(customerPage);
    assert.equal(customerProbe.openPcs, 1, 'exactly one peer connection may stay open');
    assert.equal(
      customerProbe.liveMicrophoneTracks,
      1,
      `a reconnect must not leave a stale capture: ${JSON.stringify(customerProbe.micTracks)}`
    );
    const liveTrack = customerProbe.micTracks.filter((track) => track.readyState === 'live')[0];
    assert.ok(liveTrack, 'the customer must still hold exactly one live capture');
    assert.equal(liveTrack.enabled, true, 'the microphone must not stay disabled');

    const salesProbe = await probeAudio(salespersonPage);
    assert.ok(salesProbe.remote.peak > 0.02, 'customer audio must flow again after the reconnect');
    assert.ok(
      near(salesProbe.remote.dominantHz, CUSTOMER_TONE_HZ),
      `salesperson must still receive the customer tone, got ${salesProbe.remote.dominantHz} Hz`
    );
    assert.ok(
      salesProbe.stats.inbound && salesProbe.stats.inbound.packets > 0,
      'inbound RTP packets must arrive after the reconnect'
    );
    assert.equal(
      salesProbe.liveMicrophoneTracks,
      1,
      `a reconnect must not leave a stale capture: ${JSON.stringify(salesProbe.micTracks)}`
    );

    const customerAudio = await snapshot(customerPage);
    assert.ok(customerAudio.mediaFlowing, 'the customer must report working audio');
    assert.equal(customerAudio.diagnostics.audioFlow, 'both');
  });

  await t.test('the customer never sees internal audio diagnostics or AI internals', async () => {
    const text = (await customerPage.textContent('[data-testid="role-customer"]')) || '';
    for (const token of [
      'diagnostic',
      'suggestion',
      'rtp',
      'ICE',
      'TURN',
      'candidate',
      'Ultravox',
      'blob:',
      'Error:',
    ]) {
      assert.ok(!text.includes(token), `customer DOM leaked "${token}"`);
    }
    assert.equal(await customerPage.locator('[data-testid="diagnostics-panel"]').count(), 0);
    assert.equal(await customerPage.locator('[data-testid="ai-suggestions"]').count(), 0);
  });
});

test('main app exposes Admin Settings and no Standalone or Prototype 1 UI', async (t) => {
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, aiServiceFetch: fakeAiServiceFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const context = await openContext(browser);
  const page = await context.newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

  // The admin entry point lives in the main app chrome.
  await page.waitForSelector('[data-testid="admin-settings-open"]', { timeout: 20000 });
  const shellText = (await page.textContent('body')) || '';
  assert.ok(!shellText.includes('Prototype 1'), 'Prototype 1 must be removed');
  assert.ok(!shellText.includes('Standalone'), 'the Standalone tab must be removed');
  assert.ok(!shellText.includes('Prototype 2 (Live Sales Call)'), 'prototype tabs must be removed');

  await t.test('setup, save TURN credentials and keep the secret out of storage', async () => {
    await page.click('[data-testid="admin-settings-open"]');
    await page.waitForSelector('[data-testid="admin-setup-form"]', { timeout: 10000 });

    const setupPassword = 'Browser-Setup-2026!';
    const turn = {
      server: 'turn:free.expressturn.com:3478',
      username: 'browser-turn-user',
      password: 'browser-turn-secret',
    };

    await page.fill('[data-testid="admin-setup-password"]', setupPassword);
    await page.fill('[data-testid="admin-setup-confirm"]', setupPassword);
    await page.click('[data-testid="admin-setup-form"] button[type="submit"]');
    await page.waitForSelector('[data-testid="admin-turn-form"]', { timeout: 20000 });

    await page.fill('[data-testid="admin-turn-server"]', turn.server);
    await page.fill('[data-testid="admin-turn-username"]', turn.username);
    await page.fill('[data-testid="admin-turn-password"]', turn.password);
    await page.click('[data-testid="admin-turn-save"]');

    await page.waitForFunction(
      () => {
        const status = document.querySelector('[data-testid="admin-status"]');
        return Boolean(status && /configured \(1 URL\)/.test(status.textContent || ''));
      },
      undefined,
      { timeout: 20000 }
    );

    // Secrets are cleared from the form and never written to browser storage.
    assert.equal(await page.inputValue('[data-testid="admin-turn-password"]'), '');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    for (const secret of [turn.password, turn.username, setupPassword]) {
      assert.ok(!stored.includes(secret), `browser storage leaked ${secret}`);
    }

    // The server confirms the relay is usable, without returning the credentials.
    const health = await (await fetch(`${base}/api/health`)).json() as any;
    assert.equal(health.ice.configured, true);
    assert.equal(health.hasTurn, true);
  });

  await t.test('signing out then back in keeps the saved configuration', async () => {
    await page.click('[data-testid="admin-logout"]');
    await page.waitForSelector('[data-testid="admin-login-form"]', { timeout: 10000 });
    await page.fill('[data-testid="admin-login-password"]', 'Browser-Setup-2026!');
    await page.click('[data-testid="admin-login-form"] button[type="submit"]');
    await page.waitForSelector('[data-testid="admin-turn-form"]', { timeout: 20000 });
    const status = (await page.textContent('[data-testid="admin-status"]')) || '';
    assert.match(status, /configured \(1 URL\)/);
    assert.doesNotMatch(status, /browser-turn-user|browser-turn-secret/);
  });
});

