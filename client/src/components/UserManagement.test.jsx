import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UserManagementModal from './UserManagement.jsx';
import { adminApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listUsers: vi.fn(async () => []),
    addUser: vi.fn(async () => ({})),
    setBlocked: vi.fn(async () => ({})),
    updateUser: vi.fn(async () => ({})),
    deleteUser: vi.fn(async () => ({})),
    renameUser: vi.fn(async () => ({})),
    auditLog: vi.fn(async () => []),
  },
}));

const USERS = [
  { user_code: 'U1', nickname: 'BOLD-001', is_admin: false, blocked: false },
  { user_code: 'U2', nickname: 'BOLD-002', is_admin: true, blocked: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('UserManagementModal', () => {
  it('lists users with ADMIN/ENGELLİ badges', async () => {
    adminApi.listUsers.mockResolvedValue(USERS);
    render(<UserManagementModal onClose={vi.fn()} />);
    expect(await screen.findByText('U1')).toBeInTheDocument();
    expect(screen.getByText('ADMIN')).toBeInTheDocument();
    expect(screen.getByText('ENGELLİ')).toBeInTheDocument();
  });

  it('shows an empty state with no users', async () => {
    adminApi.listUsers.mockResolvedValue([]);
    render(<UserManagementModal onClose={vi.fn()} />);
    expect(await screen.findByText('Kayıtlı kullanıcı yok.')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    adminApi.listUsers.mockRejectedValue(new Error('sunucu hatasi'));
    render(<UserManagementModal onClose={vi.fn()} />);
    expect(await screen.findByText('sunucu hatasi')).toBeInTheDocument();
  });

  it('closes via the close button', async () => {
    adminApi.listUsers.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<UserManagementModal onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Kapat'));
    expect(onClose).toHaveBeenCalled();
  });

  it('adds a new user through the form and reloads the list', async () => {
    adminApi.listUsers.mockResolvedValue([]);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('Kayıtlı kullanıcı yok.');

    fireEvent.change(screen.getByPlaceholderText('Kullanıcı kodu'), { target: { value: 'NEW1' } });
    fireEvent.change(screen.getByPlaceholderText('Şifre (min 8 karakter)'), { target: { value: 'longenough' } });
    fireEvent.click(screen.getByText('Ekle'));

    await waitFor(() => expect(adminApi.addUser).toHaveBeenCalledWith('NEW1', 'longenough', '', false, ''));
    expect(adminApi.listUsers).toHaveBeenCalledTimes(2); // initial load + reload after add
  });

  it('toggles block status for a user', async () => {
    adminApi.listUsers.mockResolvedValue(USERS);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('U1');
    fireEvent.click(screen.getByTitle('Engelle'));
    await waitFor(() => expect(adminApi.setBlocked).toHaveBeenCalledWith('U1', true));
  });

  it('deletes a user after confirmation', async () => {
    adminApi.listUsers.mockResolvedValue(USERS);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('U1');
    fireEvent.click(screen.getAllByTitle('Sil')[0]);
    await waitFor(() => expect(adminApi.deleteUser).toHaveBeenCalledWith('U1'));
  });

  it('renames a user via the prompt', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'NEWCODE'));
    adminApi.listUsers.mockResolvedValue(USERS);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('U1');
    fireEvent.click(screen.getAllByTitle('Kullanıcı kodunu değiştir')[0]);
    await waitFor(() => expect(adminApi.renameUser).toHaveBeenCalledWith('U1', 'NEWCODE'));
  });

  it('does not rename when the prompt is cancelled or unchanged', async () => {
    vi.stubGlobal('prompt', vi.fn(() => null));
    adminApi.listUsers.mockResolvedValue(USERS);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('U1');
    fireEvent.click(screen.getAllByTitle('Kullanıcı kodunu değiştir')[0]);
    expect(adminApi.renameUser).not.toHaveBeenCalled();
  });

  it('does not delete when confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    adminApi.listUsers.mockResolvedValue(USERS);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('U1');
    fireEvent.click(screen.getAllByTitle('Sil')[0]);
    expect(adminApi.deleteUser).not.toHaveBeenCalled();
  });

  it('edits a user inline and saves via updateUser', async () => {
    adminApi.listUsers.mockResolvedValue(USERS);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('U1');
    fireEvent.click(screen.getAllByTitle('Düzenle')[0]);

    const nicknameInput = screen.getByPlaceholderText('Rumuz');
    fireEvent.change(nicknameInput, { target: { value: 'YENİ-ADI' } });
    fireEvent.click(screen.getByText('Kaydet'));

    await waitFor(() => expect(adminApi.updateUser).toHaveBeenCalledWith('U1', { nickname: 'YENİ-ADI', email: '', isAdmin: false, password: undefined }));
  });

  it('switches to the audit-log tab and lists entries', async () => {
    adminApi.listUsers.mockResolvedValue([]);
    adminApi.auditLog.mockResolvedValue([
      { id: 1, action: 'user_added', actor_nickname: 'BOLD', target_user_code: 'U1', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<UserManagementModal onClose={vi.fn()} />);
    await screen.findByText('Kayıtlı kullanıcı yok.');
    fireEvent.click(screen.getByText('İşlem Kaydı'));
    expect(await screen.findByText('Kullanıcı eklendi')).toBeInTheDocument();
  });
});
