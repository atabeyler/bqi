import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import SplashScreen from './SplashScreen.jsx';

afterEach(() => {
  vi.useRealTimers();
});

describe('SplashScreen', () => {
  it('renders the BQI brand and full name', () => {
    render(<SplashScreen />);
    expect(screen.getByText('BQI')).toBeInTheDocument();
    expect(screen.getByText('BOLD QUANTUM INTELLIGENCE')).toBeInTheDocument();
  });

  it('hides itself after the display duration elapses', async () => {
    vi.useFakeTimers();
    render(<SplashScreen />);
    expect(screen.getByText('BQI')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2999); });
    expect(screen.getByText('BQI')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByText('BQI')).not.toBeInTheDocument());
  });

  it('supports BCI branding and reports completion to its route owner', async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(
      <SplashScreen
        logoSrc="/bci-logo.png"
        acronym="BCI"
        fullName="BOLD CYBER INTELLIGENCE"
        onComplete={onComplete}
      />
    );
    expect(screen.getByRole('img', { name: 'BCI' })).toHaveAttribute('src', '/bci-logo.png');
    expect(screen.getByText('BOLD CYBER INTELLIGENCE')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
