import React, { useState, useEffect, useRef } from 'react';
import { UltravoxSession, UltravoxSessionStatus, Role, Medium } from 'ultravox-client';
import {
  Mic,
  Square,
  Copy,
  Trash2,
  Check,
  AlertCircle,
  Radio,
  Key,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';

export const Prototype1View: React.FC = () => {
  const [sessionStatus, setSessionStatus] = useState<UltravoxSessionStatus>(
    UltravoxSessionStatus.DISCONNECTED
  );
  const [transcripts, setTranscripts] = useState<Array<{
    ordinal: number;
    speaker: Role;
    text: string;
    isFinal: boolean;
  }>>([]);
  const [copied, setCopied] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [customKey, setCustomKey] = useState<string>('');
  const [hasServerKey, setHasServerKey] = useState<boolean>(true);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showDebugLogs, setShowDebugLogs] = useState<boolean>(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const sessionRef = useRef<UltravoxSession | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    console.log(formatted);
    setDebugLogs((prev) => [...prev.slice(-40), formatted]);
  };

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        setHasServerKey(Boolean(data.hasUltravoxKey));
        addLog(`Backend health check OK. Model: ${data.model}`);
      })
      .catch((err) => {
        addLog(`Backend health check warning: ${err.message}`);
      });
  }, []);

  useEffect(() => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
    }
  }, [transcripts]);

  const handleStartListening = async () => {
    setErrorMessage(null);
    addLog('Initiating Prototype 1 listening workflow...');

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not supported in this browser context.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      addLog('Microphone permission acquired successfully.');
    } catch (err: any) {
      addLog(`Microphone permission error: ${err.name} - ${err.message}`);
      const msg =
        err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
          ? 'Microphone access denied. Please click the lock icon in your URL bar to allow microphone access, or use the Standalone Tab button.'
          : err.message || 'Microphone hardware unavailable.';
      setErrorMessage(msg);
      return;
    }

    setSessionStatus(UltravoxSessionStatus.CONNECTING);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (customKey) {
        headers['x-ultravox-api-key'] = customKey;
      }

      addLog('Fetching call connection details from server proxy...');
      const response = await fetch('/api/ultravox/call', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          systemPrompt:
            'You are a sales copilot assistant. Provide brief, concise text responses when prompted.',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 401) {
          setShowSettings(true);
        }
        throw new Error(errorData.message || `Server returned HTTP ${response.status}`);
      }

      const callData = await response.json();
      const { joinUrl, callId } = callData;
      addLog(`Call created successfully. Call ID: ${callId}`);

      if (sessionRef.current) {
        try {
          await sessionRef.current.leaveCall();
        } catch (e) {
          // Ignore
        }
      }

      const session = new UltravoxSession();
      sessionRef.current = session;

      session.addEventListener('status', () => {
        const currentStatus = session.status;
        addLog(`Ultravox session status changed to: ${currentStatus}`);
        setSessionStatus(currentStatus);

        if (
          currentStatus === UltravoxSessionStatus.LISTENING ||
          currentStatus === UltravoxSessionStatus.IDLE
        ) {
          try {
            session.setOutputMedium(Medium.TEXT);
            session.muteSpeaker();
            addLog('Configured Ultravox client for text-only output.');
          } catch (e: any) {
            addLog(`Note setting outputMedium: ${e.message}`);
          }
        }
      });

      session.addEventListener('transcripts', () => {
        const rawTranscripts = session.transcripts;
        const items = rawTranscripts.map((t) => ({
          ordinal: t.ordinal,
          speaker: t.speaker,
          text: t.text,
          isFinal: t.isFinal,
        }));
        setTranscripts(items);
      });

      session.addEventListener('error', (event: any) => {
        const err = event?.error;
        const errMsg = err?.message || 'Ultravox session error encountered.';
        addLog(`Ultravox Error Event: ${errMsg}`);
        setErrorMessage(errMsg);
      });

      addLog('Joining call WebRTC session...');
      session.joinCall(joinUrl);
    } catch (err: any) {
      addLog(`Failed to start session: ${err.message}`);
      setSessionStatus(UltravoxSessionStatus.DISCONNECTED);
      setErrorMessage(err.message || 'Failed to start listening session.');
    }
  };

  const handleStopListening = async () => {
    addLog('User clicked Stop Listening.');
    if (sessionRef.current) {
      setSessionStatus(UltravoxSessionStatus.DISCONNECTING);
      try {
        await sessionRef.current.leaveCall();
        addLog('Session call left gracefully.');
      } catch (e: any) {
        addLog(`Error during leaveCall: ${e.message}`);
      } finally {
        sessionRef.current = null;
        setSessionStatus(UltravoxSessionStatus.DISCONNECTED);
      }
    } else {
      setSessionStatus(UltravoxSessionStatus.DISCONNECTED);
    }
  };

  const handleClearTranscript = () => {
    setTranscripts([]);
    addLog('Transcript cleared.');
  };

  const handleCopyTranscript = () => {
    const textToCopy = transcripts
      .map((t) =>
        t.speaker === Role.USER
          ? t.text
          : `[Copilot]: ${t.text}`
      )
      .filter(Boolean)
      .join('\n\n');

    if (!textToCopy) return;

    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isConnected =
    sessionStatus !== UltravoxSessionStatus.DISCONNECTED &&
    sessionStatus !== UltravoxSessionStatus.DISCONNECTING;

  const renderStatusBadge = () => {
    if (errorMessage) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/30">
          <AlertCircle className="w-3.5 h-3.5" />
          Connection Error
        </span>
      );
    }

    switch (sessionStatus) {
      case UltravoxSessionStatus.CONNECTING:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 animate-pulse">
            <Radio className="w-3.5 h-3.5" />
            Connecting...
          </span>
        );
      case UltravoxSessionStatus.LISTENING:
      case UltravoxSessionStatus.IDLE:
      case UltravoxSessionStatus.THINKING:
      case UltravoxSessionStatus.SPEAKING:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            Listening
          </span>
        );
      case UltravoxSessionStatus.DISCONNECTING:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            Disconnecting...
          </span>
        );
      case UltravoxSessionStatus.DISCONNECTED:
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
            Disconnected
          </span>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-slate-950 text-slate-100">
      {/* Settings Drawer */}
      {showSettings && (
        <div className="bg-slate-900 border-b border-slate-800 p-3.5 text-xs text-slate-300 shrink-0">
          <div className="max-w-xl mx-auto space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200">Ultravox API Key Configuration</span>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                ✕
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              If ULTRAVOX_API_KEY is not set in server environment, enter your key below:
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="Enter Ultravox API key (e.g. uv_...)"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
              />
              <button
                onClick={() => setShowSettings(false)}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 font-semibold text-white rounded-lg text-xs shadow"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {errorMessage && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-2.5 text-xs text-red-300 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={handleStartListening}
            className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg text-[11px] shrink-0"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Main Transcript Display Area */}
      <main className="flex-1 overflow-hidden p-4 sm:p-6 flex flex-col max-w-4xl w-full mx-auto">
        <div className="flex-1 bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 sm:p-6 flex flex-col min-h-0 shadow-xl relative">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800/80 mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Prototype 1: Single-Speaker Text Stream
              </span>
            </div>
            <div className="flex items-center gap-2">
              {renderStatusBadge()}
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="p-1 text-slate-400 hover:text-slate-200"
                title="Settings"
              >
                <Key className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div
            ref={transcriptContainerRef}
            className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar text-slate-100"
          >
            {transcripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
                <Mic className="w-10 h-10 mb-3 opacity-30 text-emerald-400" />
                <p className="text-sm font-medium text-slate-400">Ready to record transcript</p>
                <p className="text-xs text-slate-500 mt-1 max-w-sm">
                  Click <strong className="text-emerald-400">Start Listening</strong> below and speak into your microphone.
                </p>
              </div>
            ) : (
              <div className="space-y-3 font-sans text-sm sm:text-base leading-relaxed">
                {transcripts.map((item) => {
                  const isUser = item.speaker === Role.USER;
                  return (
                    <div
                      key={`t1-${item.ordinal}-${item.speaker}`}
                      className={`p-3 rounded-xl transition-all ${
                        isUser
                          ? 'bg-slate-950/80 border border-slate-800 text-slate-100'
                          : 'bg-emerald-950/20 border border-emerald-500/20 text-emerald-200'
                      }`}
                    >
                      {!isUser && (
                        <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400 mb-1">
                          Copilot Text Response:
                        </div>
                      )}
                      <div className="inline">
                        <span>{item.text}</span>
                        {!item.isFinal && (
                          <span className="inline-block ml-1.5 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Control Action Bar */}
      <footer className="bg-slate-900 border-t border-slate-800 p-3 sm:p-4 shrink-0">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 w-full sm:w-auto">
            {!isConnected ? (
              <button
                onClick={handleStartListening}
                disabled={(sessionStatus as UltravoxSessionStatus) === UltravoxSessionStatus.CONNECTING}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded-xl shadow-lg shadow-emerald-600/20 text-sm transition-all"
              >
                <Mic className="w-4 h-4" />
                {(sessionStatus as UltravoxSessionStatus) === UltravoxSessionStatus.CONNECTING
                  ? 'Connecting...'
                  : 'Start Listening'}
              </button>
            ) : (
              <button
                onClick={handleStopListening}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-6 py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl shadow-lg shadow-red-600/20 text-sm transition-all animate-pulse"
              >
                <Square className="w-4 h-4 fill-current" />
                Stop Listening
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end text-xs">
            <button
              onClick={handleCopyTranscript}
              disabled={transcripts.length === 0}
              className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-xl border border-slate-700 font-medium transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy Transcript'}
            </button>

            <button
              onClick={handleClearTranscript}
              disabled={transcripts.length === 0}
              className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-xl border border-slate-700 font-medium transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear
            </button>
          </div>
        </div>

        <div className="max-w-4xl mx-auto mt-2 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[10px] text-slate-500">
          <span>Prototype 1 Baseline Engine</span>
          <button
            onClick={() => setShowDebugLogs(!showDebugLogs)}
            className="flex items-center gap-1 text-slate-400 hover:text-slate-200 font-mono"
          >
            {showDebugLogs ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
            {showDebugLogs ? 'Hide Logs' : 'View Logs'}
          </button>
        </div>

        {showDebugLogs && (
          <div className="max-w-4xl mx-auto mt-2 p-2.5 bg-slate-950 rounded-lg border border-slate-800 font-mono text-[10px] text-slate-400 max-h-28 overflow-y-auto custom-scrollbar">
            {debugLogs.map((log, idx) => (
              <div key={idx}>{log}</div>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
};
