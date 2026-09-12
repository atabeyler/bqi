import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import IdleLogoutGuard from './IdleLogoutGuard.jsx';
import { LangProvider } from '../services/langContext.jsx';

function renderGuard(onIdleLogout) {
  return render(<LangProvider><IdleLogoutGuard onIdleLogout={onIdleLogout} /></LangProvider>);
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem('bqi_lang', 'en');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IdleLogoutGuard', () => {
  it('logs out after the full idle limit with no activity', () => {
    const onIdleLogout = vi.fn();
    renderGuard(onIdleLogout);
    act(() => { vi.advanceTimersByTime(15 * 60 * 1000); });
    expect(onIdleLogout).toHaveBeenCalled();
  });

  it('shows a warning in the last minute and lets the user cancel it, resetting the idle clock', () => {
    const onIdleLogout = vi.fn();
    renderGuard(onIdleLogout);

    act(() => { vi.advanceTimersByTime(14 * 60 * 1000); });
    expect(screen.getByRole('button', { name: /still here/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /still here/i }));
    expect(screen.queryByRole('button', { name: /still here/i })).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(14 * 60 * 1000); });
    expect(onIdleLogout).not.toHaveBeenCalled();
  });

  it('resets the idle clock on real activity (mouse movement)', () => {
    const onIdleLogout = vi.fn();
    renderGuard(onIdleLogout);

    act(() => { vi.advanceTimersByTime(14 * 60 * 1000); });
    fireEvent.mouseMove(window);
    act(() => { vi.advanceTimersByTime(14 * 60 * 1000); });
    expect(onIdleLogout).not.toHaveBeenCalled();
  });
});
