import React, { useState, useEffect } from 'react';
import { Prototype1View } from './components/Prototype1View';
import { Prototype2View } from './components/Prototype2View';
import { Bot, Users, ExternalLink, Radio } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'prototype2' | 'prototype1'>('prototype2');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const protoParam = params.get('prototype');
    if (protoParam === '1') {
      setActiveTab('prototype1');
    } else if (protoParam === '2') {
      setActiveTab('prototype2');
    }
  }, []);

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col font-sans overflow-hidden antialiased selection:bg-emerald-500 selection:text-black">
      {/* Universal Prototype Navigation Bar */}
      <header className="bg-slate-900/90 border-b border-slate-800 px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shrink-0 z-30">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-tr from-indigo-600 to-cyan-500 rounded-xl text-white shadow-md">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-100 tracking-tight">Sales Copilot</h1>
            <p className="text-[10px] text-slate-400">
              Ultravox Hosted API • Model: <span className="font-mono text-cyan-300">ultravox-v0.7</span>
            </p>
          </div>
        </div>

        {/* Prototype Version Selector Tabs */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800/80 text-xs">
          <button
            onClick={() => setActiveTab('prototype2')}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-semibold transition-all ${
              activeTab === 'prototype2'
                ? 'bg-indigo-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            Prototype 2 (Live Sales Call)
          </button>

          <button
            onClick={() => setActiveTab('prototype1')}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-semibold transition-all ${
              activeTab === 'prototype1'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            Prototype 1 (Engine Test)
          </button>

          <button
            onClick={() => window.open(window.location.href, '_blank', 'noopener,noreferrer')}
            className="px-2.5 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1 shadow transition-colors ml-1"
            title="Launch in standalone browser tab to grant direct microphone permissions"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Standalone</span>
          </button>
        </div>
      </header>

      {/* Main Active Prototype View */}
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {activeTab === 'prototype2' ? <Prototype2View /> : <Prototype1View />}
      </main>
    </div>
  );
}
