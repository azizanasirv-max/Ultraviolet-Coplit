/**
 * Two-peer WebRTC audio diagnostic.
 *
 * Drives the real Prototype 2 UI in two isolated Chromium browser contexts
 * (one salesperson, one customer) against a running server, then reads the
 * RTCPeerConnection stats for both peers. It answers the only question that
 * matters for the reported bug:
 *
 *   - Was an RTCPeerConnection actually created on each side?
 *   - Does each side have a live *local* microphone sender track?
 *   - Does each side have a *remote* audio receiver track?
 *   - Are RTP audio packets flowing in BOTH directions (bytesSent/bytesReceived)?
 *   - Is the hidden <audio> element attached, unmuted and playing?
 *
 * Usage:
 *   PORT=3100 npm start            # in one shell
 *   node scripts/p2p-audio-diagnostic.mjs [http://localhost:3100]
 *
 * Requires Playwright with a Chromium build:
 *   npm i -D playwright && npx playwright install chromium
 *
 * Chromium's fake media device is used for capture, so this validates the
 * signalling + media plumbing, not physical-device acoustics.
 */
import { chromium } from 'playwright';

const BASE_URL = (process.argv[2] || process.env.DIAG_BASE_URL || 'http://localhost:3100').replace(/\/$/, '');
const ROOM = `diag-${Date.now().toString(36)}`;

const initScript = () => {
  // Record every peer connection the app creates so the harness can inspect it.
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new Original(...args);
    window.__pcs.push(pc);
    pc.addEventListener('track', (event) => {
      window.__lastTrackEvent = {
        kind: event.track.kind,
        streams: event.streams.length,
        at: Date.now(),
      };
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);

  // Capture getUserMedia invocations to prove who captured a microphone.
  const originalGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__gumCalls = 0;
  navigator.mediaDevices.getUserMedia = (constraints) => {
    window.__gumCalls += 1;
    return originalGum(constraints);
  };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(page) {
  return page.evaluate(async () => {
    const out = [];
    const audio = document.querySelector('audio');
    for (const [index, pc] of (window.__pcs || []).entries()) {
      const stats = await pc.getStats();
      const senders = pc.getSenders().map((s) => ({
        kind: s.track?.kind ?? null,
        readyState: s.track?.readyState ?? null,
        enabled: s.track?.enabled ?? null,
        muted: s.track?.muted ?? null,
        label: s.track?.label ?? null,
      }));
      const receivers = pc.getReceivers().map((r) => ({
        kind: r.track?.kind ?? null,
        readyState: r.track?.readyState ?? null,
        enabled: r.track?.enabled ?? null,
        muted: r.track?.muted ?? null,
      }));
      let inboundAudio = null;
      let outboundAudio = null;
      let selectedPair = null;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          inboundAudio = {
            bytesReceived: report.bytesReceived,
            packetsReceived: report.packetsReceived,
            totalAudioEnergy: report.totalAudioEnergy,
            trackIdentifier: report.trackIdentifier,
          };
        }
        if (report.type === 'outbound-rtp' && report.kind === 'audio') {
          outboundAudio = {
            bytesSent: report.bytesSent,
            packetsSent: report.packetsSent,
          };
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          selectedPair = { local: report.localCandidateId, remote: report.remoteCandidateId };
        }
      });
      out.push({
        index,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        localSdpMedia: (pc.localDescription?.sdp || '')
          .split('\n')
          .filter((l) => l.startsWith('m=') || l.startsWith('a=sendrecv') || l.startsWith('a=sendonly') || l.startsWith('a=recvonly')),
        senders,
        receivers,
        inboundAudio,
        outboundAudio,
        selectedPair,
      });
    }
    return {
      gumCalls: window.__gumCalls || 0,
      audioElementCount: document.querySelectorAll('audio').length,
      lastTrackEvent: window.__lastTrackEvent || null,
      pcCount: (window.__pcs || []).length,
      audioElement: audio
        ? {
            hasSrcObject: Boolean(audio.srcObject),
            audioTracks: audio.srcObject ? audio.srcObject.getAudioTracks().length : 0,
            paused: audio.paused,
            muted: audio.muted,
            volume: audio.volume,
            autoplay: audio.autoplay,
            display: getComputedStyle(audio).display,
            currentTime: audio.currentTime,
            readyState: audio.readyState,
          }
        : null,
      statusText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1600),
      pcs: out,
    };
  });
}

/** Samples both peers twice so RTP byte counters can be compared as deltas. */
async function sample(page) {
  const first = await collect(page);
  await wait(3000);
  const second = await collect(page);
  const deltas = (second.pcs || []).map((pc, i) => ({
    index: i,
    bytesSentDelta: (pc.outboundAudio?.bytesSent ?? 0) - (first.pcs?.[i]?.outboundAudio?.bytesSent ?? 0),
    bytesReceivedDelta:
      (pc.inboundAudio?.bytesReceived ?? 0) - (first.pcs?.[i]?.inboundAudio?.bytesReceived ?? 0),
  }));
  return { first, second, deltas };
}

