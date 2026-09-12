import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LangProvider } from '../src/i18n/LangContext.jsx';

const mockApi = { listScans: vi.fn(), getScan: vi.fn(), archiveScan: vi.fn(), unarchiveScan: vi.fn(), deleteScan: vi.fn() };
vi.mock('../src/api.js', () => ({ api: mockApi }));
const authValue = { hasPermission: vi.fn() };
vi.mock('../src/AuthContext.jsx', () => ({ useAuth: () => authValue }));
const { default: ScansPage } = await import('../src/pages/ScansPage.jsx');

beforeEach(() => {
  mockApi.listScans.mockReset().mockResolvedValue({ jobs: [{ id: 'scan-1', target: 'example.com', requested_class: 'SAFE_ACTIVE', status: 'COMPLETED', attempts: 1 }] });
  mockApi.getScan.mockReset().mockResolvedValue({ job: { id: 'scan-1', target: 'example.com', requested_class: 'SAFE_ACTIVE', status: 'COMPLETED', attempts: 1 } });
  mockApi.deleteScan.mockReset().mockResolvedValue({ job: { id: 'scan-1' } });
  authValue.hasPermission.mockReset().mockReturnValue(true);
});

describe('ScansPage', () => {
  it('only lists scans and has no create form', async () => {
    render(<MemoryRouter><LangProvider><ScansPage /></LangProvider></MemoryRouter>);
    expect(await screen.findByText('example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start scan/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/target/i)).not.toBeInTheDocument();
  });

  it('inspects and deletes a terminal scan after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoryRouter><LangProvider><ScansPage /></LangProvider></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(await screen.findByText('scan-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mockApi.deleteScan).toHaveBeenCalledWith('scan-1');
    window.confirm.mockRestore();
  });
});
