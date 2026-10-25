/**
 * Browser-level dashboard tests (Chromium, synthetic media, fake captions).
 *
 * Two isolated browser contexts act as two devices. Chromium's fake audio
 * device supplies the microphone, and the salesperson's browser Speech
 * Recognition API is replaced by an in-page fake that emits canned phrases.
 * This verifies routing, transcript placement, privacy of the customer UI and
 * call-control behaviour — NOT physical-device acoustics, real Web Speech
 * provider quality, or real Ultravox behaviour (the provider is mocked).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import WebSocket from 'ws';

process.env.NODE_ENV = 'production';
process.env.ULTRAVOX_API_KEY = 'test-ultravox-key';

/** Chromium's shared libraries are unpacked locally (no root in this sandbox). */
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

/** Fonts and their config are unpacked next to the libraries. */
const fontConfig = path.join(process.cwd(), '.browser-libs', 'fonts', 'fonts.conf');
if (fs.existsSync(fontConfig)) process.env.FONTCONFIG_FILE = fontConfig;

const { createPrototype2Server } = await import('../server');

const fakeUltravoxFetch = (async () =>
  new Response(JSON.stringify({ callId: 'call_browser_ui', joinUrl: 'wss://ai.invalid/join' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const launchBrowser = (): Promise<Browser> =>
  chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

/**
 * Replaces browser speech recognition with a deterministic fake.
 *
 * Passed as a string: the test file is compiled by tsx/esbuild, and an injected
 * function would be wrapped with helpers that do not exist in the page.
 */
const installFakeRecognition = async (context: BrowserContext, phrases: string[]) => {
  const source = `
    (() => {
      const lines = ${JSON.stringify(phrases)};
      function FakeRecognition() {
        this.continuous = false;
        this.interimResults = false;
        this.lang = 'en-US';
        this.onstart = null;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this.started = false;
      }
      FakeRecognition.prototype.start = function () {
        if (this.started) return;
        this.started = true;
        if (this.onstart) this.onstart();
        const self = this;
        lines.forEach((line, index) => {
          setTimeout(() => {
            const result = [{ transcript: line }];
            result.isFinal = true;
            result.length = 1;
            if (self.onresult) self.onresult({ resultIndex: index, results: [result] });
          }, 200 * (index + 1));
        });
      };
      FakeRecognition.prototype.stop = function () {
        this.started = false;
        if (this.onend) this.onend();
      };
      window.SpeechRecognition = FakeRecognition;
      window.webkitSpeechRecognition = FakeRecognition;
    })();
  `;
  await context.addInitScript({ content: source });
};

const snapshot = async (page: Page) =>
  page.evaluate(() => (window as any).__prototype2?.getSnapshot() ?? null);

const waitFor = async <T>(
  fn: () => Promise<T | null>,
  predicate: (value: T) => boolean,
  timeoutMs = 25000
) => {
  const started = Date.now();
  let last: T | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last && predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
};

test('customer and salesperson dashboards stay separated', async (t) => {
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: true,
    ultravoxFetch: fakeUltravoxFetch,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  const salesContext = await browser.newContext({ permissions: ['microphone'] });
  await installFakeRecognition(salesContext, ['Thanks for joining today.', 'Let us look at your renewal.']);
  const salesPage = await salesContext.newPage();

  const customerContext = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 390, height: 844 },
  });
  const customerPage = await customerContext.newPage();

  await salesPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
  await salesPage.waitForSelector('[data-testid="salesperson-invite-url"]', { timeout: 25000 });
  const inviteUrl = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
  await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 25000 });

  await salesPage.click('[data-testid="join-call"]');
  await customerPage.click('[data-testid="join-call"]');
  await waitFor(() => snapshot(customerPage), (value: any) => value.callState === 'connected');

  await t.test('the customer screen is a clean call UI on a phone viewport', async () => {
    assert.equal(await customerPage.locator('[data-testid="role-customer"]').count(), 1);
    assert.equal(await customerPage.locator('[data-testid="role-salesperson"]').count(), 0);
    assert.match((await customerPage.textContent('[data-testid="call-state"]')) || '', /Connected/);

    const body = (await customerPage.textContent('body')) || '';
    assert.doesNotMatch(body, /\bAI\b|copilot|suggestion|Ultravox|diagnostics|reconnect attempt/i);

    for (const testId of ['mic-toggle', 'speaker-toggle', 'leave-call']) {
      const box = await customerPage.locator(`[data-testid="${testId}"]`).boundingBox();
      assert.ok(box, `${testId} is visible`);
      assert.ok(box!.x >= 0 && box!.x + box!.width <= 390, `${testId} fits the phone width`);
      assert.ok(box!.y + box!.height <= 844, `${testId} is reachable without scrolling`);
      assert.ok(box!.width >= 44 && box!.height >= 44, `${testId} has a 44px touch target`);
    }
  });

  await t.test('the customer reads a transcript of the salesperson speech', async () => {
    const segment = await customerPage.waitForSelector('[data-testid="customer-transcript-segment"]', {
      timeout: 15000,
    });
    const text = (await segment.textContent()) || '';
    assert.match(text, /Thanks for joining today\./);

    const transcript = (await customerPage.textContent('[data-testid="customer-transcript"]')) || '';
    assert.doesNotMatch(transcript, /suggestion|copilot|AI\b/i);

    // The salesperson's own words are not echoed into their customer-transcript panel.
    const salesTranscript = (await salesPage.textContent('[data-testid="customer-transcript"]')) || '';
    assert.doesNotMatch(salesTranscript, /Thanks for joining today\./);
  });

  await t.test('AI suggestions reach only the salesperson', async () => {
    const sessionId = await salesPage.evaluate(
      () => JSON.parse(localStorage.getItem('sc.prototype2.salesperson') || '{}').sessionId as string
    );
    const inviteToken = decodeURIComponent(inviteUrl.split('invite=')[1]);
    const customerKey = await customerPage.evaluate(
      (token) => JSON.parse(sessionStorage.getItem(`sc.prototype2.customer.${token}`) || '{}').customerKey as string,
      inviteToken
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
        if (JSON.parse(raw.toString()).type === 'joined') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: 'ai_suggestion',
        sessionId,
        text: 'PRIVATE-SUGGESTION-999: mention the annual discount.',
        isFinal: true,
        ordinal: 5,
        timestamp: '10:00',
      })
    );

    await salesPage.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="ai-suggestion-latest"]')
          ?.textContent?.includes('PRIVATE-SUGGESTION-999'),
      { timeout: 8000 }
    );
    const customerBody = (await customerPage.textContent('body')) || '';
    assert.doesNotMatch(customerBody, /PRIVATE-SUGGESTION-999/);
    socket.close();
  });

  await t.test('call controls still work for both participants', async () => {
    await customerPage.click('[data-testid="mic-toggle"]');
    const muted = await waitFor(() => snapshot(customerPage), (value: any) => value.micMuted === true, 5000);
    assert.equal(muted.diagnostics.localTrackState.includes('disabled'), true);
    await customerPage.click('[data-testid="mic-toggle"]');
    await waitFor(() => snapshot(customerPage), (value: any) => value.micMuted === false, 5000);

    await salesPage.click('[data-testid="mic-toggle"]');
    await waitFor(() => snapshot(salesPage), (value: any) => value.micMuted === true, 5000);
    await salesPage.click('[data-testid="mic-toggle"]');
    await waitFor(() => snapshot(salesPage), (value: any) => value.micMuted === false, 5000);

    // Diagnostics stay available to the salesperson, collapsed by default.
    assert.equal(await salesPage.locator('[data-testid="diagnostics-panel"]').count(), 0);
    await salesPage.click('[data-testid="diagnostics-toggle"]');
    await salesPage.waitForSelector('[data-testid="diagnostics-panel"]', { timeout: 5000 });
  });

  await salesContext.close();
  await customerContext.close();
});
