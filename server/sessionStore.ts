/**
 * Server-authoritative session, invitation and participant model for Prototype 2.
 *
 * Design constraints (see docs/prototype2-architecture.md):
 *   - A salesperson session is created by the server. The salesperson receives a
 *     high-entropy bearer key exactly once; only its SHA-256 hash is retained.
 *   - A customer joins only by redeeming an unguessable invitation token that is
 *     bound to one session. Redemption is single-use and yields a separate
 *     customer key, so a forwarded invitation cannot take over a live call.
 *   - Roles are derived from *which credential matched*, never from a client
 *     supplied `role` claim alone. The caller's claim is only checked for
 *     consistency.
 *   - Every participant has a server-issued participant id and a reconnect token.
 *   - Storage is process memory only: a restart destroys sessions. That is
 *     documented, not silently pretended away.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export type ParticipantRole = 'customer' | 'salesperson';

export type InvitationStatus = 'active' | 'redeemed' | 'revoked';

export interface ParticipantRecord {
  participantId: string;
  role: ParticipantRole;
  /** SHA-256 of the resume token. The token itself is never stored. */
  resumeTokenHash: string;
  connected: boolean;
  connectedAt: number;
  lastSeenAt: number;
  connectionCount: number;
  /** Latest client-reported diagnostics (sanitised, never tokens or audio). */
  diagnostics: Record<string, unknown> | null;
}

export interface InvitationRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  status: InvitationStatus;
  redeemedAt: number | null;
}

export interface SessionSignalingCounters {
  offers: number;
  answers: number;
  iceCandidates: number;
  aiSuggestions: number;
  rejectedMessages: number;
  relayFailures: number;
  /** Salesperson audio-check requests + customer renegotiation requests. */
  audioChecks: number;
  lastError: string | null;
  lastActivityAt: number;
}

export interface UltravoxCallRecord {
  callId: string;
  /** Media credential. Only ever returned to the authorized session customer. */
  joinUrl: string;
  createdAt: number;
  createdByParticipantId: string;
}

/**
 * Live AI-session state reported by the customer device (the only place the
 * Ultravox session exists). Stored so the salesperson can see the real state
 * even if an individual signaling message was missed, and so diagnostics show
 * liveness rather than "a call record exists".
 */
export interface AiRuntimeRecord {
  state: string;
  connected: boolean;
  error: string | null;
  callId: string | null;
  reconnectAttempt: number;
  audioReachingAi: boolean;
  lastResponseAt: number | null;
  lastSuggestionAt: number | null;
  updatedAt: number;
}

export interface SessionRecord {
  sessionId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  salespersonKeyHash: string;
  customerKeyHash: string | null;
  invitation: InvitationRecord | null;
  salesperson: ParticipantRecord | null;
  customer: ParticipantRecord | null;
  ultravox: UltravoxCallRecord | null;
  ai: AiRuntimeRecord | null;
  signaling: SessionSignalingCounters;
}

export interface SessionPublicState {
  sessionId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  salespersonConnected: boolean;
  customerConnected: boolean;
  invitationStatus: InvitationStatus | 'expired' | 'missing';
  invitationExpiresAt: number | null;
  /**
   * True when a server-side Ultravox call record exists. This is *not* proof
   * that a live session is connected; use `ai.live` / `ai.state` for that.
   */
  aiReady: boolean;
  /** True when the server holds an Ultravox call record for this session. */
  aiCallCreated: boolean;
  /** Sanitised, caller-safe live AI state reported by the customer device. */
  ai: {
    state: string | null;
    connected: boolean;
    error: string | null;
    reconnectAttempt: number;
    audioReachingAi: boolean;
    lastResponseAt: number | null;
    lastSuggestionAt: number | null;
    updatedAt: number | null;
  };
}

export interface SessionDiagnostics extends SessionPublicState {
  aiCallId: string | null;
  aiLastError: string | null;
  participants: Array<{
    participantId: string;
    role: ParticipantRole;
    connected: boolean;
    connectedAt: number;
    lastSeenAt: number;
    connectionCount: number;
    diagnostics: Record<string, unknown> | null;
  }>;
  signals: SessionSignalingCounters;
  serverTime: number;
  storage: 'in-memory';
}

export type JoinErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIAL'
  | 'ROLE_MISMATCH'
  | 'INVITE_NOT_FOUND'
  | 'INVITE_EXPIRED'
  | 'INVITE_REVOKED'
  | 'INVITE_REDEEMED';

