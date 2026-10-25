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
const fakeUltravoxFetch = (async () =>
  new Response(JSON.stringify({ callId: 'call_browser_test', joinUrl: 'wss://ai.invalid/join' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

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
    const Original = window.RTCPeerConnection;
    (window as any).__pcs = [];
    (window as any).RTCPeerConnection = function (...args: any[]) {
      const pc = new (Original as any)(...args);
      (window as any).__pcs.push(pc);
      return pc;
    };
    (window as any).RTCPeerConnection.prototype = Original.prototype;
  });
  return context;
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
  await salesPage.waitForSelector('[data-testid="salesperson-invite-url"]', { timeout: 20000 });

  await t.test('salesperson sees only the salesperson interface', async () => {
    assert.equal(await salesPage.locator('[data-testid="role-salesperson"]').count(), 1);
    assert.equal(await salesPage.locator('[data-testid="role-customer"]').count(), 0);
    assert.equal(await salesPage.getByText('Prototype 1 (Engine Test)').count(), 0);

    const inviteUrl = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
    assert.match(inviteUrl, /\/join\?invite=[A-Za-z0-9_-]{40,}$/);
  });

  const inviteUrl = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
  const customerContext = await openContext(browser);
  const customerPage = await customerContext.newPage();
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

  await t.test('customer sees only the customer interface', async () => {
    assert.equal(await customerPage.locator('[data-testid="role-customer"]').count(), 1);
    assert.equal(await customerPage.locator('[data-testid="role-salesperson"]').count(), 0);
    assert.equal(await customerPage.getByText('Prototype 1 (Engine Test)').count(), 0);
    assert.equal(await customerPage.getByText('AI copilot responses').count(), 0);
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
  await salespersonPage.waitForSelector('[data-testid="salesperson-invite-url"]', { timeout: 20000 });
  const inviteUrl = await salespersonPage.inputValue('[data-testid="salesperson-invite-url"]');

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

  await t.test('AI session failure is isolated from the human audio path', async () => {
    // No reachable Ultravox in this environment: the customer AI request must
    // fail visibly, while peer audio keeps flowing.
    const customer = await snapshot(customerPage);
    assert.ok(
      ['off', 'error', 'connecting', 'disconnected', 'idle'].includes(String(customer.aiStatus)),
      `unexpected AI status ${customer.aiStatus}`
    );
    const salesperson = await snapshot(salespersonPage);
    assert.equal(salesperson.callState, 'connected');
    assert.ok(salesperson.diagnostics.bytesSent > 0);
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
