import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { LangProvider, useLang } from './i18n/LangContext.jsx';
import Layout from './components/Layout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import AssetsPage from './pages/AssetsPage.jsx';
import ScansPage from './pages/ScansPage.jsx';
import FindingsPage from './pages/FindingsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import EnginesPage from './pages/EnginesPage.jsx';
import QuantumPage from './pages/QuantumPage.jsx';
import DecisionPage from './pages/DecisionPage.jsx';
import ControlledProofPage from './pages/ControlledProofPage.jsx';

function RequireAuth({ children }) {
  const { user } = useAuth();
  const { t } = useLang();
  if (user === undefined) return <div className="login-screen">{t('loadingEllipsis')}</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="assets" element={<AssetsPage />} />
        <Route path="scans" element={<ScansPage />} />
        <Route path="findings" element={<FindingsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="engines" element={<EnginesPage />} />
        <Route path="quantum" element={<QuantumPage />} />
        <Route path="decision" element={<DecisionPage />} />
        <Route path="controlled-proof" element={<ControlledProofPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <LangProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </LangProvider>
  );
}