async function main() {
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const contextOptions = { permissions: ['microphone'], ignoreHTTPSErrors: true };
  const salespersonCtx = await browser.newContext(contextOptions);
  const customerCtx = await browser.newContext(contextOptions);
  const salesperson = await salespersonCtx.newPage();
  const customer = await customerCtx.newPage();

  const logs = { salesperson: [], customer: [] };
  salesperson.on('console', (m) => logs.salesperson.push(m.text()));
  customer.on('console', (m) => logs.customer.push(m.text()));
  salesperson.on('pageerror', (e) => logs.salesperson.push(`PAGEERROR ${e.message}`));
  customer.on('pageerror', (e) => logs.customer.push(`PAGEERROR ${e.message}`));

  for (const page of [salesperson, customer]) await page.addInitScript(initScript);

  const url = (role) => `${BASE_URL}/?prototype=2&room=${ROOM}&role=${role}`;
  await salesperson.goto(url('salesperson'));
  await customer.goto(url('customer'));

  const customerFirst = process.env.DIAG_ORDER === 'customer-first';
  const joinSalesperson = () => salesperson.getByRole('button', { name: /Open Salesperson Dashboard/i }).click();
  const joinCustomer = () => customer.getByRole('button', { name: /Join Sales Call as Customer/i }).click();

  const readAudioState = (page) =>
    page.evaluate(() => {
      const el = document.querySelector('audio');
      return el
        ? { paused: el.paused, loop: el.loop, hasSrc: Boolean(el.getAttribute('src')), muted: el.muted }
        : null;
    });

  let firstJoinAudio = null;
  if (customerFirst) {
    await joinCustomer();
    await wait(1500);
    firstJoinAudio = await readAudioState(customer);
    await joinSalesperson();
  } else {
    await joinSalesperson();
    await wait(1500);
    firstJoinAudio = await readAudioState(salesperson);
    await joinCustomer();
  }

  await wait(7000);

  const salespersonStats = await sample(salesperson);
  const customerStats = await sample(customer);
  const salespersonAppDiag = await salesperson.evaluate(() => (window.__p2pDiagnostics ? window.__p2pDiagnostics() : null));
  const customerAppDiag = await customer.evaluate(() => (window.__p2pDiagnostics ? window.__p2pDiagnostics() : null));

  console.log('\n=== LOG (salesperson) ===');
  console.log(logs.salesperson.join('\n'));
  console.log('\n=== LOG (customer) ===');
  console.log(logs.customer.join('\n'));
  console.log('\n=== SALESPERSON PEER STATE ===');
  console.log(JSON.stringify(salespersonStats, null, 2));
  console.log('\n=== CUSTOMER PEER STATE ===');
  console.log(JSON.stringify(customerStats, null, 2));

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  check(
    'remote <audio> unlocked during the join gesture (before the peer connects)',
    firstJoinAudio && firstJoinAudio.paused === false && firstJoinAudio.hasSrc && firstJoinAudio.muted === false,
    JSON.stringify(firstJoinAudio)
  );

  check(
    'exactly one application audio element per page (no duplicate playback)',
    salespersonStats.second.audioElementCount === 1 && customerStats.second.audioElementCount === 1,
    `salesperson=${salespersonStats.second.audioElementCount} customer=${customerStats.second.audioElementCount}`
  );

  for (const [label, stats] of [
    ['salesperson', salespersonStats],
    ['customer', customerStats],
  ]) {
    const pc = stats.second.pcs?.[0];
    const delta = stats.deltas?.[0];
    check(`${label}: RTCPeerConnection created`, stats.second.pcCount === 1, `pcCount=${stats.second.pcCount}`);
    check(`${label}: peer connection connected`, pc?.connectionState === 'connected', pc?.connectionState);
    check(
      `${label}: local microphone sender live`,
      pc?.senders?.some((s) => s.kind === 'audio' && s.readyState === 'live' && s.enabled && !s.muted),
      JSON.stringify(pc?.senders)
    );
    check(
      `${label}: remote audio receiver present`,
      pc?.receivers?.some((r) => r.kind === 'audio' && r.readyState === 'live'),
      JSON.stringify(pc?.receivers)
    );
    check(`${label}: RTP audio sent in last 3s`, (delta?.bytesSentDelta ?? 0) > 0, `${delta?.bytesSentDelta} bytes`);
    check(
      `${label}: RTP audio received in last 3s`,
      (delta?.bytesReceivedDelta ?? 0) > 0,
      `${delta?.bytesReceivedDelta} bytes`
    );
    check(
      `${label}: remote <audio> playing (not paused/muted)`,
      stats.second.audioElement?.hasSrcObject &&
        stats.second.audioElement.paused === false &&
        stats.second.audioElement.muted === false,
      JSON.stringify(stats.second.audioElement)
    );
  }

  console.log('\n=== RESULT ===');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
  console.log(`\nApp diagnostics (salesperson): ${JSON.stringify(salespersonAppDiag)}`);
  console.log(`App diagnostics (customer):    ${JSON.stringify(customerAppDiag)}`);
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);

  await browser.close();
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

