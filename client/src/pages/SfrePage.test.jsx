import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SfrePage from './SfrePage.jsx';

vi.mock('../services/langContext.jsx', () => ({ useLang: () => ({ t: (k) => k }) }));
vi.mock('../services/api.js', () => ({
  sfreApi: {
    health: () => Promise.resolve({ storage: 'postgres', models: 28, ledger: { ok: true, length: 0 }, providers: [] }),
    dataStatus: () => Promise.resolve({ datasets: [{ source: 'tefas:tarihsel', field: 'aum', n: 1234 }, { source: 'tefas:tarihsel', field: 'units', n: 1000 }] }),
  },
}));
vi.mock('../components/sfre/RunPanel.jsx', () => ({ default: () => <div>run panel</div> }));
vi.mock('../components/sfre/DataPanel.jsx', () => ({ default: () => <div>data panel</div> }));
vi.mock('../components/sfre/ResultsPanel.jsx', () => ({ default: () => null }));

describe('SfrePage BFI entry', () => {
  it('shows the BFI splash for three seconds, then the console with the logo and live KPI tiles', async () => {
    vi.useFakeTimers();
    render(<MemoryRouter><SfrePage user={{ isAdmin: true }} /></MemoryRouter>);

    expect(screen.getByText('BOLD FINANCIAL INTELLIGENCE')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'BFI' })).toHaveAttribute('src', '/bfi-logo.svg');
    expect(screen.queryByTestId('bfi-kpis')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(2999); });
    expect(screen.queryByTestId('bfi-kpis')).not.toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('bfi-kpis')).toBeInTheDocument();
    expect(screen.getByText('BOLD Financial Intelligence')).toBeInTheDocument();
    expect(screen.getAllByText('postgres').length).toBeGreaterThan(0);
    expect(screen.getByText(/2 · 2,234|2 · 2\.234|2 · 2234/)).toBeInTheDocument();
    vi.useRealTimers();
  });
});
