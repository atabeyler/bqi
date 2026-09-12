import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import HistoryView from './HistoryView.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { api } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  api: {
    historyList: vi.fn(async () => []),
    historyGet: vi.fn(async (id) => ({ id, title: 'Detay', category: 'ekonomi', content: '# Rapor' })),
    historyDelete: vi.fn(async () => ({ ok: true })),
    historyDownloadBlob: vi.fn(async (id) => ({ blob: new Blob(['docx']), filename: `BQI_${id}.docx` })),
    historyDownloadPdfBlob: vi.fn(async (id) => ({ blob: new Blob(['pdf']), filename: `BQI_${id}.pdf` })),
  },
}));

const ITEMS = [
  { id: 1, title: 'Ekonomi Raporu', category: 'ekonomi', preview: 'ozet metni', ai_provider: 'claude', engine_label: 'Q CLOUD', device_label: 'Web', created_at: '2026-01-05T10:00:00Z' },
  { id: 2, title: 'Savunma Raporu', category: 'savunma', preview: 'baska ozet', ai_provider: 'gpt', engine_label: 'Q CLOUD', device_label: 'Windows', created_at: '2026-01-01T10:00:00Z' },
];

function renderHistory(props = {}) {
  return render(<LangProvider><HistoryView {...props} /></LangProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('open', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
});

describe('HistoryView', () => {
  it('shows an empty state when there is no history', async () => {
    api.historyList.mockResolvedValue([]);
    renderHistory();
    expect(await screen.findByText('Henüz analiz raporu üretilmemiş.')).toBeInTheDocument();
  });

  it('lists all fetched analyses', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    expect(await screen.findByText('Ekonomi Raporu')).toBeInTheDocument();
    expect(screen.getByText('Savunma Raporu')).toBeInTheDocument();
  });

  it('recovers to an empty list if the fetch fails', async () => {
    api.historyList.mockRejectedValue(new Error('network error'));
    renderHistory();
    await waitFor(() => expect(api.historyList).toHaveBeenCalled());
    expect(await screen.findByText('Henüz analiz raporu üretilmemiş.')).toBeInTheDocument();
  });

  it('filters by search query', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.change(screen.getByPlaceholderText('Başlık veya içerikte ara…'), { target: { value: 'savunma' } });
    expect(screen.queryByText('Ekonomi Raporu')).not.toBeInTheDocument();
    expect(screen.getByText('Savunma Raporu')).toBeInTheDocument();
  });

  it('filters by category dropdown', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'savunma' } });
    expect(screen.queryByText('Ekonomi Raporu')).not.toBeInTheDocument();
    expect(screen.getByText('Savunma Raporu')).toBeInTheDocument();
  });

  it('opens a detail modal with the fetched content on "view"', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByText(/^goruntule$|^görüntüle$/i)[0]);
    await waitFor(() => expect(api.historyGet).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Rapor')).toBeInTheDocument();
  });

  it('alerts the user if fetching the detail fails', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    api.historyGet.mockRejectedValueOnce(new Error('boom'));
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByText(/^goruntule$|^görüntüle$/i)[0]);
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
  });

  it('downloads the docx via an authenticated blob fetch, not an unauthenticated window.open', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByText('İNDİR')[0]);
    await waitFor(() => expect(api.historyDownloadBlob).toHaveBeenCalledWith(1));
    expect(window.open).not.toHaveBeenCalled();
  });

  it('downloads the PDF via an authenticated blob fetch', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByTitle('PDF indir')[0]);
    await waitFor(() => expect(api.historyDownloadPdfBlob).toHaveBeenCalledWith(1));
  });

  it('shares the PDF via the Web Share API when the platform supports file sharing', async () => {
    const shareMock = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: shareMock });
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByTitle('PAYLAŞ')[0]);
    await waitFor(() => expect(api.historyDownloadPdfBlob).toHaveBeenCalledWith(1));
    await waitFor(() => expect(shareMock).toHaveBeenCalled());
  });

  it('falls back to a plain download when the platform has no file-share support', async () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined, share: undefined });
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByTitle('PAYLAŞ')[0]);
    await waitFor(() => expect(api.historyDownloadPdfBlob).toHaveBeenCalledWith(1));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  });

  it('shows each report\'s engine and device label next to its title', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    expect(screen.getByText('Q CLOUD · Web')).toBeInTheDocument();
    expect(screen.getByText('Q CLOUD · Windows')).toBeInTheDocument();
  });

  it('deletes a report after confirmation and removes it from the list', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByTitle('Sil')[0]);
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.historyDelete).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.queryByText('Ekonomi Raporu')).not.toBeInTheDocument());
    expect(screen.getByText('Savunma Raporu')).toBeInTheDocument();
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    api.historyList.mockResolvedValue(ITEMS);
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByTitle('Sil')[0]);
    expect(window.confirm).toHaveBeenCalled();
    expect(api.historyDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Ekonomi Raporu')).toBeInTheDocument();
  });

  it('alerts the user if deletion fails', async () => {
    api.historyList.mockResolvedValue(ITEMS);
    api.historyDelete.mockRejectedValueOnce(new Error('boom'));
    renderHistory();
    await screen.findByText('Ekonomi Raporu');
    fireEvent.click(screen.getAllByTitle('Sil')[0]);
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(screen.getByText('Ekonomi Raporu')).toBeInTheDocument();
  });
});
