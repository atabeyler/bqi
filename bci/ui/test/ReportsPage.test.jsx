import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LangProvider } from '../src/i18n/LangContext.jsx';

const mockApi = { listReports: vi.fn(), generateReport: vi.fn(), getReport: vi.fn(), deleteReport: vi.fn() };
vi.mock('../src/api.js', () => ({ api: mockApi }));
const authValue = { hasPermission: vi.fn() };
vi.mock('../src/AuthContext.jsx', () => ({ useAuth: () => authValue }));
const { default: ReportsPage } = await import('../src/pages/ReportsPage.jsx');

beforeEach(() => {
  mockApi.listReports.mockReset().mockResolvedValue({ reports: [{ id: 'report-1', report_type: 'FULL', created_at: '2026-09-11T00:00:00Z', bci_version: '1.0' }] });
  mockApi.generateReport.mockReset().mockResolvedValue({});
  mockApi.getReport.mockReset().mockResolvedValue({ report: { id: 'report-1', report_type: 'FULL', content_hash: 'a'.repeat(64), integrityValid: true, content: { findingCount: 1, findings: [{ id: 'finding-1', evidence_hash: 'b'.repeat(64) }] } } });
  mockApi.deleteReport.mockReset().mockResolvedValue({ report: { id: 'report-1' } });
  authValue.hasPermission.mockReset().mockReturnValue(true);
});

describe('ReportsPage', () => {
  it('offers FULL generation and renders every field without a raw JSON pre block', async () => {
    const { container } = render(<MemoryRouter><LangProvider><ReportsPage /></LangProvider></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: /generate full/i }));
    expect(mockApi.generateReport).toHaveBeenCalledWith('FULL', 'en');
    await userEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('finding-1')).toBeInTheDocument();
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('soft-deletes only after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoryRouter><LangProvider><ReportsPage /></LangProvider></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(mockApi.deleteReport).toHaveBeenCalledWith('report-1');
    window.confirm.mockRestore();
  });
});
