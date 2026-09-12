import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PersonaSelector from './PersonaSelector.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { memoryApi } from '../services/api.js';
import { ASSISTANT_PERSONAS } from '../services/personas.js';

vi.mock('../services/api.js', () => ({ memoryApi: { updateProfile: vi.fn(async () => ({ success: true })) } }));

function renderSelector(props = {}) {
  return render(<LangProvider><PersonaSelector {...props} /></LangProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PersonaSelector', () => {
  it('pre-fills fields from initialProfile', () => {
    renderSelector({ initialProfile: { display_name: 'Kaan', rank: 'Yüzbaşı', unit: 'MSB', preferred_persona: 'analyst' } });
    expect(screen.getByDisplayValue('Kaan')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Yüzbaşı')).toBeInTheDocument();
    expect(screen.getByDisplayValue('MSB')).toBeInTheDocument();
  });

  it('renders every persona from ASSISTANT_PERSONAS', () => {
    renderSelector();
    for (const p of ASSISTANT_PERSONAS) {
      expect(screen.getByText(p.emoji)).toBeInTheDocument();
    }
  });

  it('selects a different persona on click', () => {
    renderSelector();
    const secondPersona = ASSISTANT_PERSONAS[1];
    fireEvent.click(screen.getByText(secondPersona.emoji).closest('button'));
    // The Check icon (lucide "check" svg) appears only inside the selected card.
    expect(screen.getByText(secondPersona.emoji).closest('button').querySelector('svg.lucide-check')).toBeTruthy();
  });

  it('saves the profile and calls onSave with the current form state', async () => {
    const onSave = vi.fn();
    renderSelector({ onSave });
    fireEvent.change(screen.getByPlaceholderText('Örn: Albay Yılmaz'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /kaydet|save/i }));

    await waitFor(() => expect(memoryApi.updateProfile).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ display_name: 'Ada', preferred_persona: 'general' }));
  });

  it('logs and recovers gracefully if the save call fails', async () => {
    memoryApi.updateProfile.mockRejectedValueOnce(new Error('network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: /kaydet|save/i }));
    await waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    consoleSpy.mockRestore();
  });
});
