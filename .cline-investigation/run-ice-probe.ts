/**
 * Investigation harness (NOT production code; lives outside src/ on purpose).
 *
 * Drives the real built frontend + real signaling server in two isolated
 * Chromium contexts (separate browser profiles) with TURN absent or present,
 * and records ICE / DTLS / RTP facts from window.RTCPeerConnection.getStats().
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

const require = createRequire(import.meta.url);
const Turn = require('./turn/node_modules/node-turn');

const SCENARIO = process.env.SCENARIO || 'direct';
const OUT_DIR = path.join(process.cwd(), '.cline-investigation', 'results');
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- scenario environment ---------------------------------------------------
for (const key of [
  'TURN_URLS', 'TURN_SECRET', 'TURN_USERNAME', 'TURN_CREDENTIAL',
  'TURN_CREDENTIALS_URL', 'TURN_CREDENTIALS_AUTH', 'STUN_URLS',
]) delete process.env[key];
process.env.ICE_TRANSPORT_POLICY = 'all';
process.env.NODE_ENV = 'production';
process.env.ULTRAVOX_API_KEY = 'investigation-key';

const TURN_USER = 'probe-user';
const TURN_PASS = 'probe-pass';
if (['turn-all', 'turn-relay', 'turn-relay-fail'].includes(SCENARIO)) {
  process.env.TURN_URLS = 'turn:127.0.0.1:3478?transport=udp';
  process.env.TURN_USERNAME = TURN_USER;
  process.env.TURN_CREDENTIAL = TURN_PASS;
  process.env.STUN_URLS = 'stun:stun.l.google.com:19302';
}
if (['turn-relay', 'turn-relay-fail', 'direct-relay'].includes(SCENARIO)) {
  process.env.ICE_TRANSPORT_POLICY = 'relay';
}

const fakeUltravoxFetch = (async () =>
  new Response(JSON.stringify({ callId: 'call_probe', joinUrl: 'wss://ai.invalid/join' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

// --- browser instrumentation ------------------------------------------------
const instrument = (opts: { hostOnly?: boolean } = {}) => {
  // tsx/esbuild keepNames emits __name(...) calls; page.evaluate bodies run in
  // the page world, so provide the helper there.
  if (typeof (window as any).__name !== 'function') (window as any).__name = (fn: any) => fn;
  const Original = window.RTCPeerConnection as any;
  const probe: any = { pcs: [], events: [] };
  (window as any).__iceProbe = probe;
  (window as any).RTCPeerConnection = function (config: any, ...rest: any[]) {
    const effective = opts.hostOnly ? { ...(config || {}), iceServers: [] } : config;
    const pc = new Original(effective, ...rest);
    const id = probe.pcs.length;
    probe.pcs.push(pc);
    const log = (event: string, extra: any = {}) =>
      probe.events.push({ t: Math.round(performance.now()), id, event, ...extra });
    log('created', {
      iceServers: (effective?.iceServers || []).map((entry: any) => ({
        urls: Array.isArray(entry.urls) ? entry.urls : [entry.urls],
        hasCredential: Boolean(entry.username || entry.credential),
      })),
      iceTransportPolicy: effective?.iceTransportPolicy ?? 'all',
    });
    pc.addEventListener('signalingstatechange', () => log('signalingstatechange', { state: pc.signalingState }));
    pc.addEventListener('icegatheringstatechange', () => log('icegatheringstatechange', { state: pc.iceGatheringState }));
    pc.addEventListener('iceconnectionstatechange', () => log('iceconnectionstatechange', { state: pc.iceConnectionState }));
    pc.addEventListener('connectionstatechange', () => log('connectionstatechange', { state: pc.connectionState }));
    pc.addEventListener('icecandidate', (event: any) =>
      log('icecandidate', {
        candidate: event.candidate
          ? {
              type: event.candidate.type, protocol: event.candidate.protocol,
              address: event.candidate.address, port: event.candidate.port,
              relatedAddress: event.candidate.relatedAddress,
            }
          : null,
        endOfCandidates: !event.candidate,
      })
    );
    pc.addEventListener('track', (event: any) => log('track', { kind: event.track?.kind }));
    return pc;
  };
  (window as any).RTCPeerConnection.prototype = Original.prototype;
  (window as any).RTCPeerConnection.generateCertificate = Original.generateCertificate
    ? Original.generateCertificate.bind(Original) : undefined;
};

// --- in-page metrics --------------------------------------------------------
const collect = async (page: Page) =>
  page.evaluate(async () => {
    const probe: any = (window as any).__iceProbe;
    const pcs: any[] = probe?.pcs ?? [];
    const snapshot = (window as any).__prototype2?.getSnapshot?.() ?? null;
    const openPc = [...pcs].reverse().find((pc: any) => pc.connectionState !== 'closed') ?? pcs[pcs.length - 1] ?? null;
    const audio = document.querySelector('audio') as HTMLAudioElement | null;
    const openPcCount = pcs.filter((pc: any) => pc.connectionState !== 'closed').length;
    if (!openPc) return { hasPc: false, pcCount: pcs.length, openPcCount, snapshot, events: probe?.events ?? [] };

    const pc = openPc;
    const stats = await pc.getStats();
    const locals: any[] = [];
    const remotes: any[] = [];
    const pairs: any[] = [];
    let inboundAudio: any = null;
    let outboundAudio: any = null;
    let transport: any = null;
    stats.forEach((report: any) => {
      if (report.type === 'local-candidate') locals.push(report);
      if (report.type === 'remote-candidate') remotes.push(report);
      if (report.type === 'candidate-pair') pairs.push(report);
      if (report.type === 'inbound-rtp' && report.kind === 'audio') inboundAudio = report;
      if (report.type === 'outbound-rtp' && report.kind === 'audio') outboundAudio = report;
      if (report.type === 'transport') transport = report;
    });
    const selected = pairs.find((p) => (p.nominated || p.selected) && p.state === 'succeeded') ?? null;
    const brief = (c: any) => c && ({
      type: c.candidateType, protocol: c.protocol, address: c.address, port: c.port,
      relatedAddress: c.relatedAddress, url: c.url, relayProtocol: c.relayProtocol,
    });
    const byId = (id: string) => brief(locals.concat(remotes).find((c) => c.id === id));
    const types = (list: any[]) => list.reduce((acc: any, c: any) => {
      acc[c.candidateType] = (acc[c.candidateType] ?? 0) + 1; return acc;
    }, {});
    const sdp = (description: RTCSessionDescription | null) => {
      if (!description?.sdp) return null;
      const lines = description.sdp.split(/\r?\n/);
      const cands = lines.filter((line: string) => line.startsWith('a=candidate:'));
      const t: any = {};
      for (const line of cands) {
        const m = line.match(/ typ (\w+)/); const k = m ? m[1] : 'unknown';
        t[k] = (t[k] ?? 0) + 1;
      }
      return {
        candidateTypes: t, candidateLines: cands.length,
        ufrag: lines.find((line: string) => line.startsWith('a=ice-ufrag:'))?.slice(12) ?? null,
        iceOptions: lines.filter((line: string) => line.startsWith('a=ice-options:')).map((line: string) => line.slice(14)),
        setup: lines.find((line: string) => line.startsWith('a=setup:'))?.slice(8) ?? null,
        bundle: lines.some((line: string) => line.startsWith('a=group:BUNDLE')),
        mAudio: lines.find((line: string) => line.startsWith('m=audio')) ?? null,
        length: description.sdp.length,
      };
    };

    return {
      hasPc: true, pcCount: pcs.length, openPcCount, pcIndex: pcs.indexOf(pc),
      config: {
        iceTransportPolicy: pc.getConfiguration().iceTransportPolicy,
        iceServers: (pc.getConfiguration().iceServers || []).map((entry: any) => ({
          urls: Array.isArray(entry.urls) ? entry.urls : [entry.urls],
          hasCredential: Boolean(entry.username || entry.credential),
        })),
        bundlePolicy: pc.getConfiguration().bundlePolicy,
        rtcpMuxPolicy: pc.getConfiguration().rtcpMuxPolicy,
      },
      states: {
        connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState, signalingState: pc.signalingState,
      },
      localCandidateTypes: types(locals), remoteCandidateTypes: types(remotes),
      localCandidates: locals.map(brief), remoteCandidates: remotes.map(brief),


      selectedPair: selected && {
        local: byId(selected.localCandidateId), remote: byId(selected.remoteCandidateId),
        state: selected.state, nominated: selected.nominated, selected: selected.selected,
        bytesSent: selected.bytesSent, bytesReceived: selected.bytesReceived,
        currentRoundTripTime: selected.currentRoundTripTime,
      },
      pairSummary: pairs.map((p) => ({
        state: p.state, nominated: p.nominated, selected: p.selected,
        local: brief(locals.find((c) => c.id === p.localCandidateId)),
        remote: brief(remotes.find((c) => c.id === p.remoteCandidateId)),
        bytesSent: p.bytesSent, bytesReceived: p.bytesReceived,
      })),
      inboundAudio: inboundAudio && {
        bytesReceived: inboundAudio.bytesReceived, packetsReceived: inboundAudio.packetsReceived,
        packetsLost: inboundAudio.packetsLost, jitter: inboundAudio.jitter,
        audioLevel: inboundAudio.audioLevel, totalAudioEnergy: inboundAudio.totalAudioEnergy,
        totalSamplesReceived: inboundAudio.totalSamplesReceived,
      },
      outboundAudio: outboundAudio && {
        bytesSent: outboundAudio.bytesSent, packetsSent: outboundAudio.packetsSent,
        audioLevel: outboundAudio.audioLevel, totalAudioEnergy: outboundAudio.totalAudioEnergy,
        totalSamplesDuration: outboundAudio.totalSamplesDuration,
      },
      transport: transport && {
        dtlsState: transport.dtlsState, dtlsRole: transport.dtlsRole, iceRole: transport.iceRole,
        iceLocalUsernameFragment: transport.iceLocalUsernameFragment,
        selectedCandidatePairId: transport.selectedCandidatePairId,
        bytesSent: transport.bytesSent, bytesReceived: transport.bytesReceived,
      },
      localSdp: sdp(pc.localDescription), remoteSdp: sdp(pc.remoteDescription),
      audioElement: audio && {
        paused: audio.paused, muted: audio.muted, volume: audio.volume,
        hasSrcObject: Boolean(audio.srcObject),
        srcObjectAudioTracks: audio.srcObject instanceof MediaStream ? audio.srcObject.getAudioTracks().length : 0,
        srcIsSilentClip: Boolean(audio.currentSrc),
      },
      events: probe?.events ?? [], snapshot,
    };
  });

const waitForState = async (page: Page, predicate: (value: any) => boolean, timeoutMs: number) => {
  const start = Date.now();
  let last: any = null;
  while (Date.now() - start < timeoutMs) {
    try { last = await collect(page); if (last && predicate(last)) return last; } catch { /* navigating */ }
    await sleep(300);
  }
  return last;
};

