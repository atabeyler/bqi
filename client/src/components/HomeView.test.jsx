import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import HomeView from './HomeView.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { api } from '../services/api.js';
import { executeAction, getActionsForAI } from '../services/voiceActionRegistry.js';
import { setAppMode } from '../services/appModePreference.js';

vi.mock('./TurkeyMap.jsx', () => ({ default: () => <div>TurkeyMap stub</div> }));
vi.mock('../services/api.js', () => ({
  api: {
    activityFeed: vi.fn(async () => []),
    morningBriefToday: vi.fn(async () => ({ exists: false })),
    morningBriefRefresh: vi.fn(async () => ({ success: true })),
    morningBriefList: vi.fn(async () => []),
    morningBriefByDate: vi.fn(async () => ({ exists: false })),
  },
}));

function renderHome(props = {}) { return render(<LangProvider><HomeView {...props} /></LangProvider>); }

beforeEach(() => {
  vi.clearAllMocks();
  api.activityFeed.mockResolvedValue([]);
  api.morningBriefToday.mockResolvedValue({ exists: false });
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ready: true, database: { configured: true, ok: true }, ai: { configured: true }, quantum: { ibmConfigured: true }, storage: { persistentObjectStorageConfigured: true }, redis: { configured: true } }) })));
});

describe('HomeView command center', () => {
  it('renders the live map area and real system status panel', async () => {
    renderHome();
    expect(await screen.findByText('TurkeyMap stub')).toBeInTheDocument();
    expect(screen.getByText(/^Platform \/ Sistem Durumu$/i)).toBeInTheDocument();
    expect(screen.getByText(/AI Sağlayıcıları/i)).toBeInTheDocument();
    expect(screen.queryByText(/^CPU$/i)).not.toBeInTheDocument();
  });

  it('shows the personnel radar button only when isAdmin is true', () => {
    const onOpenRadar = vi.fn();
    renderHome({ isAdmin: true, onOpenRadar });
    fireEvent.click(screen.getByRole('button', { name: /Personel Radarı/i }));
    expect(onOpenRadar).toHaveBeenCalled();
  });

  it('hides the personnel radar button for non-admins', () => {
    renderHome({ isAdmin: false });
    expect(screen.queryByRole('button', { name: /Personel Radarı/i })).not.toBeInTheDocument();
  });

  it('shows an empty-activity message when the feed has no items', async () => {
    renderHome();
    expect(await screen.findByText(/Henüz kayıt yok/i)).toBeInTheDocument();
  });

  it('renders activity feed items once loaded', async () => {
    api.activityFeed.mockResolvedValue([{ id: 1, type: 'analysis', title: 'Ekonomi Raporu', created_at: new Date().toISOString(), category: 'ekonomi' }]);
    renderHome();
    expect((await screen.findAllByText(/Ekonomi Raporu/i)).length).toBeGreaterThan(0);
  });

  it('shows the refresh button in the briefing card only for admins', async () => {
    renderHome({ isAdmin: true });
    expect(await screen.findByRole('button', { name: /Yenile/i })).toBeInTheDocument();
  });

  it('hides the briefing refresh button for non-admins', async () => {
    renderHome({ isAdmin: false });
    await screen.findByText('TurkeyMap stub');
    expect(screen.queryByRole('button', { name: /Yenile/i })).not.toBeInTheDocument();
  });

  it('refreshes the morning brief and shows the briefing button once it exists', async () => {
    api.morningBriefToday.mockResolvedValueOnce({ exists: false }).mockResolvedValue({ exists: true, date: '2026-01-05', items: [{ title: 'Haber 1' }] });
    renderHome({ isAdmin: true });
    fireEvent.click(await screen.findByRole('button', { name: /Yenile/i }));
    await waitFor(() => expect(api.morningBriefRefresh).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /^Brifing$/i })).toBeInTheDocument();
  });

  it('shows a failure message when the brief refresh does not produce a brief', async () => {
    api.morningBriefToday.mockResolvedValue({ exists: false });
    renderHome({ isAdmin: true });
    fireEvent.click(await screen.findByRole('button', { name: /Yenile/i }));
    expect(await screen.findByText(/Briefing üretilemedi/i)).toBeInTheDocument();
  });

  it('opens the full briefing modal and lists items', async () => {
    api.morningBriefToday.mockResolvedValue({ exists: true, date: '2026-01-05', items: [{ title: 'Haber Başlığı', description: 'Detay metni' }] });
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: /^Brifing$/i }));
    const item = screen.getByRole('button', { name: /1\. Haber Başlığı/i });
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(screen.getByText('Detay metni')).toBeInTheDocument();
  });

  const HOME_TRANSLATIONS = {
    en: { platformStatus: 'Platform / System Status', aiProviders: 'AI Providers', personnelRadar: 'Personnel Radar', noRecords: 'No records yet', globalOps: 'Global Operations View', askBQI: 'Ask BQI' },
    de: { platformStatus: 'Plattform / Systemstatus', aiProviders: 'KI-Anbieter', personnelRadar: 'Personalradar', noRecords: 'Noch keine Einträge', globalOps: 'Globale Operationsübersicht', askBQI: 'BQI fragen' },
    fr: { platformStatus: 'Plateforme / État du système', aiProviders: 'Fournisseurs IA', personnelRadar: 'Radar du Personnel', noRecords: "Aucun enregistrement pour l'instant", globalOps: 'Vue des opérations mondiales', askBQI: 'Demander à BQI' },
    ar: { platformStatus: 'المنصة / حالة النظام', aiProviders: 'مزوّدو الذكاء الاصطناعي', personnelRadar: 'رادار الأفراد', noRecords: 'لا توجد سجلات بعد', globalOps: 'عرض العمليات العالمية', askBQI: 'اسأل BQI' },
  };

  it.each(Object.entries(HOME_TRANSLATIONS))('renders in %s when the language is switched, with no leftover Turkish labels', async (lang, tx) => {
    localStorage.setItem('bqi_lang', lang);
    renderHome({ isAdmin: true });
    expect(await screen.findByText('TurkeyMap stub')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^${tx.platformStatus.replace(/[/]/g, '\\/')}$`, 'i'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(tx.aiProviders, 'i'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(tx.personnelRadar, 'i') })).toBeInTheDocument();
    expect(screen.getByText(tx.noRecords)).toBeInTheDocument();
    expect(screen.getByText(tx.globalOps)).toBeInTheDocument();
    expect(screen.getByText(tx.askBQI)).toBeInTheDocument();
    expect(screen.queryByText(/Sistem Durumu/i)).not.toBeInTheDocument();
    localStorage.removeItem('bqi_lang');
  });

  it('registers open_briefing/close_briefing voice actions that drive the modal, and refresh_briefing only for admins', async () => {
    api.morningBriefToday.mockResolvedValue({ exists: true, date: '2026-01-05', items: [{ title: 'Haber' }] });
    renderHome({ isAdmin: true });
    await screen.findByText('TurkeyMap stub');
    await executeAction('open_briefing');
    expect(await screen.findByRole('button', { name: /1\. Haber/i })).toBeInTheDocument();
    await executeAction('close_briefing');
    await waitFor(() => expect(screen.queryByRole('button', { name: /1\. Haber/i })).not.toBeInTheDocument());
    expect(getActionsForAI().map((a) => a.name)).toContain('refresh_briefing');
  });

  it('does not advertise refresh_briefing for a non-admin session', async () => {
    renderHome({ isAdmin: false });
    await screen.findByText('TurkeyMap stub');
    expect(getActionsForAI().map((a) => a.name)).not.toContain('refresh_briefing');
  });

  it('filters briefing items by search query', async () => {
    api.morningBriefToday.mockResolvedValue({ exists: true, date: '2026-01-05', items: [{ title: 'Ekonomi Haberi' }, { title: 'Savunma Haberi' }] });
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: /^Brifing$/i }));
    fireEvent.change(screen.getByPlaceholderText('Başlık veya kaynakta ara…'), { target: { value: 'savunma' } });
    expect(screen.queryByText(/Ekonomi Haberi/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Savunma Haberi/i)).toBeInTheDocument();
  });
});

describe('HomeView command data under Offline Mode', () => {
  afterEach(() => {
    localStorage.removeItem('bqi_app_mode');
  });

  it('never fetches platform health/activity/briefing while Offline Mode is already on at mount', async () => {
    setAppMode('offline');
    renderHome();
    await screen.findByText('TurkeyMap stub');
    // Give the mount effect's async load() a tick to have run (or skipped).
    await waitFor(() => {});
    expect(api.activityFeed).not.toHaveBeenCalled();
    expect(api.morningBriefToday).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads command data once Offline Mode flips back to Auto', async () => {
    setAppMode('offline');
    renderHome();
    await screen.findByText('TurkeyMap stub');
    expect(api.activityFeed).not.toHaveBeenCalled();

    setAppMode('auto');
    await waitFor(() => expect(api.activityFeed).toHaveBeenCalled());
    expect(api.morningBriefToday).toHaveBeenCalled();
  });
});
