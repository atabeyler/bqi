import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DataPanel from './DataPanel.jsx';

const purge = vi.fn(async () => ({ ok: true, removedRows: 1234, freedBytes: 5242880 }));
vi.mock('../../services/langContext.jsx', () => ({ useLang: () => ({ t: (k) => (k === 'sfre_purge_word' ? 'SİL' : k) }) }));
vi.mock('../../services/api.js', () => ({
  sfreApi: {
    federation: async () => ({ items: [{ id: 'fed_x', title: 'breadth-trial', node: 'my-pc', created_at: '2026-10-02T00:00:00Z', summary: 'ok' }] }),
    ingests: async () => ({ ingests: [{ id: 'ingest_a_1', kind: 'tefas', filename: 'f.xlsx', inserted: 5, duplicates: 0, rejected: 0, purged: true }] }),
    dataStatus: async () => ({ size: { observationsBytes: 3145728, databaseBytes: 9437184 } }),
    purge: (...a) => purge(...a),
    upload: vi.fn(),
  },
}));

describe('DataPanel danger zone (admin-only database purge)', () => {
  it('is not shown to non-admins', () => {
    render(<DataPanel isAdmin={false} />);
    expect(screen.queryByTestId('sfre-purge')).toBeNull();
  });
  it('stays disabled until the localised word is typed, then purges once and reports the result', async () => {
    const onChanged = vi.fn();
    render(<DataPanel isAdmin onChanged={onChanged} />);
    const btn = await screen.findByRole('button', { name: 'sfre_purge_button' });
    expect(btn.disabled).toBe(true);
    await waitFor(() => expect(screen.getByText(/3\.0 MB/)).toBeTruthy()); // table size is shown
    const input = screen.getByTestId('sfre-purge').querySelector('input');
    fireEvent.change(input, { target: { value: 'yanlış' } }); expect(btn.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'sil' } }); expect(btn.disabled).toBe(false); // case-insensitive, Turkish-aware
    fireEvent.click(btn);
    await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1[.,]?234/));
    expect(onChanged).toHaveBeenCalled();
  });
});
