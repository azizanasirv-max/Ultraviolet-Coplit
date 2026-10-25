import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../server/sessionStore';

const makeStore = () => new SessionStore({ now: () => Date.now() });

const createWithInvite = (store: SessionStore) => {
  const created = store.createSession('Test call');
  const invitation = store.createInvitation(created.sessionId);
  assert.ok(invitation);
  return { ...created, inviteToken: invitation!.token };
};

test('session creation issues a salesperson key that authorizes only that session', () => {
  const store = makeStore();
  const a = store.createSession('A');
  const b = store.createSession('B');

  assert.ok(store.authorizeSalesperson(a.sessionId, a.salespersonKey));
  assert.equal(store.authorizeSalesperson(a.sessionId, b.salespersonKey), null);
  assert.equal(store.authorizeSalesperson(a.sessionId, 'not-a-key'), null);
  assert.equal(store.authorizeSalesperson(b.sessionId, a.salespersonKey), null);
});

test('salesperson identity cannot be claimed with a URL/role parameter alone', () => {
  const store = makeStore();
  const { sessionId } = createWithInvite(store);

  const anonymous = store.join({ sessionId, claimedRole: 'salesperson', credential: null });
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.ok ? '' : anonymous.code, 'INVALID_CREDENTIAL');

  const invented = store.join({ sessionId, claimedRole: 'salesperson', credential: 'role=salesperson' });
  assert.equal(invented.ok, false);

  const missing = store.join({ sessionId: 'invented-session', claimedRole: 'salesperson', credential: 'x' });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? '' : missing.code, 'SESSION_NOT_FOUND');
});

test('a credential cannot be used with a contradictory role claim', () => {
  const store = makeStore();
  const { sessionId, salespersonKey, inviteToken } = createWithInvite(store);
  const redeemed = store.redeemInvitation(inviteToken);
  assert.equal(redeemed.ok, true);
  if (!redeemed.ok) return;

  const asCustomer = store.join({ sessionId, claimedRole: 'customer', credential: salespersonKey });
  assert.equal(asCustomer.ok, false);
  assert.equal(asCustomer.ok ? '' : asCustomer.code, 'ROLE_MISMATCH');

  const asSalesperson = store.join({ sessionId, claimedRole: 'salesperson', credential: redeemed.customerKey });
  assert.equal(asSalesperson.ok, false);
  assert.equal(asSalesperson.ok ? '' : asSalesperson.code, 'ROLE_MISMATCH');
});

test('an invitation resolves to exactly one session and is single-use', () => {
  const store = makeStore();
  const { sessionId, inviteToken } = createWithInvite(store);

  const first = store.redeemInvitation(inviteToken);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.sessionId, sessionId);

  const replay = store.redeemInvitation(inviteToken);
  assert.equal(replay.ok, false);
  assert.equal(replay.ok ? '' : replay.code, 'INVITE_REDEEMED');

  const resumed = store.redeemInvitation(inviteToken, first.customerKey);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.ok ? resumed.resumed : false, true);

  const wrongKey = store.redeemInvitation(inviteToken, 'someone-elses-key');
  assert.equal(wrongKey.ok, false);
});

test('two sessions are isolated: keys and invitations never cross', () => {
  const store = makeStore();
  const a = createWithInvite(store);
  const b = createWithInvite(store);

  const redeemedA = store.redeemInvitation(a.inviteToken);
  const redeemedB = store.redeemInvitation(b.inviteToken);
  assert.equal(redeemedA.ok, true);
  assert.equal(redeemedB.ok, true);
  if (!redeemedA.ok || !redeemedB.ok) return;

  assert.notEqual(redeemedA.sessionId, redeemedB.sessionId);
  assert.equal(store.authorizeCustomer(a.sessionId, redeemedB.customerKey), null);
  assert.equal(store.authorizeSalesperson(a.sessionId, b.salespersonKey), null);

  const crossJoin = store.join({
    sessionId: a.sessionId,
    credential: redeemedB.customerKey,
    claimedRole: 'customer',
  });
  assert.equal(crossJoin.ok, false);
  assert.equal(crossJoin.ok ? '' : crossJoin.code, 'INVALID_CREDENTIAL');
});

test('rotating an invitation revokes the previous one', () => {
  const store = makeStore();
  const created = store.createSession('rotate');
  const first = store.createInvitation(created.sessionId)!;
  const second = store.createInvitation(created.sessionId)!;

  assert.notEqual(first.token, second.token);
  const old = store.redeemInvitation(first.token);
  assert.equal(old.ok, false);
  assert.equal(old.ok ? '' : old.code, 'INVITE_REVOKED');

  const fresh = store.redeemInvitation(second.token);
  assert.equal(fresh.ok, true);
});

test('expired invitations and expired sessions are rejected', () => {
  let now = 1_000_000;
  const store = new SessionStore({
    now: () => now,
    sessionTtlMs: 10_000,
    invitationTtlMs: 5_000,
  });
  const created = store.createSession('expiring');
  const invitation = store.createInvitation(created.sessionId)!;

  now += 6_000;
  const expiredInvite = store.redeemInvitation(invitation.token);
  assert.equal(expiredInvite.ok, false);
  assert.equal(expiredInvite.ok ? '' : expiredInvite.code, 'INVITE_EXPIRED');

  now += 10_000;
  store.sweep();
  const expiredSession = store.redeemInvitation(invitation.token);
  assert.equal(expiredSession.ok, false);
  const joinExpired = store.join({
    sessionId: created.sessionId,
    credential: created.salespersonKey,
    claimedRole: 'salesperson',
  });
  assert.equal(joinExpired.ok, false);
});

