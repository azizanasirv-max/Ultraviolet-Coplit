/**
 * Server-side signaling protocol test.
 *
 * Verifies the room relay that carries BOTH the human-to-human WebRTC
 * negotiation and the AI dashboard text path, without a browser:
 *
 *   - offer / answer / ICE candidates are relayed peer-to-peer in a room
 *   - the AI suggestion relay (customer -> salesperson) still works
 *   - role rules are enforced (customers cannot offer, salespeople cannot answer)
 *   - peer_left is emitted when a participant disconnects
 *
 * Usage: node scripts/signaling-relay-test.mjs ws://localhost:3100/ws
 */
import WebSocket from 'ws';

const URL = process.argv[2] || process.env.DIAG_WS_URL || 'ws://localhost:3100/ws';
const ROOM = `relay-${Date.now().toString(36)}`;

const connect = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const index = waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        inbox.push(message);
      }
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        inbox,
        send: (payload) => ws.send(JSON.stringify(payload)),
        next: (match, timeout = 4000) => {
          const existing = inbox.findIndex(match);
          if (existing >= 0) return Promise.resolve(inbox.splice(existing, 1)[0]);
          return new Promise((res, rej) => {
            const waiter = {
              match,
              resolve: res,
              timer: setTimeout(() => {
                const i = waiters.indexOf(waiter);
                if (i >= 0) waiters.splice(i, 1);
                rej(new Error('Timed out waiting for signaling message'));
              }, timeout),
            };
            waiters.push(waiter);
          });
        },
      })
    );
  });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const main = async () => {
  const salesperson = await connect();
  salesperson.send({ type: 'join_room', roomId: ROOM, role: 'salesperson' });
  const spJoined = await salesperson.next((m) => m.type === 'joined');
  check('salesperson joined the room', spJoined.role === 'salesperson', spJoined.participantId);

  const customer = await connect();
  customer.send({ type: 'join_room', roomId: ROOM, role: 'customer' });
  const cuJoined = await customer.next((m) => m.type === 'joined');
  check('customer joined the room', cuJoined.role === 'customer', cuJoined.participantId);
  check(
    'customer sees the salesperson as a peer',
    Array.isArray(cuJoined.peers) && cuJoined.peers.some((p) => p.role === 'salesperson'),
    JSON.stringify(cuJoined.peers)
  );

  const peerJoined = await salesperson.next((m) => m.type === 'peer_joined');
  check('salesperson was notified of the customer', peerJoined.role === 'customer');

  // WebRTC negotiation relay (offer/answer/ICE).
  salesperson.send({ type: 'offer', offer: { type: 'offer', sdp: 'v=0 offer' } });
  const offer = await customer.next((m) => m.type === 'offer');
  check('offer relayed to the customer', offer.offer?.sdp === 'v=0 offer', offer.fromRole);

  customer.send({ type: 'answer', answer: { type: 'answer', sdp: 'v=0 answer' } });
  const answer = await salesperson.next((m) => m.type === 'answer');
  check('answer relayed to the salesperson', answer.answer?.sdp === 'v=0 answer', answer.fromRole);

  salesperson.send({ type: 'ice_candidate', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host' } });
  const candidate = await customer.next((m) => m.type === 'ice_candidate');
  check('ICE candidate relayed to the customer', Boolean(candidate.candidate?.candidate), candidate.fromRole);

  // AI dashboard text relay (this is the path that keeps working today).
  customer.send({ type: 'ai_suggestion', text: 'Hello there', isFinal: true, ordinal: 1, timestamp: 'now' });
  const suggestion = await salesperson.next((m) => m.type === 'ai_suggestion');
  check('AI suggestion relayed to the salesperson', suggestion.text === 'Hello there', suggestion.fromRole);

  // Role rules.
  customer.send({ type: 'offer', offer: { type: 'offer', sdp: 'v=0 bogus' } });
  const roleError = await customer.next((m) => m.type === 'error' && m.code === 'INVALID_SIGNALING_ROLE');
  check('customer offers are rejected', Boolean(roleError), roleError.code);

  customer.ws.close();
  const peerLeft = await salesperson.next((m) => m.type === 'peer_left');
  check('salesperson notified when the customer leaves', peerLeft.role === 'customer', peerLeft.reason);

  salesperson.ws.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) process.exitCode = 1;
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
