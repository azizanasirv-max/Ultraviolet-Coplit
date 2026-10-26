/**
 * Customer-facing copy tests.
 *
 * The customer screen must never render internal networking or API detail.
 * These tests pin the mapping for every engine call state and every invitation
 * error code, including unknown codes, and assert that no technical token can
 * come out of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineCallState } from '../src/lib/callEngine';
import {
  customerCallLabel,
  customerCallNotice,
  customerInvitationMessage,
} from '../src/lib/customerMessages';

const CALL_STATES: EngineCallState[] = [
  'idle',
  'requesting_mic',
  'waiting',
  'connecting',
  'connected',
  'disconnected',
  'reconnecting',
  'failed',
  'mic_denied',
  'rejected',
  'ended',
];

/** Tokens that indicate an internal implementation detail leaked into copy. */
const FORBIDDEN_TOKENS = [
  'ICE',
  'TURN',
  'SDP',
  'candidate',
  'webrtc',
  'WebRTC',
  'WebSocket',
  'signaling',
  'fetch',
  'HTTP',
  '401',
  '403',
  '404',
  '500',
  '503',
  'UNAUTHORIZED',
  'TURN_MISCONFIGURED',
  'SESSION_NOT_FOUND',
  'INVITE_',
  'Error',
  'error',
  'undefined',
  'null',
];

const assertCustomerSafe = (value: string, context: string) => {
  assert.ok(value.length > 0, `${context} must not be empty`);
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(
      !value.includes(token),
      `${context} leaked the technical token "${token}": ${value}`
    );
  }
  assert.ok(!/\d{3,}/.test(value), `${context} must not contain status-like numbers: ${value}`);
};

test('every call state has a customer-safe label and notice', () => {
  for (const state of CALL_STATES) {
    assertCustomerSafe(customerCallLabel(state), `label for ${state}`);
    const notice = customerCallNotice(state);
    if (notice !== null) assertCustomerSafe(notice, `notice for ${state}`);
  }
});

test('a healthy call shows no notice', () => {
  assert.equal(customerCallNotice('connected'), null);
});

test('connecting, reconnecting and terminal states use plain language', () => {
  assert.equal(customerCallNotice('connecting'), 'Connecting to your salesperson...');
  assert.equal(customerCallNotice('waiting'), 'Connecting to your salesperson...');
  assert.equal(customerCallNotice('reconnecting'), 'Connection interrupted. Reconnecting...');
  assert.equal(customerCallNotice('disconnected'), 'Connection interrupted. Reconnecting...');
  assert.equal(customerCallNotice('failed'), 'Unable to connect. Please try again.');
  assert.equal(customerCallLabel('failed'), 'Unable to connect');
});

test('invitation error codes are mapped and never echoed', () => {
  const codes = [
    'INVITE_EXPIRED',
    'SESSION_EXPIRED',
    'INVITE_REVOKED',
    'INVITE_REDEEMED',
    'INVITE_NOT_FOUND',
    'LEGACY_LINK',
    'RATE_LIMITED',
    'SOMETHING_NEW_FROM_THE_SERVER',
    '',
    null,
    undefined,
  ];
  for (const code of codes) {
    const message = customerInvitationMessage(code);
    assertCustomerSafe(message, `invitation message for ${String(code)}`);
    if (typeof code === 'string' && code.length > 0) {
      assert.ok(!message.includes(code), `the raw code ${code} must not be rendered`);
    }
  }
});

test('an unknown/absent state falls back instead of rendering raw values', () => {
  assertCustomerSafe(customerCallLabel(undefined), 'label for undefined state');
  assertCustomerSafe(customerCallNotice(undefined) ?? '', 'notice for undefined state');
  assertCustomerSafe(
    customerCallLabel('something-else' as EngineCallState),
    'label for an unknown state'
  );
});
