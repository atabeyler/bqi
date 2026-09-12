import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CyberAnalysisPage from './CyberAnalysisPage.jsx';

vi.mock('../components/CyberAnalysisContent.jsx', () => ({
  default: () => <div>BCI command center</div>,
}));

vi.mock('../components/EmergencyButton.jsx', () => ({
  default: () => null,
}));

describe('CyberAnalysisPage BCI entry splash', () => {
  it('shows BCI branding for three seconds before mounting the command center', () => {
    vi.useFakeTimers();
    render(<MemoryRouter><CyberAnalysisPage user={{ isAdmin: true }} /></MemoryRouter>);

    expect(screen.getByText('BOLD CYBER INTELLIGENCE')).toBeInTheDocument();
    expect(screen.queryByText('BCI command center')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(2999); });
    expect(screen.queryByText('BCI command center')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText('BCI command center')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
