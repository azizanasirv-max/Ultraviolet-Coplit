/**
 * The salesperson UI must never turn "connected" into "audio works".
 *
 * `describeCustomerAudio` is the single place where the five independent facts
 * (customer present, transport connected, packets arriving, sound measurable,
 * playback working) are combined, so it is tested directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CustomerAudioInput,
  describeCustomerAudio,
  formatAudioLevel,
  INBOUND_SOUND_RMS_THRESHOLD,
} from '../src/lib/audioDiagnostics';

const healthy: CustomerAudioInput = {
  customerConnected: true,
  callState: 'connected',
  pcState: 'connected',
  inboundPackets: 480,
  inboundBytes: 76800,
  inboundAudioLevel: 0.08,
  soundDetected: true,
  playbackBlocked: false,
  playbackState: 'playing',
  remoteTrackState: 'live',
  speakerMuted: false,
};

const withInput = (patch: Partial<CustomerAudioInput>): CustomerAudioInput => ({ ...healthy, ...patch });

test('a fully measured call is the only state reported as working audio', () => {
  const report = describeCustomerAudio(healthy);
  assert.equal(report.state, 'ok');
  assert.equal(report.tone, 'emerald');
  assert.equal(report.warning, null);
  assert.equal(report.transportConnected, true);
  assert.equal(report.receivingPackets, true);
  assert.equal(report.audibleSound, true);
  assert.equal(report.playbackWorking, true);
});

test('a connected transport without packets is never reported as working audio', () => {
  const report = describeCustomerAudio(
    withInput({ inboundPackets: 0, inboundBytes: 0, soundDetected: false, inboundAudioLevel: 0, playbackState: 'no_track' })
  );
  assert.equal(report.state, 'no_packets');
  assert.equal(report.transportConnected, true);
  assert.equal(report.receivingPackets, false);
  assert.equal(report.audibleSound, false);
  assert.ok(report.warning);
  assert.equal(report.warning?.action, 'reconnect');
  assert.notEqual(report.tone, 'emerald');
});

test('packets that contain no measurable sound are reported as silent', () => {
  const report = describeCustomerAudio(withInput({ soundDetected: false, inboundAudioLevel: 0.0004 }));
  assert.equal(report.state, 'silent');
  assert.equal(report.receivingPackets, true, 'packets are still arriving');
  assert.equal(report.audibleSound, false);
  assert.equal(report.playbackWorking, true);
  assert.match(String(report.warning?.title), /silence/i);
});

test('blocked playback is its own state with an Enable audio action', () => {
  for (const input of [
    withInput({ playbackBlocked: true }),
    withInput({ playbackBlocked: false, playbackState: 'blocked' }),
    withInput({ playbackState: 'paused' }),
  ]) {
    const report = describeCustomerAudio(input);
    assert.equal(report.state, 'playback_blocked');
    assert.equal(report.warning?.action, 'enable_audio');
    assert.equal(report.playbackWorking, false);
  }
});

test('an absent customer and a pending transport are distinguished from failures', () => {
  const absent = describeCustomerAudio(withInput({ customerConnected: false, pcState: 'none', inboundPackets: 0 }));
  assert.equal(absent.state, 'no_customer');
  assert.equal(absent.warning, null);

  const connecting = describeCustomerAudio(withInput({ callState: 'connecting', pcState: 'connecting', inboundPackets: 0 }));
  assert.equal(connecting.state, 'connecting');
  assert.equal(connecting.warning, null, 'a connecting call is not an error yet');

  const stalled = describeCustomerAudio(
    withInput({ callState: 'connected', pcState: 'disconnected', inboundPackets: 0 })
  );
  assert.equal(stalled.state, 'connecting');
  assert.equal(stalled.warning?.action, 'reconnect');
});

test('a locally muted speaker is reported as a choice, not a failure', () => {
  const report = describeCustomerAudio(withInput({ speakerMuted: true }));
  assert.equal(report.state, 'muted_locally');
  assert.equal(report.warning, null);
  // Playback itself is healthy; the output was silenced deliberately.
  assert.equal(report.playbackWorking, true);
  assert.equal(report.receivingPackets, true);
});

test('the missing remote track is visible even when ICE reports connected', () => {
  const report = describeCustomerAudio(
    withInput({ remoteTrackState: 'none', inboundPackets: 0, inboundBytes: 0, soundDetected: false })
  );
  assert.equal(report.transportConnected, true);
  assert.equal(report.state, 'no_packets');
  assert.ok(report.warning);
});

test('audio levels are formatted in rms and dBFS', () => {
  assert.equal(formatAudioLevel(null), 'not measured');
  assert.equal(formatAudioLevel(0), 'silent (-∞ dBFS)');
  assert.match(formatAudioLevel(0.5), /0\.5000 rms \(-6\.0 dBFS\)/);
  assert.ok(INBOUND_SOUND_RMS_THRESHOLD > 0 && INBOUND_SOUND_RMS_THRESHOLD < 0.05);
});
