import React from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Plus, Trash2, ArrowLeft, Sparkles } from 'lucide-react';

function ButtonCard({ title, children }) {
  return (
    <section className="hud-panel rounded-xl p-4 sm:p-5">
      <h2 className="text-cyan-100 text-sm tracking-widest uppercase mb-4">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export default function ButtonShowcasePage() {
  return (
    <div className="quantum-bg min-h-screen relative p-4 sm:p-6">
      <div className="relative z-10 max-w-6xl mx-auto space-y-4">
        <header className="hud-panel rounded-xl p-4 sm:p-5 flex items-center justify-between gap-3">
          <div>
            <p className="text-gold/70 text-xs tracking-widest uppercase">UI Playground</p>
            <h1 className="text-cyan-100 text-lg sm:text-xl tracking-widest">Button Showcase</h1>
          </div>
          <Link
            to="/"
            className="border border-cyan-300/35 text-cyan-100 px-3 py-2 rounded flex items-center gap-2 hover:bg-cyan-400/10"
          >
            <ArrowLeft className="w-4 h-4" />
            Dashboard
          </Link>
        </header>

        <ButtonCard title="Core Variants">
          <button className="btn-gold px-4 py-2 rounded text-xs tracking-widest flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Primary
          </button>
          <button className="border border-gold/60 bg-gold/10 text-gold px-4 py-2 rounded text-xs tracking-widest hover:bg-gold/20">
            Secondary
          </button>
          <button className="border border-cyan-300/40 text-cyan-100 px-4 py-2 rounded text-xs tracking-widest hover:bg-cyan-400/10">
            Outline
          </button>
          <button className="text-cyan-100 px-4 py-2 rounded text-xs tracking-widest hover:bg-white/10">
            Ghost
          </button>
        </ButtonCard>

        <ButtonCard title="Semantic Variants">
          <button className="btn-emergency px-4 py-2 rounded text-xs tracking-widest">
            Danger
          </button>
          <button className="bg-emerald-500/15 border border-emerald-400/50 text-emerald-200 px-4 py-2 rounded text-xs tracking-widest hover:bg-emerald-500/25">
            Success
          </button>
          <button className="bg-amber-500/15 border border-amber-400/50 text-amber-200 px-4 py-2 rounded text-xs tracking-widest hover:bg-amber-500/25">
            Warning
          </button>
        </ButtonCard>

        <ButtonCard title="States">
          <button className="btn-gold px-4 py-2 rounded text-xs tracking-widest opacity-60 cursor-not-allowed" disabled>
            Disabled
          </button>
          <button className="btn-gold px-4 py-2 rounded text-xs tracking-widest inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading
          </button>
          <button className="border border-gold/50 text-gold px-3 py-2 rounded hover:bg-gold/10" aria-label="Add">
            <Plus className="w-4 h-4" />
          </button>
          <button className="border border-red-400/60 text-red-300 px-3 py-2 rounded hover:bg-red-500/10" aria-label="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        </ButtonCard>
      </div>
    </div>
  );
}