// --- main -------------------------------------------------------------------
const main = async () => {
  let turnServer: any = null;
  if (['turn-all', 'turn-relay', 'turn-relay-fail'].includes(SCENARIO)) {
    turnServer = new Turn({
      listeningPort: 3478, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'],
      authMech: 'long-term', credentials: { [TURN_USER]: TURN_PASS },
      realm: 'probe.local', debugLevel: 'ERROR',
    });
    turnServer.start();
    await sleep(500);
  }

  const { createPrototype2Server } = await import('/workspace/server.ts');
  const server = await createPrototype2Server({ port: 0, serveFrontend: true, ultravoxFetch: fakeUltravoxFetch });
  const base = `http://127.0.0.1:${server.port}`;
  const extraArgs = (process.env.BROWSER_ARGS || '').split(' ').filter(Boolean);

  const browser: Browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage',
      ...extraArgs,
    ],
  });

  const openContext = async (label: string): Promise<BrowserContext> => {
    const context = await browser.newContext({ permissions: ['microphone'] });
    await context.addInitScript(instrument, { hostOnly: process.env.HOST_ONLY === '1' });
    if (process.env.DELAY_OFFER_MS) {
      // Re-order signaling: hold the SDP offer for N ms while trickled ICE
      // candidates are delivered immediately (real networks can reorder them).
      await context.routeWebSocket(/\/ws(?:\?.*)?$/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => server.send(message));
        server.onMessage((message) => {
          let text = '';
          try { text = typeof message === 'string' ? message : Buffer.from(message as any).toString(); } catch { /* ignore */ }
          if (text.includes('"type":"offer"')) {
            setTimeout(() => { try { ws.send(message); } catch { /* closed */ } }, Number(process.env.DELAY_OFFER_MS));
          } else {
            ws.send(message);
          }
        });
      });
    }
    if (process.env.INTERCEPT_ICE === '1') {
      await context.route('**/api/sessions/*/ice-config', async (route) => {
        const response = await route.fetch();
        const json: any = await response.json();
        json.iceServers = []; json.hasStun = false; json.hasTurn = false;
        json.turn = { ...(json.turn || {}), configured: false, credentialMode: 'none' };
        json.warnings = [];
        await route.fulfill({ response, json });
      });
    }
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log(`[${label}] ${m.text()}`); });
    return context;
  };

  const salesContext = await openContext('sales');
  const customerContext = await openContext('customer');
  const salesPage = await salesContext.newPage();
  const customerPage = await customerContext.newPage();
  const result: any = {
    scenario: SCENARIO, browserArgs: extraArgs, startedAt: new Date().toISOString(),
    env: {
      TURN_URLS: process.env.TURN_URLS ?? null, TURN_USERNAME: process.env.TURN_USERNAME ?? null,
      STUN_URLS: process.env.STUN_URLS ?? null, ICE_TRANSPORT_POLICY: process.env.ICE_TRANSPORT_POLICY,
      INTERCEPT_ICE: process.env.INTERCEPT_ICE ?? null,
    },
  };


  try {
    await salesPage.goto(`${base}/sales`, { waitUntil: 'domcontentloaded' });
    await salesPage.waitForSelector('[data-testid="role-salesperson"]', { timeout: 20000 });
    if ((await salesPage.locator('[data-testid="back-to-dashboard"]').count()) === 0) {
      await salesPage.waitForSelector('[data-testid="show-invitation"]', { timeout: 20000 });
      await salesPage.click('[data-testid="show-invitation"]');
      await salesPage.waitForSelector('[data-testid="salesperson-invite-url"]', { timeout: 20000 });
    }
    const inviteUrl = await salesPage.inputValue('[data-testid="salesperson-invite-url"]');
    if (await salesPage.locator('[data-testid="back-to-dashboard"]').count()) {
      await salesPage.click('[data-testid="back-to-dashboard"]');
      await salesPage.waitForSelector('[data-testid="join-call"]', { timeout: 20000 });
    }
    await customerPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
    await customerPage.waitForSelector('[data-testid="customer-prejoin"]', { timeout: 20000 });

    await salesPage.click('[data-testid="join-call"]');
    await customerPage.click('[data-testid="join-call"]');

    await waitForState(
      salesPage,
      (v) => v?.snapshot?.callState === 'connected' &&
        (v?.outboundAudio?.bytesSent ?? 0) > 0 && (v?.inboundAudio?.bytesReceived ?? 0) > 0,
      35000
    );
    await waitForState(customerPage, (v) => v?.snapshot?.callState === 'connected', 15000);

    const samples: any[] = [];
    for (let i = 0; i < 3; i += 1) {
      await sleep(2500);
      const sales = await collect(salesPage);
      const customer = await collect(customerPage);
      const slim = (x: any) => ({
        states: x.states, selectedPair: x.selectedPair,
        localCandidateTypes: x.localCandidateTypes, remoteCandidateTypes: x.remoteCandidateTypes,
        inboundAudio: x.inboundAudio, outboundAudio: x.outboundAudio,
        audioElement: x.audioElement,
        diagnostics: x.snapshot?.diagnostics, mediaFlowing: x.snapshot?.mediaFlowing,
        selectedPairLabel: x.snapshot?.selectedPair, relayCandidates: x.snapshot?.relayCandidates,
      });
      samples.push({ at: Date.now(), salesperson: slim(sales), customer: slim(customer) });
    }
    result.samples = samples;

    const final = async (page: Page) => {
      const value = await collect(page);
      return {
        pcCount: value.pcCount, openPcCount: value.openPcCount, config: value.config,
        states: value.states, localCandidates: value.localCandidates,
        remoteCandidates: value.remoteCandidates, selectedPair: value.selectedPair,
        pairSummary: value.pairSummary, localSdp: value.localSdp, remoteSdp: value.remoteSdp,
        inboundAudio: value.inboundAudio, outboundAudio: value.outboundAudio,
        transport: value.transport, audioElement: value.audioElement,
        snapshot: value.snapshot, events: value.events,
      };
    };
    result.salesperson = await final(salesPage);
    result.customer = await final(customerPage);
    if (SCENARIO === 'turn-relay-fail') {
      const timeline: any[] = [];
      if (turnServer) { turnServer.stop(); turnServer = null; }
      for (let i = 0; i < 50; i += 1) {
        await sleep(2000);
        const sales = await collect(salesPage);
        const customer = await collect(customerPage);
        const slim = (x: any) => ({
          pcStates: x.states ?? x.states,
          states: x.states,
          selected: x.selectedPair,
          callState: x.snapshot?.callState,
          mediaFlowing: x.snapshot?.mediaFlowing,
          recentLogs: (x.snapshot?.logs || []).slice(-5),
        });
        timeline.push({
          t: (i + 1) * 2,
          salesperson: slim(sales),
          customer: slim(customer),
        });
        if (sales.states?.connectionState === 'failed' && customer.states?.connectionState === 'failed') break;
      }
      result.failureTimeline = timeline;
      result.salespersonAfterFailure = await final(salesPage);
      result.customerAfterFailure = await final(customerPage);
    }

  } catch (err) {
    result.error = `${(err as Error)?.message || err}`;
    try { result.salesperson = await collect(salesPage); result.customer = await collect(customerPage); }
    catch { /* ignore */ }
  } finally {
    const file = path.join(OUT_DIR, `${SCENARIO}${process.env.SUFFIX || ''}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`RESULT ${file}`);
    await browser.close();
    await server.close();
    if (turnServer) turnServer.stop();
  }

  const compact = (side: any) => side && {
    states: side.states, pcCount: side.pcCount, openPcCount: side.openPcCount,
    selectedPair: side.selectedPair,
    localCandidateTypes: side.localCandidateTypes ?? side.config,
    bytes: { sent: side.outboundAudio?.bytesSent, received: side.inboundAudio?.bytesReceived },
    mediaFlowing: side.snapshot?.mediaFlowing, callState: side.snapshot?.callState,
    error: side.snapshot?.lastError ?? null,
  };
  console.log(JSON.stringify({
    scenario: SCENARIO, error: result.error ?? null,
    sales: compact(result.salesperson), customer: compact(result.customer),
  }, null, 2));
};

await main();

