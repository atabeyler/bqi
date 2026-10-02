import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReportsPanel from './ReportsPanel.jsx';

let list; const del = vi.fn(async () => ({ ok: true })); const archive = vi.fn(async () => ({ report: { id: 'rp_NEW' } }));
vi.mock('../../services/langContext.jsx', () => ({ useLang: () => ({ t: (k) => k }) }));
const reportBlob = vi.fn(async (id, fmt) => ({ blob: new Blob(['x']), filename: `BFI-${fmt}` })); const downloadBlob = vi.fn(async () => {}); const shareOrDownloadBlob = vi.fn(async () => {});
vi.mock('../../services/api.js', () => ({ sfreApi: { reportsList: async () => ({ reports: list }), reportDelete: (...a) => del(...a), reportArchive: (...a) => archive(...a), reportHtml: vi.fn(), reportBlob: (...a) => reportBlob(...a) } }));
vi.mock('../../services/shareFile.js', () => ({ downloadBlob: (...a) => downloadBlob(...a), shareOrDownloadBlob: (...a) => shareOrDownloadBlob(...a) }));
const rep = (id, lv, formats = ['html', 'pdf', 'docx']) => ({ id: `rp_${id}`, document_id: id, level_tr: lv, created_at: '2026-09-26T10:00:00Z', data_as_of: '2026-09-25', trigger: 'daily', formats });

describe('ReportsPanel (archive)', () => {
  it('lists archived reports with level, date and trigger, or says the archive is empty', async () => {
    list = []; const { unmount } = render(<ReportsPanel isAdmin />); expect(await screen.findByText('sfre_rep_empty')).toBeTruthy(); unmount();
    list = [rep('AAAAAAAAAAAA', 'ALARM')]; render(<ReportsPanel isAdmin />);
    expect(await screen.findByText('ALARM')).toBeTruthy(); expect(screen.getByText('sfre_rep_trigger_daily')).toBeTruthy(); expect(screen.getByText(/2026-09-26 10:00/)).toBeTruthy();
  });
  it('archives the current report on demand and reloads the list', async () => {
    list = []; render(<ReportsPanel isAdmin />); await screen.findByText('sfre_rep_empty');
    list = [rep('BBBBBBBBBBBB', 'NORMAL')]; fireEvent.click(screen.getByRole('button', { name: 'sfre_rep_archive_now' }));
    expect(await screen.findByText('NORMAL')).toBeTruthy(); expect(archive).toHaveBeenCalledTimes(1); expect(screen.getByText('sfre_rep_archived')).toBeTruthy();
  });
  it('deletes only after a second click (admin) and hides the delete button from non-admins', async () => {
    list = [rep('CCCCCCCCCCCC', 'İZLEME')]; const { unmount } = render(<ReportsPanel isAdmin />);
    const btn = await screen.findByRole('button', { name: /sfre_rep_delete CCCCCCCCCCCC/ });
    fireEvent.click(btn); expect(del).not.toHaveBeenCalled(); expect(btn.textContent).toBe('sfre_rep_delete_confirm');
    list = []; fireEvent.click(btn); await waitFor(() => expect(del).toHaveBeenCalledWith('rp_CCCCCCCCCCCC')); expect(await screen.findByText('sfre_rep_empty')).toBeTruthy(); unmount();
    list = [rep('DDDDDDDDDDDD', 'ALARM')]; render(<ReportsPanel isAdmin={false} />); await screen.findByText('ALARM'); expect(screen.queryByRole('button', { name: /sfre_rep_delete/ })).toBeNull();
  });
  it('downloads PDF and Word and shares, for the current report and for an archived one', async () => {
    list = [rep('EEEEEEEEEEEE', 'ALARM')]; render(<ReportsPanel isAdmin />); await screen.findByText('ALARM');
    fireEvent.click(screen.getByRole('button', { name: 'sfre_rep_pdf' })); await waitFor(() => expect(reportBlob).toHaveBeenCalledWith(null, 'pdf')); await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'sfre_rep_word' })); await waitFor(() => expect(reportBlob).toHaveBeenCalledWith(null, 'docx'));
    fireEvent.click(screen.getAllByRole('button', { name: 'sfre_rep_share' })[0]); await waitFor(() => expect(shareOrDownloadBlob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /sfre_rep_pdf EEEEEEEEEEEE/ })); await waitFor(() => expect(reportBlob).toHaveBeenCalledWith('rp_EEEEEEEEEEEE', 'pdf'));
    fireEvent.click(screen.getByRole('button', { name: /sfre_rep_share EEEEEEEEEEEE/ })); await waitFor(() => expect(shareOrDownloadBlob).toHaveBeenCalledTimes(2));
  });
  it('offers no PDF/Word for an older archived report that only has its HTML', async () => {
    list = [rep('FFFFFFFFFFFF', 'NORMAL', ['html'])]; render(<ReportsPanel isAdmin />); await screen.findByText('NORMAL');
    expect(screen.queryByRole('button', { name: /sfre_rep_pdf FFFFFFFFFFFF/ })).toBeNull(); expect(screen.getByRole('button', { name: /sfre_rep_open FFFFFFFFFFFF/ })).toBeTruthy();
  });
});
