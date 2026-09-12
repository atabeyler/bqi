import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MemoryPanel from './MemoryPanel.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { memoryApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  memoryApi: {
    getConversations: vi.fn(async () => []),
    archiveConversation: vi.fn(async () => ({})),
    deleteConversation: vi.fn(async () => ({})),
    getConversation: vi.fn(async () => ({ id: 1 })),
  },
}));

const CONVERSATIONS = [
  { id: 1, session_title: 'Ekonomi senaryosu', summary: 'Bir ozet metni', persona_id: 'analyst', created_at: '2026-01-05T10:00:00Z', archived: false },
  { id: 2, session_title: 'Savunma brifingi', summary: null, persona_id: 'general', created_at: '2026-01-01T10:00:00Z', archived: true },
];

function renderPanel(props = {}) {
  return render(<LangProvider><MemoryPanel {...props} /></LangProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('MemoryPanel', () => {
  it('shows an empty state when there are no saved conversations', async () => {
    memoryApi.getConversations.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(memoryApi.getConversations).toHaveBeenCalled());
    expect(await screen.findByText('Henüz kayıtlı konuşma yok.')).toBeInTheDocument();
  });

  it('lists only non-archived conversations by default, toggle reveals archived ones', async () => {
    memoryApi.getConversations.mockResolvedValue(CONVERSATIONS);
    renderPanel();
    expect(await screen.findByText('Ekonomi senaryosu')).toBeInTheDocument();
    expect(screen.queryByText('Savunma brifingi')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Arşivi Göster'));
    expect(await screen.findByText('Savunma brifingi')).toBeInTheDocument();
  });

  it('filters conversations by the search query', async () => {
    memoryApi.getConversations.mockResolvedValue(CONVERSATIONS);
    renderPanel();
    await screen.findByText('Ekonomi senaryosu');
    fireEvent.change(screen.getByPlaceholderText('Konuşmalarda ara…'), { target: { value: 'savunma' } });
    // "Savunma brifingi" is archived, so it's still hidden even though it matches the query.
    expect(screen.queryByText('Ekonomi senaryosu')).not.toBeInTheDocument();
    expect(screen.queryByText('Savunma brifingi')).not.toBeInTheDocument();
  });

  it('expands a conversation to reveal its summary and actions', async () => {
    memoryApi.getConversations.mockResolvedValue(CONVERSATIONS);
    renderPanel();
    const row = await screen.findByText('Ekonomi senaryosu');
    fireEvent.click(row);
    expect(await screen.findByText(/Bir ozet metni/)).toBeInTheDocument();
  });

  it('loads a conversation and forwards it to onLoadConversation', async () => {
    memoryApi.getConversations.mockResolvedValue(CONVERSATIONS);
    memoryApi.getConversation.mockResolvedValue({ id: 1, full: true });
    const onLoadConversation = vi.fn();
    renderPanel({ onLoadConversation });
    fireEvent.click(await screen.findByText('Ekonomi senaryosu'));
    fireEvent.click(await screen.findByText('Konuşmayı Yükle'));
    await waitFor(() => expect(onLoadConversation).toHaveBeenCalledWith({ id: 1, full: true }));
  });

  it('archives a conversation', async () => {
    memoryApi.getConversations.mockResolvedValue(CONVERSATIONS);
    renderPanel();
    fireEvent.click(await screen.findByText('Ekonomi senaryosu'));
    fireEvent.click(await screen.findByText('Arşivle'));
    await waitFor(() => expect(memoryApi.archiveConversation).toHaveBeenCalledWith(1, true));
  });

  it('deletes a conversation after confirmation', async () => {
    memoryApi.getConversations.mockResolvedValue(CONVERSATIONS);
    renderPanel();
    fireEvent.click(await screen.findByText('Ekonomi senaryosu'));
    fireEvent.click(await screen.findByText(/sil/i));
    await waitFor(() => expect(memoryApi.deleteConversation).toHaveBeenCalledWith(1));
    expect(screen.queryByText('Ekonomi senaryosu')).not.toBeInTheDocument();
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    memoryApi.getConversations.mockResolvedValue(CONVERSATIONS);
    renderPanel();
    fireEvent.click(await screen.findByText('Ekonomi senaryosu'));
    fireEvent.click(await screen.findByText(/sil/i));
    expect(memoryApi.deleteConversation).not.toHaveBeenCalled();
  });
});
