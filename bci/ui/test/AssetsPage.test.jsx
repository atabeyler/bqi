import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LangProvider } from '../src/i18n/LangContext.jsx';

const mockApi = { listAssets: vi.fn(), archiveAsset: vi.fn() };
vi.mock('../src/api.js', () => ({ api: mockApi }));

const authValue = { hasPermission: vi.fn() };
vi.mock('../src/AuthContext.jsx', () => ({ useAuth: () => authValue }));

const { default: AssetsPage } = await import('../src/pages/AssetsPage.jsx');

function renderPage() {
  return render(<LangProvider><AssetsPage /></LangProvider>);
}

beforeEach(() => {
  mockApi.listAssets.mockReset().mockResolvedValue({
    assets: [{ id: '1', name: 'example.com', asset_type: 'DOMAIN', criticality: 'HIGH' }],
  });
  authValue.hasPermission.mockReset();
  mockApi.archiveAsset.mockReset().mockResolvedValue({ asset: { id: '1', status: 'ARCHIVED' } });
});

describe('AssetsPage RBAC-aware rendering', () => {
  it('hides the create form for a user without asset:create', async () => {
    authValue.hasPermission.mockReturnValue(false);
    renderPage();
    expect(await screen.findByText('example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add asset/i })).not.toBeInTheDocument();
  });

  it('shows the create form for a user with asset:create', async () => {
    authValue.hasPermission.mockReturnValue(true);
    renderPage();
    expect(await screen.findByRole('button', { name: /add asset/i })).toBeInTheDocument();
  });

  it('archives an asset only after confirmation', async () => {
    authValue.hasPermission.mockImplementation((permission) => permission === 'asset:update');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalled();
    expect(mockApi.archiveAsset).toHaveBeenCalledWith('1');
    await waitFor(() => expect(mockApi.listAssets).toHaveBeenCalledTimes(2));
    confirm.mockRestore();
  });
});
