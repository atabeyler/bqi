import React, { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import CyberAnalysisContent from '../components/CyberAnalysisContent.jsx';
import EmergencyButton from '../components/EmergencyButton.jsx';
import SplashScreen from '../components/SplashScreen.jsx';

// Standalone route for Cyber Analysis (see App.jsx). Both dashboard entry
// points route here. Opening the BCI page itself never
// opens the new-analysis wizard; only its command-center action may do that.
export default function CyberAnalysisPage({ user }) {
  const [splashDone, setSplashDone] = useState(false);
  const finishSplash = useCallback(() => setSplashDone(true), []);

  if (!splashDone) {
    return (
      <SplashScreen
        logoSrc="/bci-logo.png"
        acronym="BCI"
        fullName="BOLD CYBER INTELLIGENCE"
        displayMs={3000}
        onComplete={finishSplash}
      />
    );
  }

  return (
    <div className="quantum-bg min-h-screen relative p-4 sm:p-6">
      <div className="relative z-10 max-w-5xl mx-auto space-y-4">
        <div className="flex justify-end">
          <Link
            to="/"
            className="border border-cyan-300/35 text-cyan-100 px-3 py-2 rounded flex items-center gap-2 hover:bg-cyan-400/10"
          >
            <ArrowLeft className="w-4 h-4" />
            Dashboard
          </Link>
        </div>
        <CyberAnalysisContent isAdmin={!!user?.isAdmin} />
      </div>
      <EmergencyButton authenticated={true} user={user} />
    </div>
  );
}