test('reconnect with a resume token reuses the participant identity', () => {
  const store = makeStore();
  const { sessionId, salespersonKey } = createWithInvite(store);

  const first = store.join({ sessionId, credential: salespersonKey, claimedRole: 'salesperson' });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  store.detach(first.participantId);
  const second = store.join({
    sessionId,
    credential: salespersonKey,
    claimedRole: 'salesperson',
    resumeToken: first.resumeToken,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.equal(second.participantId, first.participantId);
  assert.equal(second.replacedConnection, false);

  const session = store.getSession(sessionId)!;
  assert.equal(session.salesperson?.connectionCount, 2);
  assert.equal(session.salesperson?.connected, true);
});

test('a second join without the resume token replaces, never duplicates', () => {
  const store = makeStore();
  const { sessionId, salespersonKey } = createWithInvite(store);
  const first = store.join({ sessionId, credential: salespersonKey, claimedRole: 'salesperson' });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = store.join({ sessionId, credential: salespersonKey, claimedRole: 'salesperson' });
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const session = store.getSession(sessionId)!;
  assert.equal(second.replacedConnection, true);
  assert.equal(session.salesperson?.participantId, first.participantId);
  assert.equal(session.salesperson?.connectionCount, 2);
});

test('a revoked invitation cannot join even though the session is active', () => {
  const store = makeStore();
  const { sessionId, inviteToken } = createWithInvite(store);
  assert.equal(store.revokeInvitation(sessionId), true);

  const result = store.redeemInvitation(inviteToken);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'INVITE_REVOKED');
});

test('invitation tokens are unguessable and never stored in plaintext', () => {
  const store = makeStore();
  const created = store.createSession('secrecy');
  const invitation = store.createInvitation(created.sessionId)!;
  const session = store.getSession(created.sessionId)!;

  assert.ok(invitation.token.length >= 40);
  assert.notEqual(invitation.token, session.invitation?.tokenHash);
  assert.notEqual(created.salespersonKey, session.salespersonKeyHash);
  assert.ok(!JSON.stringify(store.diagnostics(session)).includes(invitation.token));
  assert.ok(!JSON.stringify(store.diagnostics(session)).includes(created.salespersonKey));
});

test('a session AI call can be cleared so a dead join URL is never handed out again', () => {
  const store = makeStore();
  const created = store.createSession('AI lifecycle');
  store.setUltravoxCall(created.sessionId, {
    callId: 'call_old',
    joinUrl: 'wss://ai.invalid/join-old?token=secret',
    createdAt: Date.now(),
    createdByParticipantId: 'p1',
  });

  const session = store.getSession(created.sessionId)!;
  assert.equal(store.publicState(session).aiCallCreated, true);
  assert.equal(store.publicState(session).ai.connected, false);

  const cleared = store.clearUltravoxCall(created.sessionId);
  assert.equal(cleared?.callId, 'call_old');
  assert.equal(store.getUltravoxCall(created.sessionId), null);
  const after = store.getSession(created.sessionId)!;
  assert.equal(store.publicState(after).aiCallCreated, false);
  assert.equal(store.publicState(after).aiReady, false);
});

test('AI runtime liveness is reported separately from "a call record exists"', () => {
  const store = makeStore();
  const created = store.createSession('AI runtime');
  store.setUltravoxCall(created.sessionId, {
    callId: 'call_live',
    joinUrl: 'wss://ai.invalid/join-live',
    createdAt: Date.now(),
    createdByParticipantId: 'p1',
  });

  const running = store.setAiRuntime(created.sessionId, {
    state: 'connected',
    connected: true,
    audioReachingAi: true,
    callId: 'call_live',
    lastSuggestionAt: 1_700_000_000_000,
  });
  assert.ok(running);
  assert.ok(running!.updatedAt > 0);

  const state = store.publicState(store.getSession(created.sessionId)!);
  assert.equal(state.aiCallCreated, true);
  assert.equal(state.ai.state, 'connected');
  assert.equal(state.ai.connected, true);
  assert.equal(state.ai.audioReachingAi, true);
  assert.equal(state.ai.lastSuggestionAt, 1_700_000_000_000);

  // A later failure must flip liveness off while the call record still exists.
  store.setAiRuntime(created.sessionId, {
    state: 'error',
    connected: false,
    error: 'Session socket closed abnormally. code=1006',
    audioReachingAi: false,
    lastSuggestionAt: 1_700_000_000_000,
  });
  const failed = store.publicState(store.getSession(created.sessionId)!);
  assert.equal(failed.aiCallCreated, true);
  assert.equal(failed.ai.connected, false);
  assert.equal(failed.ai.audioReachingAi, false);
  assert.match(String(failed.ai.error), /code=1006/);

  assert.match(String(store.diagnostics(store.getSession(created.sessionId)!).aiLastError), /1006/);
  assert.equal(store.diagnostics(store.getSession(created.sessionId)!).aiCallId, 'call_live');
});

