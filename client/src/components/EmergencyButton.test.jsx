import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EmergencyButton from './EmergencyButton.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { api, getToken } from '../services/api.js';
import { executeAction } from '../services/voiceActionRegistry.js';

// EmergencyButton's ChatPanel also drives a full WebRTC video-meeting flow
// (RTCPeerConnection/getUserMedia/MediaRecorder/screen share). That's
// browser-API orchestration, not business logic, and isn't covered here --
// these tests focus on the modal/tab/messaging behavior that IS meaningful
// application logic.
const fakeSocket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), id: 'my-socket-id' };
vi.mock('../services/socket.js', () => ({
  connectSocket: () => fakeSocket,
  getSocket: () => fakeSocket,
}));

vi.mock('../services/api.js', () => ({
  api: {
    emergencyCenter: vi.fn(async () => ({ success: true })),
    emergencyUsers: vi.fn(async () => ({ success: true })),
  },
  getToken: vi.fn(() => 'fake-jwt'),
}));

const defaultUser = { userCode: 'BOLD-001', nickname: 'BOLD-001', isAdmin: false };

function renderButton(props = {}) {
  return render(<LangProvider><EmergencyButton authenticated user={defaultUser} {...props} /></LangProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  getToken.mockReturnValue('fake-jwt');
  // jsdom doesn't implement Element.scrollTo -- ChatPanel autoscrolls the message list.
  Element.prototype.scrollTo = vi.fn();
});

describe('EmergencyButton', () => {
  it('opens the modal on a plain click (no drag)', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    expect(screen.getByText('Merkeze Bildir')).toBeInTheDocument();
  });

  it('opens on the "aq:emergency:open" window event, defaulting to the CENTER tab', () => {
    renderButton();
    fireEvent(window, new CustomEvent('aq:emergency:open', { detail: {} }));
    expect(screen.getByText('Merkeze Bildir')).toBeInTheDocument();
  });

  it('opens directly on the CHAT tab and requests the online-user list when the event requests a target user', () => {
    renderButton();
    fireEvent(window, new CustomEvent('aq:emergency:open', { detail: { targetUser: 'BOLD-002' } }));
    expect(fakeSocket.emit).toHaveBeenCalledWith('users:request');
  });

  it('closes via the close button', async () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    fireEvent.click(screen.getByLabelText('Kapat'));
    await waitFor(() => expect(screen.queryByText('Merkeze Bildir')).not.toBeInTheDocument());
  });

  it('disables the messaging tab button when not authenticated', () => {
    renderButton({ authenticated: false });
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    expect(screen.getByText('Mesajlaşma').closest('button')).toBeDisabled();
  });

  it('shows the locked panel when opened directly onto the CHAT tab while unauthenticated', () => {
    renderButton({ authenticated: false });
    fireEvent(window, new CustomEvent('aq:emergency:open', { detail: { forceChat: true } }));
    expect(screen.getByText('YETKİLENDİRİLMİŞ ERİŞİM')).toBeInTheDocument();
  });

  it('sends a message to the center from the CENTER tab', async () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    fireEvent.change(screen.getByPlaceholderText('Acil durum bildirimini detaylı yazınız...'), { target: { value: 'acil durum' } });
    fireEvent.click(screen.getByText('MERKEZE GÖNDER'));
    await waitFor(() => expect(api.emergencyCenter).toHaveBeenCalledWith('acil durum'));
  });

  it('sends a message to all users from the USERS tab', async () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    fireEvent.click(screen.getByText('Kullanıcılara Bildir'));
    fireEvent.change(screen.getByPlaceholderText('Diğer kullanıcılara iletilecek acil mesaj...'), { target: { value: 'herkese haber' } });
    fireEvent.click(screen.getByText('TÜM KULLANICILARA GÖNDER'));
    await waitFor(() => expect(api.emergencyUsers).toHaveBeenCalledWith('herkese haber'));
  });

  it('routes a chat message to the center when "MERKEZ" is the selected recipient', async () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    fireEvent.click(screen.getByText('Mesajlaşma'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'MERKEZ' } });
    fireEvent.change(screen.getByPlaceholderText('MERKEZ kullanıcısına mesaj...'), { target: { value: 'yardim lazim' } });
    fireEvent.click(screen.getByRole('button', { name: '' })); // the icon-only send button

    await waitFor(() => expect(api.emergencyCenter).toHaveBeenCalledWith('yardim lazim'));
  });

  it('routes a chat message over the socket when a specific user is selected', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    fireEvent.click(screen.getByText('Mesajlaşma'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'BOLD-002' } });
    fireEvent.change(screen.getByPlaceholderText('BOLD-002 kullanıcısına mesaj...'), { target: { value: 'merhaba' } });
    fireEvent.click(screen.getByRole('button', { name: '' }));

    expect(fakeSocket.emit).toHaveBeenCalledWith('chat:send', { to: 'BOLD-002', message: 'merhaba' });
  });

  it('registers a close_emergency voice action that closes the modal', async () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    expect(screen.getByText('Merkeze Bildir')).toBeInTheDocument();
    await executeAction('close_emergency');
    await waitFor(() => expect(screen.queryByText('Merkeze Bildir')).not.toBeInTheDocument());
  });

  it('shows the "start video meeting" control only for admins', () => {
    renderButton({ user: { userCode: 'ADMIN-1', nickname: 'BOLD', isAdmin: true } });
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    fireEvent.click(screen.getByText('Mesajlaşma'));
    expect(screen.getByText('Görüntülü Toplantı Başlat')).toBeInTheDocument();
  });

  it('hides the "start video meeting" control for non-admins', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('ACİL MERKEZ'));
    fireEvent.click(screen.getByText('Mesajlaşma'));
    expect(screen.queryByText('Görüntülü Toplantı Başlat')).not.toBeInTheDocument();
  });
});
