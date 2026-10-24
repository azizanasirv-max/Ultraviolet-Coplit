import React, { useState, useEffect, useRef } from 'react';
import { UltravoxSession, UltravoxSessionStatus, Role, Medium } from 'ultravox-client';
import { buildCustomerInviteUrl, isAistudioDevPreview } from '../lib/inviteUrl';
import {
  Mic,
  Square,
  Copy,
  Check,
  AlertCircle,
  Radio,
  Share2,
  Users,
  Send,
  Sparkles,
  ExternalLink,
  Volume2,
  VolumeX,
  ShieldCheck,
  PhoneCall,
  PhoneOff,
} from 'lucide-react';

interface SuggestionCard {
  id: string;
  ordinal: number;
  text: string;
  isFinal: boolean;
  timestamp: string;
}

export const Prototype2View: React.FC = () => {
  // Navigation & Room Parameters
  const [roomId, setRoomId] = useState<string>('room-101');
  const [role, setRole] = useState<'salesperson' | 'customer'>('salesperson');
  const [isJoined, setIsJoined] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Statuses & Indicators
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [peerConnected, setPeerConnected] = useState<boolean>(false);
  const [ultravoxStatus, setUltravoxStatus] = useState<UltravoxSessionStatus>(UltravoxSessionStatus.DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [customKey, setCustomKey] = useState<string>('');
  const [publicAppUrl, setPublicAppUrl] = useState<string | null>(null);

  // AI Suggestions & Speech
  const [aiSuggestions, setAiSuggestions] = useState<SuggestionCard[]>([]);
  const [latestSpeechText, setLatestSpeechText] = useState<string>('');
  const [salesContextInput, setSalesContextInput] = useState<string>('');
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Logs
  const [logs, setLogs] = useState<string[]>([]);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const ultravoxRef = useRef<UltravoxSession | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    console.log(formatted);
    setLogs((prev) => [...prev.slice(-30), formatted]);
  };

  // Parse URL query parameters on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const roleParam = params.get('role');

    if (roomParam) setRoomId(roomParam);
    if (roleParam === 'customer' || roleParam === 'salesperson') {
      setRole(roleParam);
    }
  }, []);

  // Load the configured public deployment URL (APP_URL) for customer invites
  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.publicAppUrl) setPublicAppUrl(data.publicAppUrl);
      })
      .catch(() => {
        // Invitation links fall back to the current origin when config is unavailable.
      });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      handleLeaveRoom();
    };
  }, []);

  // Helper: Get shareable public customer invitation URL
  const getCustomerInviteUrl = () =>
    buildCustomerInviteUrl({
      configuredPublicUrl: publicAppUrl,
      currentOrigin: window.location.origin,
      currentPathname: window.location.pathname,
      roomId,
    });

  const handleCopyInviteLink = () => {
    navigator.clipboard.writeText(getCustomerInviteUrl());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Initialize WebRTC P2P PeerConnection
  const createPeerConnection = (ws: WebSocket, targetRoomId: string, currentRole: 'salesperson' | 'customer') => {
    addLog('Initializing RTCPeerConnection with STUN servers...');

    const rtcConfig: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    };

    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    // Attach local audio track to P2P connection
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });
      addLog('Added local microphone track to WebRTC P2P connection.');
    }

    // ICE Candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'ice_candidate',
            candidate: event.candidate,
            roomId: targetRoomId,
          })
        );
      }
    };

    // Connection state change
    pc.onconnectionstatechange = () => {
      addLog(`WebRTC P2P Connection State: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        setPeerConnected(true);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setPeerConnected(false);
      }
    };

    // On remote track received
    pc.ontrack = (event) => {
      addLog(`Received remote audio track from peer (${event.track.kind}).`);
      if (remoteAudioRef.current && event.streams[0]) {
        remoteAudioRef.current.srcObject = event.streams[0];
        remoteAudioRef.current
          .play()
          .then(() => addLog('Playing remote audio stream live.'))
          .catch((e) => addLog(`Remote audio play warning: ${e.message}`));
      }
    };

    return pc;
  };

  // Start / Join Prototype 2 Room
  const handleJoinRoom = async () => {
    setErrorMessage(null);
    addLog(`Joining Prototype 2 Room: "${roomId}" as Role: "${role.toUpperCase()}"`);

    // 1. Acquire Microphone Stream
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not available in this browser context.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      addLog('Acquired local microphone stream for WebRTC conversation.');
    } catch (err: any) {
      addLog(`Microphone access error: ${err.message}`);
      setErrorMessage(
        err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
          ? 'Microphone permission denied. Please allow microphone access or launch in Standalone Tab.'
          : err.message || 'Failed to access microphone.'
      );
      return;
    }

    // 2. Connect to Server WebSocket Signaling
    setWsStatus('connecting');
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    addLog(`Connecting to WebSocket signaling: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = async () => {
      setWsStatus('connected');
      setIsJoined(true);
      addLog('WebSocket signaling connected.');

      // Register in room
      ws.send(JSON.stringify({ type: 'join_room', roomId, role }));

      // Create WebRTC Peer Connection
      const pc = createPeerConnection(ws, roomId, role);

      // If Salesperson joins first, prepare offer when peer joins
      if (role === 'salesperson') {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', offer, roomId }));
          addLog('Created and sent WebRTC offer SDP.');
        } catch (e: any) {
          addLog(`Error creating WebRTC offer: ${e.message}`);
        }
      }

      // 3. Connect Ultravox Session if Customer (or if Salesperson needs room setup)
      if (role === 'customer') {
        try {
          addLog('Fetching Ultravox call configuration from backend (enforces 1 call per room)...');
          const res = await fetch('/api/room/ultravox-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, customKey }),
          });

          if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.message || 'Failed to initialize room Ultravox session');
          }

          const callData = await res.json();
          addLog(`Ultravox Call ${callData.isReused ? 'Reused' : 'Created'}. Call ID: ${callData.callId}`);

          // Connect UltravoxSession on Customer client
          const ultravox = new UltravoxSession();
          ultravoxRef.current = ultravox;

          ultravox.addEventListener('status', () => {
            const status = ultravox.status;
            setUltravoxStatus(status);
            addLog(`Customer Ultravox Status: ${status}`);

            if (status === UltravoxSessionStatus.LISTENING || status === UltravoxSessionStatus.IDLE) {
              try {
                ultravox.setOutputMedium(Medium.TEXT);
                ultravox.muteSpeaker();
              } catch (e) {
                // Ignore
              }
            }
          });

          // Transcripts event: Relay AI suggestions to Salesperson over WebSocket
          ultravox.addEventListener('transcripts', () => {
            const rawTranscripts = ultravox.transcripts;
            const now = new Date().toLocaleTimeString();

            rawTranscripts.forEach((t) => {
              if (t.speaker === Role.AGENT && t.text.trim()) {
                // Relay generated AI suggestion to Salesperson
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'ai_suggestion',
                      roomId,
                      text: t.text,
                      isFinal: t.isFinal,
                      ordinal: t.ordinal,
                      timestamp: now,
                    })
                  );
                }
              } else if (t.speaker === Role.USER) {
                setLatestSpeechText(t.text);
              }
            });
          });

          ultravox.joinCall(callData.joinUrl);
        } catch (e: any) {
          addLog(`Customer Ultravox setup error: ${e.message}`);
          setErrorMessage(e.message);
        }
      }
    };

    // Handle Signaling Messages
    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        const { type } = data;

        if (type === 'peer_joined') {
          addLog(`Peer joined room. Role: ${data.role}`);
          if (pcRef.current && role === 'salesperson') {
            const offer = await pcRef.current.createOffer();
            await pcRef.current.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', offer, roomId }));
          }
        } else if (type === 'offer') {
          if (pcRef.current) {
            addLog('Received WebRTC offer. Creating answer...');
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pcRef.current.createAnswer();
            await pcRef.current.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', answer, roomId }));
          }
        } else if (type === 'answer') {
          if (pcRef.current) {
            addLog('Received WebRTC answer.');
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
          }
        } else if (type === 'ice_candidate') {
          if (pcRef.current && data.candidate) {
            try {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
              // Ignore stale candidate errors
            }
          }
        } else if (type === 'ai_suggestion') {
          // Received AI sales suggestion on Salesperson Dashboard
          const newCard: SuggestionCard = {
            id: `sug-${data.ordinal}-${data.isFinal ? 'final' : 'interim'}`,
            ordinal: data.ordinal,
            text: data.text,
            isFinal: data.isFinal,
            timestamp: data.timestamp || new Date().toLocaleTimeString(),
          };

          setAiSuggestions((prev) => {
            const idx = prev.findIndex((s) => s.ordinal === data.ordinal);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = newCard;
              return updated;
            } else {
              return [...prev, newCard];
            }
          });
        }
      } catch (err: any) {
        addLog(`Signaling message parse error: ${err.message}`);
      }
    };

    ws.onerror = (err) => {
      addLog('WebSocket error encountered.');
      setWsStatus('disconnected');
    };

    ws.onclose = () => {
      addLog('WebSocket connection closed.');
      setWsStatus('disconnected');
      setPeerConnected(false);
    };
  };

  // Leave Room & Cleanup
  const handleLeaveRoom = () => {
    addLog('Leaving room and tearing down WebRTC media streams...');

    if (ultravoxRef.current) {
      ultravoxRef.current.leaveCall().catch(() => {});
      ultravoxRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    setIsJoined(false);
    setWsStatus('disconnected');
    setPeerConnected(false);
    setUltravoxStatus(UltravoxSessionStatus.DISCONNECTED);
  };

  // Mute / Unmute Local Mic
  const handleToggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  // Send Custom Context Update to Ultravox Session
  const handleSendCustomContext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!salesContextInput.trim() || !ultravoxRef.current) return;
    try {
      ultravoxRef.current.sendText(`[Salesperson Spoke]: ${salesContextInput.trim()}`);
      addLog(`Sent custom salesperson text context to Ultravox.`);
      setSalesContextInput('');
    } catch (err: any) {
      addLog(`Failed to send context update: ${err.message}`);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-slate-950 text-slate-100 font-sans">
      {/* Hidden audio element for remote peer audio playback */}
      <audio ref={remoteAudioRef} autoPlay className="hidden" />

      {/* Error Alert */}
      {errorMessage && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-2.5 text-xs text-red-300 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-400 hover:text-red-200 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {!isJoined ? (
        /* Room Join & Link Generation Setup Screen */
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 overflow-y-auto">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="text-center space-y-1">
              <div className="inline-flex p-3 bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 rounded-2xl mb-2">
                <Users className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-bold text-slate-100">Prototype 2: Live Sales Copilot</h2>
              <p className="text-xs text-slate-400">
                P2P WebRTC Audio Call + Real-Time Streaming Ultravox AI Suggestions
              </p>
            </div>

            {/* Room ID & Role Form */}
            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Interview Room ID
                </label>
                <input
                  type="text"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.trim().toLowerCase() || 'room-101')}
                  className="w-full px-3.5 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
                  placeholder="e.g. room-101"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Select Your Role</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRole('salesperson')}
                    className={`p-3 rounded-xl border text-center transition-all ${
                      role === 'salesperson'
                        ? 'bg-indigo-600 border-indigo-500 text-white font-bold shadow'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="text-xs">Salesperson</div>
                    <div className="text-[10px] opacity-75 font-normal">Dashboard & AI Suggestions</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setRole('customer')}
                    className={`p-3 rounded-xl border text-center transition-all ${
                      role === 'customer'
                        ? 'bg-emerald-600 border-emerald-500 text-white font-bold shadow'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="text-xs">Customer</div>
                    <div className="text-[10px] opacity-75 font-normal">Invitation Join View</div>
                  </button>
                </div>
              </div>

              {/* Shareable Customer Invitation Link Generator */}
              <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1">
                    <Share2 className="w-3.5 h-3.5 text-cyan-400" /> Customer Invite Link
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyInviteLink}
                    className="flex items-center gap-1 text-[10px] font-semibold text-cyan-400 hover:text-cyan-300"
                  >
                    {copiedLink ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copiedLink ? 'Copied' : 'Copy Link'}
                  </button>
                </div>
                <div className="font-mono text-[10px] text-slate-400 bg-slate-900 p-2 rounded-lg truncate border border-slate-800/80">
                  {getCustomerInviteUrl()}
                </div>
                {isAistudioDevPreview(getCustomerInviteUrl()) && (
                  <p className="text-[10px] leading-relaxed text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
                    This is an AI Studio development preview URL and requires a Google sign-in, so
                    customers cannot open it. Publish the app and set <span className="font-mono">APP_URL</span> to
                    the public deployment URL to generate a working invitation link.
                  </p>
                )}
              </div>

              {/* Join Action Button */}
              <button
                type="button"
                onClick={handleJoinRoom}
                className={`w-full py-3 text-sm font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 ${
                  role === 'salesperson'
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/20'
                }`}
              >
                <PhoneCall className="w-4 h-4" />
                {role === 'salesperson' ? 'Open Salesperson Dashboard' : 'Join Sales Call as Customer'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Active Interview View (Salesperson Dashboard or Customer Interface) */
        <div className="flex-1 flex flex-col min-h-0">
          {/* Active Call Header */}
          <header className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
                {role.toUpperCase()}
              </span>
              <span className="text-xs font-mono text-slate-400">
                Room: <strong className="text-slate-200">{roomId}</strong>
              </span>
            </div>

            {/* Live Connection Badges */}
            <div className="flex items-center gap-2 text-xs">
              {/* WebRTC P2P Audio Status */}
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold border ${
                  peerConnected
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/30 animate-pulse'
                }`}
              >
                <Radio className="w-3 h-3" />
                {peerConnected ? 'P2P Audio Connected' : 'Waiting for Peer...'}
              </span>

              {/* Leave Call Button */}
              <button
                onClick={handleLeaveRoom}
                className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1 shadow transition-colors"
              >
                <PhoneOff className="w-3.5 h-3.5" />
                Leave
              </button>
            </div>
          </header>

          {/* Main Content View Split */}
          {role === 'salesperson' ? (
            /* SALESPERSON DASHBOARD: Teleprompter AI Suggestions Display */
            <div className="flex-1 overflow-hidden p-4 sm:p-6 flex flex-col max-w-5xl w-full mx-auto">
              <div className="flex-1 bg-slate-900/80 border border-slate-800 rounded-2xl p-4 sm:p-6 flex flex-col min-h-0 shadow-2xl space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
                      Real-Time AI Sales Suggestions (Ready to Read Aloud)
                    </h3>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 bg-slate-950 px-2.5 py-1 rounded-md border border-slate-800">
                    Model: ultravox-v0.7
                  </span>
                </div>

                {/* AI Teleprompter Suggestion Cards */}
                <div className="flex-1 overflow-y-auto space-y-3.5 pr-1 custom-scrollbar">
                  {aiSuggestions.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
                      <Sparkles className="w-10 h-10 mb-3 opacity-30 text-cyan-400" />
                      <p className="text-sm font-medium text-slate-300">
                        {peerConnected
                          ? 'Listening to customer speech... AI suggestions will stream here live.'
                          : 'Waiting for customer to join call...'}
                      </p>
                      <p className="text-xs text-slate-500 mt-1 max-w-md">
                        When the customer speaks into their microphone, Ultravox generates instant ready-to-read response suggestions on your screen.
                      </p>
                    </div>
                  ) : (
                    aiSuggestions.map((card, idx) => {
                      const isLatest = idx === aiSuggestions.length - 1;
                      return (
                        <div
                          key={card.id}
                          className={`p-4 rounded-2xl border transition-all ${
                            isLatest
                              ? 'bg-gradient-to-r from-cyan-950/40 to-indigo-950/40 border-cyan-500/50 shadow-lg shadow-cyan-500/10'
                              : 'bg-slate-950/60 border-slate-800/80 opacity-70'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2 text-[10px] font-mono">
                            <span
                              className={`px-2 py-0.5 rounded font-bold uppercase ${
                                isLatest
                                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {isLatest ? 'Recommended Response' : 'Prior Suggestion'}
                            </span>
                            <span className="text-slate-500">{card.timestamp}</span>
                          </div>

                          <p className="text-sm sm:text-base text-slate-100 font-sans leading-relaxed font-medium">
                            "{card.text}"
                          </p>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* CUSTOMER VIEW: Clean Live Audio Session Interface */
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col items-center justify-center">
              <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl text-center space-y-5">
                <div className="inline-flex p-4 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-3xl animate-pulse">
                  <Mic className="w-8 h-8" />
                </div>

                <div>
                  <h3 className="text-base font-bold text-slate-100">Live Conversation Active</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    You are connected live with the salesperson. Speak naturally into your microphone.
                  </p>
                </div>

                {latestSpeechText && (
                  <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-left">
                    <span className="text-[10px] font-mono font-bold uppercase text-slate-400 block mb-1">
                      Your Recognized Speech:
                    </span>
                    <p className="text-xs text-slate-200 font-sans italic">"{latestSpeechText}"</p>
                  </div>
                )}

                <div className="pt-2 flex items-center justify-center gap-3">
                  <button
                    onClick={handleToggleMute}
                    className={`px-4 py-2 rounded-xl border text-xs font-semibold flex items-center gap-2 ${
                      isMuted
                        ? 'bg-red-500/20 text-red-300 border-red-500/40'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                    }`}
                  >
                    {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
                    {isMuted ? 'Microphone Muted' : 'Mute Microphone'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bottom Action Footer */}
          <footer className="bg-slate-900 border-t border-slate-800 p-3 sm:p-4 shrink-0">
            <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span>Prototype 2 Engine Active</span>
              </div>
              <button
                onClick={() => window.open(getCustomerInviteUrl(), '_blank', 'noopener,noreferrer')}
                className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-semibold"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Standalone Tab
              </button>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
};
