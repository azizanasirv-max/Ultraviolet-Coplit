import React, { useEffect, useState } from 'react';
import { SalespersonDashboard } from './components/prototype2/SalespersonDashboard';
import { CustomerDashboard } from './components/prototype2/CustomerDashboard';
import { AdminSettings } from './components/AdminSettings';
import { RouteInfo, readRoute } from './lib/routes';
import { Bot, Settings } from 'lucide-react';

/**
 * Role-specific routes:
 *   /join?invite=...  customer only (no salesperson UI)
 *   /sales            salesperson only
 *   /                 salesperson app shell with Admin Settings
 *
 * The route only selects a UI shell. Authorization is always enforced by the
 * server against the participant credential.
 */
export default function App() {
  const [route, setRoute] = useState<RouteInfo>(() => readRoute());
  const [showAdmin, setShowAdmin] = useState(false);

  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  if (route.kind === 'customer') {
    return (
      <div className="min-h-screen w-full bg-slate-950 text-slate-100 font-sans antialiased selection:bg-emerald-500 selection:text-black">
        <CustomerDashboard inviteToken={route.inviteToken} legacyInvitation={route.legacyInvitation} />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col font-sans overflow-hidden antialiased selection:bg-emerald-500 selection:text-black">
      <header className="bg-slate-900/90 border-b border-slate-800 px-4 py-2.5 flex items-center justify-between gap-2.5 shrink-0 z-30">
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

        {/* Admin setup + ExpressTURN relay credentials (uses the existing /api/admin backend). */}
        <button
          onClick={() => setShowAdmin(true)}
          data-testid="admin-settings-open"
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold rounded-xl text-xs flex items-center gap-1.5 border border-slate-700 transition-colors"
          title="Complete admin setup and save ExpressTURN credentials"
        >
          <Settings className="w-3.5 h-3.5" />
          Admin Settings
        </button>
      </header>

      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <SalespersonDashboard />
      </main>

      <AdminSettings open={showAdmin} onClose={() => setShowAdmin(false)} />
    </div>
  );
}