export type JoinResult =
  | {
      ok: true;
      sessionId: string;
      role: ParticipantRole;
      participantId: string;
      resumeToken: string;
      replacedConnection: boolean;
      session: SessionPublicState;
    }
  | { ok: false; code: JoinErrorCode; message: string };

export type RedeemResult =
  | {
      ok: true;
      sessionId: string;
      customerKey: string;
      resumed: boolean;
      session: SessionPublicState;
    }
  | { ok: false; code: JoinErrorCode; message: string };

export interface StoreOptions {
  sessionTtlMs?: number;
  invitationTtlMs?: number;
  disconnectedRetentionMs?: number;
  now?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DISCONNECTED_RETENTION_MS = 10 * 60 * 1000;

const secret = (): string => randomBytes(32).toString('base64url');

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');


export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  /** invitation token hash -> session id, for O(1) redemption. */
  private readonly invitationIndex = new Map<string, string>();
  /** revoked/replaced token hash -> session id, so clients get a precise error. */
  private readonly revokedInvitationIndex = new Map<string, string>();
  /** participant id -> session id. */
  private readonly participantIndex = new Map<string, string>();
  private readonly sessionTtlMs: number;
  private readonly invitationTtlMs: number;
  private readonly disconnectedRetentionMs: number;
  private readonly clock: () => number;

  constructor(options: StoreOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.invitationTtlMs = options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS;
    this.disconnectedRetentionMs =
      options.disconnectedRetentionMs ?? DEFAULT_DISCONNECTED_RETENTION_MS;
    this.clock = options.now ?? (() => Date.now());
  }

  private now(): number {
    return this.clock();
  }

  private newSessionRecord(label: string, salespersonKey: string): SessionRecord {
    const now = this.now();
    return {
      sessionId: randomBytes(16).toString('base64url'),
      label,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
      salespersonKeyHash: hash(salespersonKey),
      customerKeyHash: null,
      invitation: null,
      salesperson: null,
      customer: null,
      ultravox: null,
      ai: null,
      signaling: {
        offers: 0,
        answers: 0,
        iceCandidates: 0,
        aiSuggestions: 0,
        rejectedMessages: 0,
        relayFailures: 0,
        audioChecks: 0,
        lastError: null,
        lastActivityAt: now,
      },
    };
  }

  private isExpired(session: SessionRecord): boolean {
    return this.now() > session.expiresAt;
  }

  isExpiredSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !session || this.isExpired(session);
  }

  /** Creates a session owned by a salesperson who has not authenticated yet. */
  createSession(label = 'Sales call'): {
    sessionId: string;
    salespersonKey: string;
    expiresAt: number;
  } {
    this.sweep();
    const salespersonKey = secret();
    const session = this.newSessionRecord(label.slice(0, 80), salespersonKey);
    this.sessions.set(session.sessionId, session);
    console.log(`[session:${redactId(session.sessionId)}] created`);
    return {
      sessionId: session.sessionId,
      salespersonKey,
      expiresAt: session.expiresAt,
    };
  }

  /** Returns the session only when the salesperson key is valid. */
  authorizeSalesperson(sessionId: string, key: string | null | undefined): SessionRecord | null {
    if (!key) return null;
    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session)) return null;
    return hashesEqual(session.salespersonKeyHash, hash(key)) ? session : null;
  }

  authorizeCustomer(sessionId: string, key: string | null | undefined): SessionRecord | null {
    if (!key) return null;
    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session) || !session.customerKeyHash) return null;
    return hashesEqual(session.customerKeyHash, hash(key)) ? session : null;
  }

  /**
   * Mints a fresh invitation for a session. Any previous invitation is revoked,
   * so there is never more than one usable invitation per session.
   */
  createInvitation(sessionId: string): { token: string; expiresAt: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session)) return null;

    if (session.invitation) {
      session.invitation.status = 'revoked';
      this.invitationIndex.delete(session.invitation.tokenHash);
      this.revokedInvitationIndex.set(session.invitation.tokenHash, session.sessionId);
    }

    const token = secret();
    const tokenHash = hash(token);
    const expiresAt = Math.min(this.now() + this.invitationTtlMs, session.expiresAt);
    session.invitation = {
      tokenHash,
      createdAt: this.now(),
      expiresAt,
      status: 'active',
      redeemedAt: null,
    };
    this.invitationIndex.set(tokenHash, session.sessionId);
    return { token, expiresAt };
  }

  /**
   * Redeems an invitation token.
   *
   * `existingCustomerKey` makes the call idempotent for a legitimate rejoin from
   * the same browser: it is accepted even after the invitation itself has been
   * consumed, but never grants access to a different session.
   */
  redeemInvitation(token: string, existingCustomerKey?: string | null): RedeemResult {
    this.sweep();
    const tokenHash = hash(token);
    const sessionId = this.invitationIndex.get(tokenHash);

    // A customer key alone cannot redeem a *different* invitation, but it does
    // allow the same customer to rejoin after the link was consumed.
    if (!sessionId) {
      const revokedSessionId = this.revokedInvitationIndex.get(tokenHash);
      if (revokedSessionId) {
        return {
          ok: false,
          code: 'INVITE_REVOKED',
          message: 'This invitation was replaced or revoked by the salesperson.',
        };
      }
      if (existingCustomerKey) {
        for (const session of this.sessions.values()) {
          if (
            !this.isExpired(session) &&
            session.customerKeyHash &&
            hashesEqual(session.customerKeyHash, hash(existingCustomerKey))
          ) {
            return {
              ok: true,
              sessionId: session.sessionId,
              customerKey: existingCustomerKey,
              resumed: true,
              session: this.publicState(session),
            };
          }
        }
      }
      return { ok: false, code: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid.' };
    }

    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session)) {
      return {
        ok: false,
        code: 'SESSION_EXPIRED',
        message: 'This sales session has ended. Ask the salesperson for a new invitation.',
      };
    }

    const invitation = session.invitation;
    if (!invitation) {
      return { ok: false, code: 'INVITE_NOT_FOUND', message: 'This invitation link is no longer valid.' };
    }

    if (invitation.status === 'revoked') {
      return {
        ok: false,
        code: 'INVITE_REVOKED',
        message: 'This invitation was replaced or revoked by the salesperson.',
      };
    }

    if (this.now() > invitation.expiresAt) {
      return {
        ok: false,
        code: 'INVITE_EXPIRED',
        message: 'This invitation has expired. Ask the salesperson for a new one.',
      };
    }

    if (existingCustomerKey && hashesEqual(session.customerKeyHash, hash(existingCustomerKey))) {
      return {
        ok: true,
        sessionId: session.sessionId,
        customerKey: existingCustomerKey,
        resumed: true,
        session: this.publicState(session),
      };
    }

    if (invitation.status === 'redeemed') {
      return {
        ok: false,
        code: 'INVITE_REDEEMED',
        message:
          'This invitation has already been used on another device. Ask the salesperson to generate a new invitation.',
      };
    }

    if (session.customer && session.customer.connected) {
      return {
        ok: false,
        code: 'INVITE_REDEEMED',
        message: 'A customer is already connected to this session.',
      };
    }

    const customerKey = secret();
    session.customerKeyHash = hash(customerKey);
    invitation.status = 'redeemed';
    invitation.redeemedAt = this.now();
    console.log(`[session:${redactId(session.sessionId)}] invitation redeemed`);
    return {
      ok: true,
      sessionId: session.sessionId,
      customerKey,
      resumed: false,
      session: this.publicState(session),
    };
  }

  /**
   * Authorizes a WebSocket join.
   *
   * Role is derived from the credential: a salesperson key can only produce a
   * salesperson participant, a customer key only a customer participant. A
   * contradictory `claimedRole` is rejected rather than silently corrected.
   */
  join(params: {
    sessionId: string;
    claimedRole?: ParticipantRole | null;
    credential: string | null | undefined;
    resumeToken?: string | null;
  }): JoinResult {
    this.sweep();
    const { sessionId, credential, resumeToken } = params;
    const session = this.sessions.get(sessionId);

    if (!session) {
      return { ok: false, code: 'SESSION_NOT_FOUND', message: 'Unknown sales session.' };
    }
    if (this.isExpired(session)) {
      return { ok: false, code: 'SESSION_EXPIRED', message: 'This sales session has ended.' };
    }
    if (!credential) {
      return { ok: false, code: 'INVALID_CREDENTIAL', message: 'A participant credential is required.' };
    }

    const credentialHash = hash(credential);
    let role: ParticipantRole | null = null;
    if (hashesEqual(session.salespersonKeyHash, credentialHash)) {
      role = 'salesperson';
    } else if (hashesEqual(session.customerKeyHash, credentialHash)) {
      role = 'customer';
    }

    if (!role) {
      return {
        ok: false,
        code: 'INVALID_CREDENTIAL',
        message: 'The supplied credential is not valid for this session.',
      };
    }

    if (params.claimedRole && params.claimedRole !== role) {
      return {
        ok: false,
        code: 'ROLE_MISMATCH',
        message: `This credential grants the "${role}" role, not "${params.claimedRole}".`,
      };
    }

    const existing = role === 'salesperson' ? session.salesperson : session.customer;

    // Reconnecting participant: same identity, never a duplicate participant.
    if (existing && resumeToken && hashesEqual(existing.resumeTokenHash, hash(resumeToken))) {
      const replacedConnection = existing.connected;
      existing.connected = true;
      existing.lastSeenAt = this.now();
      existing.connectionCount += 1;
      this.participantIndex.set(existing.participantId, session.sessionId);
      return {
        ok: true,
        sessionId,
        role,
        participantId: existing.participantId,
        resumeToken,
        replacedConnection,
        session: this.publicState(session),
      };
    }

    // A live participant without the resume token is replaced, not duplicated.
    const replacedConnection = Boolean(existing?.connected);
    const participantId = existing?.participantId ?? randomBytes(12).toString('base64url');
    const newResumeToken = secret();
    const record: ParticipantRecord = {
      participantId,
      role,
      resumeTokenHash: hash(newResumeToken),
      connected: true,
      connectedAt: existing?.connectedAt ?? this.now(),
      lastSeenAt: this.now(),
      connectionCount: (existing?.connectionCount ?? 0) + 1,
      diagnostics: existing?.diagnostics ?? null,
    };

    if (role === 'salesperson') session.salesperson = record;
    else session.customer = record;
    this.participantIndex.set(participantId, sessionId);

    console.log(
      `[session:${redactId(sessionId)}] ${role} joined (participant ${redactId(participantId)})` +
        (replacedConnection ? ', replacing a live connection' : '')
    );

    return {
      ok: true,
      sessionId,
      role,
      participantId,
      resumeToken: newResumeToken,
      replacedConnection,
      session: this.publicState(session),
    };
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Returns the participant for a connection, or null when it was detached. */
  getParticipant(participantId: string): {
    session: SessionRecord;
    participant: ParticipantRecord;
  } | null {
    const sessionId = this.participantIndex.get(participantId);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const participant =
      session.salesperson?.participantId === participantId
        ? session.salesperson
        : session.customer?.participantId === participantId
          ? session.customer
          : null;
    if (!participant) return null;
    return { session, participant };
  }

  touch(participantId: string): void {
    const found = this.getParticipant(participantId);
    if (!found) return;
    found.participant.lastSeenAt = this.now();
    found.session.signaling.lastActivityAt = this.now();
  }

  detach(participantId: string): { session: SessionRecord; role: ParticipantRole } | null {
    const found = this.getParticipant(participantId);
    if (!found) return null;
    const { session, participant } = found;
    participant.connected = false;
    participant.lastSeenAt = this.now();
    console.log(
      `[session:${redactId(session.sessionId)}] ${participant.role} disconnected (participant ${redactId(participantId)})`
    );
    return { session, role: participant.role };
  }

  setDiagnostics(participantId: string, diagnostics: Record<string, unknown> | null): void {
    const found = this.getParticipant(participantId);
    if (!found) return;
    found.participant.diagnostics = diagnostics;
    found.participant.lastSeenAt = this.now();
  }

  countSignal(
    sessionId: string,
    kind:
      | 'offers'
      | 'answers'
      | 'iceCandidates'
      | 'aiSuggestions'
      | 'rejectedMessages'
      | 'relayFailures'
      | 'audioChecks'
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.signaling[kind] += 1;
    session.signaling.lastActivityAt = this.now();
  }

  recordError(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.signaling.lastError = message.slice(0, 300);
    session.signaling.lastActivityAt = this.now();
  }

  /** Marks the current invitation unusable without issuing a replacement. */
  revokeInvitation(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.invitation) return false;
    session.invitation.status = 'revoked';
    this.invitationIndex.delete(session.invitation.tokenHash);
    this.revokedInvitationIndex.set(session.invitation.tokenHash, session.sessionId);
    return true;
  }

  getUltravoxCall(sessionId: string): UltravoxCallRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session)) return null;
    return session.ultravox;
  }

  setUltravoxCall(sessionId: string, call: UltravoxCallRecord): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ultravox = call;
  }

  /**
   * Forgets the session's Ultravox call. A join URL is a one-time media
   * credential for a specific call; once that call has ended (or before a new
   * customer device joins) the only safe recovery is a brand new call.
   */
  clearUltravoxCall(sessionId: string): UltravoxCallRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const previous = session.ultravox;
    session.ultravox = null;
    return previous;
  }

  /** Stores the customer-reported AI runtime state (already sanitised). */
  setAiRuntime(
    sessionId: string,
    patch: Partial<Omit<AiRuntimeRecord, 'updatedAt'>> & { state: string }
  ): AiRuntimeRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const previous = session.ai;
    session.ai = {
      state: patch.state,
      connected: patch.connected ?? previous?.connected ?? false,
      error: patch.error !== undefined ? patch.error : previous?.error ?? null,
      callId: patch.callId !== undefined ? patch.callId : previous?.callId ?? null,
      reconnectAttempt: patch.reconnectAttempt ?? previous?.reconnectAttempt ?? 0,
      audioReachingAi: patch.audioReachingAi ?? previous?.audioReachingAi ?? false,
      lastResponseAt:
        patch.lastResponseAt !== undefined ? patch.lastResponseAt : previous?.lastResponseAt ?? null,
      lastSuggestionAt:
        patch.lastSuggestionAt !== undefined ? patch.lastSuggestionAt : previous?.lastSuggestionAt ?? null,
      updatedAt: this.now(),
    };
    return session.ai;
  }

  getAiRuntime(sessionId: string): AiRuntimeRecord | null {
    return this.sessions.get(sessionId)?.ai ?? null;
  }

  publicState(session: SessionRecord): SessionPublicState {
    const invitation = session.invitation;
    let invitationStatus: SessionPublicState['invitationStatus'] = 'missing';
    if (invitation) {
      if (invitation.status === 'revoked') invitationStatus = 'revoked';
      else if (this.now() > invitation.expiresAt) invitationStatus = 'expired';
      else invitationStatus = invitation.status;
    }
    return {
      sessionId: session.sessionId,
      label: session.label,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      salespersonConnected: Boolean(session.salesperson?.connected),
      customerConnected: Boolean(session.customer?.connected),
      invitationStatus,
      invitationExpiresAt: invitation?.expiresAt ?? null,
      // Meaning: a call record exists. Never treat this as proof of a live
      // connection; `ai.connected`/`ai.state` carry the reported live state.
      aiReady: Boolean(session.ultravox),
      aiCallCreated: Boolean(session.ultravox),
      ai: {
        state: session.ai?.state ?? null,
        connected: Boolean(session.ai?.connected),
        error: session.ai?.error ?? null,
        reconnectAttempt: session.ai?.reconnectAttempt ?? 0,
        audioReachingAi: Boolean(session.ai?.audioReachingAi),
        lastResponseAt: session.ai?.lastResponseAt ?? null,
        lastSuggestionAt: session.ai?.lastSuggestionAt ?? null,
        updatedAt: session.ai?.updatedAt ?? null,
      },
    };
  }

  diagnostics(session: SessionRecord): SessionDiagnostics {
    const participants = [session.salesperson, session.customer]
      .filter((p): p is ParticipantRecord => Boolean(p))
      .map((p) => ({
        participantId: p.participantId,
        role: p.role,
        connected: p.connected,
        connectedAt: p.connectedAt,
        lastSeenAt: p.lastSeenAt,
        connectionCount: p.connectionCount,
        diagnostics: p.diagnostics,
      }));

    return {
      ...this.publicState(session),
      aiCallId: session.ultravox?.callId ?? session.ai?.callId ?? null,
      aiLastError: session.ai?.error ?? null,
      participants,
      signals: { ...session.signaling },
      serverTime: this.now(),
      storage: 'in-memory',
    };
  }

  /** Drops participants gone past retention, then expired sessions. */
  sweep(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      for (const participant of [session.salesperson, session.customer]) {
        if (
          participant &&
          !participant.connected &&
          now - participant.lastSeenAt > this.disconnectedRetentionMs
        ) {
          this.participantIndex.delete(participant.participantId);
          if (participant.role === 'salesperson') session.salesperson = null;
          else session.customer = null;
        }
      }

      if (now > session.expiresAt) {
        if (session.invitation) this.invitationIndex.delete(session.invitation.tokenHash);
        if (session.salesperson) this.participantIndex.delete(session.salesperson.participantId);
        if (session.customer) this.participantIndex.delete(session.customer.participantId);
        this.sessions.delete(session.sessionId);
      }
    }

    for (const [tokenHash, sessionId] of this.revokedInvitationIndex) {
      if (!this.sessions.has(sessionId)) this.revokedInvitationIndex.delete(tokenHash);
    }
  }

  stats(): { sessions: number; invitations: number; participants: number } {
    return {
      sessions: this.sessions.size,
      invitations: this.invitationIndex.size,
      participants: this.participantIndex.size,
    };
  }
}

/** Constant-time comparison of two hex digests. */
export const hashesEqual = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const redactId = (value: string): string => value.slice(0, 8);
