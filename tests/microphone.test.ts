/**
 * Microphone capture policy tests.
 *
 * These are pure: they prove which processing is requested, how the browser's
 * applied settings are interpreted, and that the helpers never gate, attenuate
 * or otherwise "clean" audio. They cannot prove real-world noise or echo
 * behaviour - that needs physical devices.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTICIPANT_MICROPHONE_POLICY,
  buildMicrophoneConstraints,
  describeMicrophoneProcessing,
  isCapturePublishable,
  readAppliedMicrophoneProcessing,
} from '../src/lib/microphone';

test('the capture requests echo cancellation, noise suppression, no AGC and mono', () => {
  const constraints = buildMicrophoneConstraints() as Record<string, { ideal: unknown }>;

  assert.deepEqual(constraints.echoCancellation, { ideal: true });
  assert.deepEqual(constraints.noiseSuppression, { ideal: true });
  assert.deepEqual(
    constraints.autoGainControl,
    { ideal: false },
    'AGC must be requested off: a moving gain stage pumps and lifts the noise floor in silence'
  );
  assert.deepEqual(
    constraints.channelCount,
    { ideal: 1 },
    'stereo capture breaks AEC on some devices'
  );

  // `ideal` (never `exact`): a device that cannot provide a stage must still
  // return a usable capture. An exact constraint would reject the whole call.
  for (const value of Object.values(constraints)) {
    assert.equal('exact' in value, false);
  }
  // The policy contains exactly the four processing keys: no gate, no extra
  // gain stage, no filter and no level threshold.
  const keys = Object.keys(constraints);
  assert.deepEqual(keys.sort(), ['autoGainControl', 'channelCount', 'echoCancellation', 'noiseSuppression']);
  assert.equal(PARTICIPANT_MICROPHONE_POLICY.autoGainControl, false);
});

test('a custom policy is honoured without changing the constraint shape', () => {
  const constraints = buildMicrophoneConstraints({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 2,
  }) as Record<string, { ideal: unknown }>;

  assert.deepEqual(constraints.echoCancellation, { ideal: false });
  assert.deepEqual(constraints.noiseSuppression, { ideal: false });

test('applied settings are read as reported, and "not reported" is not "off"', () => {
  const applied = readAppliedMicrophoneProcessing({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48000,
  });
  assert.deepEqual(applied, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48000,
  });

  const unknown = readAppliedMicrophoneProcessing(null);
  assert.deepEqual(unknown, {
    echoCancellation: null,
    noiseSuppression: null,
    autoGainControl: null,
    channelCount: null,
    sampleRate: null,
  });

  // A browser that only reports some properties keeps the rest as unknown.
  const partial = readAppliedMicrophoneProcessing({ echoCancellation: true, sampleRate: 16000 });
  assert.equal(partial.echoCancellation, true);
  assert.equal(partial.noiseSuppression, null);
  assert.equal(partial.autoGainControl, null);
  assert.equal(partial.channelCount, null);
  assert.equal(partial.sampleRate, 16000);

  // Junk values never masquerade as a measured state.
  const junk = readAppliedMicrophoneProcessing({ echoCancellation: 'yes', channelCount: NaN });
  assert.equal(junk.echoCancellation, null);
  assert.equal(junk.channelCount, null);
});

test('a healthy capture is summarised as the processing that was applied', () => {
  const report = describeMicrophoneProcessing(
    readAppliedMicrophoneProcessing({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 48000,
    })
  );
  assert.equal(report.summary, 'aec on · ns on · agc off · 1ch · 48000 Hz');
  assert.equal(report.echoCancellationActive, true);
  assert.deepEqual(report.warnings, []);
});

test('echo cancellation that the browser dropped is reported, never assumed', () => {
  const report = describeMicrophoneProcessing(
    readAppliedMicrophoneProcessing({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 2,
      sampleRate: 48000,
    })
  );
  assert.equal(report.echoCancellationActive, false);
  assert.equal(report.summary, 'aec off · ns on · agc on · 2ch · 48000 Hz');
  assert.ok(
    report.warnings.some((warning) => /Echo cancellation is not active/.test(warning)),
    'a dropped AEC stage must be surfaced: it is how a call ends up with echo'
  );
  assert.ok(
    report.warnings.some((warning) => /automatic gain control/.test(warning)),
    'AGC that ignored the policy is surfaced'
  );
  assert.ok(
    report.warnings.some((warning) => /2 channels instead of mono/.test(warning)),
    'stereo capture is surfaced'
  );
});

test('unreported processing is described as unmeasured', () => {
  const report = describeMicrophoneProcessing(readAppliedMicrophoneProcessing({}));
  assert.equal(
    report.summary,
    'aec unmeasured · ns unmeasured · agc unmeasured · ch unmeasured · rate unmeasured'
  );
  assert.equal(report.echoCancellationActive, null);
  assert.ok(report.warnings.some((warning) => /cannot be verified/.test(warning)));
});

test('only a live, unmuted, enabled capture counts as publishable', () => {
  assert.equal(isCapturePublishable(null), false);
  assert.equal(isCapturePublishable({ readyState: 'live' }), true);
  assert.equal(isCapturePublishable({ readyState: 'ended' }), false);
  assert.equal(isCapturePublishable({ readyState: 'live', muted: true }), false);
  assert.equal(isCapturePublishable({ readyState: 'live', enabled: false }), false);
  // A deliberate local mute is not a broken capture: it must never be reacquired.
  assert.equal(isCapturePublishable({ readyState: 'live', enabled: false }, true), true);
  assert.equal(isCapturePublishable({ readyState: 'live', muted: true }, true), false);
});

  assert.deepEqual(constraints.autoGainControl, { ideal: true });
  assert.deepEqual(constraints.channelCount, { ideal: 2 });
});
