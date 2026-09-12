import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  login: vi.fn(),
  me: vi.fn(),
  securityScore: vi.fn(),
  coverageScore: vi.fn(),
  listScans: vi.fn(),
  listReports: vi.fn(),
};
let tokenStore = null;

vi.mock('../src/api.js', () => ({
  api: mockApi,
  getToken: () => tokenStore,
  setToken: (t) => { tokenStore = t; },
  isLoggedIn: () => Boolean(tokenStore),
}));

const { default: App } = await import('../src/App.jsx');

beforeEach(() => {
  tokenStore = null;
  Object.values(mockApi).forEach((fn) => fn.mockReset());
  mockApi.listScans.mockResolvedValue({ jobs: [] });
  mockApi.listReports.mockResolvedValue({ reports: [] });
});

describe('App routing/auth', () => {
  it('redirects an unauthenticated visitor to /login', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: /bci login/i })).toBeInTheDocument();
  });

  it('logs in, then renders the Dashboard with real score data', async () => {
    mockApi.login.mockResolvedValue({ token: 'fake-jwt' });
    mockApi.me.mockResolvedValue({ email: 'u@x.com', permissions: ['asset:view'] });
    mockApi.securityScore.mockResolvedValue({ score: 82, openFindingCount: 3 });
    mockApi.coverageScore.mockResolvedValue({ score: 60 });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>
    );

    await userEvent.type(screen.getByLabelText(/organization/i), 'acme');
    await userEvent.type(screen.getByLabelText(/email/i), 'u@x.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(mockApi.login).toHaveBeenCalledWith('acme', 'u@x.com', 'secret');
    expect(await screen.findByText('82')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
  });

  it('shows the login error message when credentials are rejected', async () => {
    mockApi.login.mockRejectedValue(new Error('invalid_credentials'));

    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>
    );

    await userEvent.type(screen.getByLabelText(/organization/i), 'acme');
    await userEvent.type(screen.getByLabelText(/email/i), 'u@x.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('invalid_credentials')).toBeInTheDocument();
  });

  it('an already-logged-in visitor to /login is bounced straight to the dashboard', async () => {
    tokenStore = 'fake-jwt';
    mockApi.me.mockResolvedValue({ email: 'u@x.com', permissions: [] });
    mockApi.securityScore.mockResolvedValue({ score: 100, openFindingCount: 0 });
    mockApi.coverageScore.mockResolvedValue({ score: 0, reason: 'no_assets' });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});
