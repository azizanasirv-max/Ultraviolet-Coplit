import React, { useEffect, useState } from 'react';
import { Prototype1View } from './components/Prototype1View';
import { SalespersonDashboard } from './components/prototype2/SalespersonDashboard';
import { CustomerDashboard } from './components/prototype2/CustomerDashboard';
import { RouteInfo, readRoute } from './lib/routes';
import { Bot, Users, ExternalLink, Radio } from 'lucide-react';

/**
 * Role-specific routes:
 *   /join?invite=...  customer only (no prototype tabs, no salesperson UI)
 *   /sales            salesperson only
 *   /                 prototype selector (Prototype 2 tab = salesperson)
 *
 * The route only selects a UI shell. Authorization is always enforced by the
 * server against the participant credential.
 */
export default function App() {
  const [route, setRoute] = useState<RouteInfo>(() => readRoute());
  const [activeTab, setActiveTab] = useState<'prototype2' | 'prototype1'>('prototype2');

  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener('popstate', sync);
    const params = new URLSearchParams(window.location.search);
    if (params.get('prototype') === '1') setActiveTab('prototype1');
    return () => window.removeEventListener('popstate', sync);
  }, []);

  if (route.kind === 'customer') {
    return (
      <div className="min-h-screen w-full bg-slate-950 text-slate-100 font-sans antialiased selection:bg-emerald-500 selection:text-black">
        <CustomerDashboard inviteToken={route.inviteToken} legacyInvitation={route.legacyInvitation} />
      </div>
    );
  }

  if (route.kind === 'salesperson') {
    return (
      <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col font-sans overflow-hidden antialiased selection:bg-emerald-500 selection:text-black">
        <SalespersonDashboard />
      </div>
    );
  }

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
            title="Launch in a standalone browser tab so microphone permissions are granted directly"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Standalone</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {activeTab === 'prototype2' ? <SalespersonDashboard /> : <Prototype1View />}
      </main>
    </div>
  );
}
