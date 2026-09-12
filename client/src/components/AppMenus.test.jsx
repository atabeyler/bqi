import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MenuPanel, SettingsPanel, InfoModal, GuideModal } from './AppMenus.jsx';
import { getAppMode, setAppMode } from '../services/appModePreference.js';

const t = (key) => key;

const listCredentialsMock = vi.fn();
const renameCredentialMock = vi.fn();
const removeCredentialMock = vi.fn();
vi.mock('../services/api.js', () => ({
  api: {
    webauthn: {
      listCredentials: (...args) => listCredentialsMock(...args),
      renameCredential: (...args) => renameCredentialMock(...args),
      removeCredential: (...args) => removeCredentialMock(...args),
    },
  },
}));

const isPasskeySupportedMock = vi.fn(() => true);
const registerPasskeyMock = vi.fn();
vi.mock('../services/webauthn.js', () => ({
  isPasskeySupported: (...args) => isPasskeySupportedMock(...args),
  registerPasskey: (...args) => registerPasskeyMock(...args),
}));

describe('MenuPanel', () => {
  it('renders each menu item and triggers its handler', () => {
    const onOpenGuide = vi.fn();
    const onOpenInfo = vi.fn();
    const onClose = vi.fn();
    render(<MenuPanel t={t} onClose={onClose} onOpenGuide={onOpenGuide} onOpenInfo={onOpenInfo} />);

    fireEvent.click(screen.getByText('usageGuideTitle'));
    expect(onOpenGuide).toHaveBeenCalled();

    fireEvent.click(screen.getByText('menuAboutUs'));
    expect(onOpenInfo).toHaveBeenCalledWith('about');

    fireEvent.click(screen.getByText('menuMissionVision'));
    expect(onOpenInfo).toHaveBeenCalledWith('mission');

    fireEvent.click(screen.getByText('menuContact'));
    expect(onOpenInfo).toHaveBeenCalledWith('contact');
  });

  it('closes via the close button and the background overlay', () => {
    const onClose = vi.fn();
    render(<MenuPanel t={t} onClose={onClose} onOpenGuide={vi.fn()} onOpenInfo={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('menuTooltip'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('SettingsPanel', () => {
  function renderSettings(overrides = {}) {
    const props = {
      t, lang: 'tr', setLang: vi.fn(), onClose: vi.fn(),
      soundEnabled: true, setSoundEnabled: vi.fn(),
      soundVolume: 0.1, setSoundVolume: vi.fn(),
      sidebarCollapsed: false, setSidebarCollapsed: vi.fn(),
      onOpenGuide: vi.fn(),
      ...overrides,
    };
    render(<SettingsPanel {...props} />);
    return props;
  }

  it('defaults to the language tab and selects a language', () => {
    const props = renderSettings();
    fireEvent.click(screen.getByText('Deutsch'));
    expect(props.setLang).toHaveBeenCalledWith('de');
  });

  it('shows a checkmark next to the active language', () => {
    renderSettings({ lang: 'fr' });
    const frenchRow = screen.getByText('Français').closest('button');
    expect(frenchRow.querySelector('svg.lucide-check')).toBeTruthy();
  });

  it('toggles sound on the sound tab', () => {
    const props = renderSettings();
    fireEvent.click(screen.getByText('settingsSound'));
    fireEvent.click(screen.getByText('settingsSoundEnable'));
    expect(props.setSoundEnabled).toHaveBeenCalled();
  });

  it('adjusts the sound volume slider', () => {
    const props = renderSettings();
    fireEvent.click(screen.getByText('settingsSound'));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.15' } });
    expect(props.setSoundVolume).toHaveBeenCalledWith(0.15);
  });

  it('toggles sidebar collapse on the appearance tab (shown when showAppearance=true)', () => {
    const props = renderSettings({ showAppearance: true });
    fireEvent.click(screen.getByText('settingsAppearance'));
    fireEvent.click(screen.getByText('settingsCollapseSidebar'));
    expect(props.setSidebarCollapsed).toHaveBeenCalled();
  });

  it('hides the appearance tab when showAppearance=false', () => {
    renderSettings({ showAppearance: false });
    expect(screen.queryByText('settingsAppearance')).not.toBeInTheDocument();
  });

  it('does not render the sidebar-collapse button when setSidebarCollapsed is absent (e.g. LoginPage)', () => {
    renderSettings({ showAppearance: true, sidebarCollapsed: undefined, setSidebarCollapsed: undefined });
    fireEvent.click(screen.getByText('settingsAppearance'));
    expect(screen.queryByText('settingsCollapseSidebar')).not.toBeInTheDocument();
  });

  it('opens the usage guide from the about tab', () => {
    const props = renderSettings();
    fireEvent.click(screen.getByText('settingsAbout'));
    fireEvent.click(screen.getByText('settingsOpenGuide'));
    expect(props.onOpenGuide).toHaveBeenCalled();
  });

  it('hides the security tab when not authenticated', () => {
    renderSettings({ authenticated: false });
    expect(screen.queryByText('settingsSecurity')).not.toBeInTheDocument();
  });

  describe('security tab (authenticated)', () => {
    beforeEach(() => {
      listCredentialsMock.mockReset().mockResolvedValue([]);
      renameCredentialMock.mockReset();
      removeCredentialMock.mockReset();
      registerPasskeyMock.mockReset();
      isPasskeySupportedMock.mockReset().mockReturnValue(true);
    });

    it('lists registered passkeys with their created/last-used timestamps', async () => {
      listCredentialsMock.mockResolvedValue([
        { id: 1, deviceName: 'iPhone 15', backedUp: true, createdAt: '2026-01-05T10:00:00Z', lastUsedAt: null },
      ]);
      renderSettings({ authenticated: true });

      fireEvent.click(screen.getByText('settingsSecurity'));
      await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());
      expect(screen.getByText(/securityPasskeyCreated/)).toBeInTheDocument();
      expect(screen.getByText('securityPasskeyNeverUsed')).toBeInTheDocument();
    });

    it('asks for confirmation before removing a passkey, and does not remove it on cancel', async () => {
      listCredentialsMock.mockResolvedValue([
        { id: 1, deviceName: 'iPhone 15', backedUp: true, createdAt: '2026-01-05T10:00:00Z', lastUsedAt: null },
      ]);
      renderSettings({ authenticated: true });
      fireEvent.click(screen.getByText('settingsSecurity'));
      await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText('securityPasskeyRemove'));
      expect(await screen.findByText('securityPasskeyRemoveConfirmTitle')).toBeInTheDocument();
      expect(removeCredentialMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('cancel'));
      await waitFor(() => expect(screen.queryByText('securityPasskeyRemoveConfirmTitle')).not.toBeInTheDocument());
      expect(removeCredentialMock).not.toHaveBeenCalled();
      expect(screen.getByText('iPhone 15')).toBeInTheDocument();
    });

    it('removes the passkey only after the confirmation modal is confirmed', async () => {
      listCredentialsMock.mockResolvedValue([
        { id: 1, deviceName: 'iPhone 15', backedUp: true, createdAt: '2026-01-05T10:00:00Z', lastUsedAt: null },
      ]);
      removeCredentialMock.mockResolvedValue({ success: true });
      renderSettings({ authenticated: true });
      fireEvent.click(screen.getByText('settingsSecurity'));
      await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText('securityPasskeyRemove'));
      const modalTitle = await screen.findByText('securityPasskeyRemoveConfirmTitle');
      const modal = modalTitle.closest('[class*="hud-panel"]');

      fireEvent.click(within(modal).getByRole('button', { name: 'securityPasskeyRemove' }));
      await waitFor(() => expect(removeCredentialMock).toHaveBeenCalledWith(1));
      await waitFor(() => expect(screen.queryByText('iPhone 15')).not.toBeInTheDocument());
      // The modal's exit animation (AnimatePresence) can keep it mounted for
      // a tick after removeTarget clears, so this needs to tolerate that
      // instead of asserting synchronously.
      await waitFor(() => expect(screen.queryAllByText('securityPasskeyRemoveConfirmTitle')).toHaveLength(0));
    });

    it('shows the empty state when no passkeys are registered', async () => {
      renderSettings({ authenticated: true });
      fireEvent.click(screen.getByText('settingsSecurity'));
      await waitFor(() => expect(screen.getByText('securityPasskeyEmpty')).toBeInTheDocument());
    });

    it('lets the user name a passkey during registration', async () => {
      registerPasskeyMock.mockResolvedValue({ success: true });
      listCredentialsMock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 2, deviceName: 'Work Laptop', backedUp: false, createdAt: '2026-01-05T10:00:00Z', lastUsedAt: null }]);
      renderSettings({ authenticated: true });

      fireEvent.click(screen.getByText('settingsSecurity'));
      await waitFor(() => expect(screen.getByText('securityPasskeyEmpty')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('securityPasskeyNamePh'), { target: { value: 'Work Laptop' } });
      fireEvent.click(screen.getByText('securityPasskeyAdd'));
      await waitFor(() => expect(registerPasskeyMock).toHaveBeenCalledWith('Work Laptop'));
      await waitFor(() => expect(screen.getByText('Work Laptop')).toBeInTheDocument());
    });

    it('registers with an undefined name (server picks a safe default) when the name field is left blank', async () => {
      registerPasskeyMock.mockResolvedValue({ success: true });
      listCredentialsMock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 2, deviceName: 'Passkey', backedUp: false, createdAt: '2026-01-05T10:00:00Z', lastUsedAt: null }]);
      renderSettings({ authenticated: true });

      fireEvent.click(screen.getByText('settingsSecurity'));
      await waitFor(() => expect(screen.getByText('securityPasskeyEmpty')).toBeInTheDocument());

      fireEvent.click(screen.getByText('securityPasskeyAdd'));
      await waitFor(() => expect(registerPasskeyMock).toHaveBeenCalledWith(undefined));
      await waitFor(() => expect(screen.getByText('Passkey')).toBeInTheDocument());
    });

    it('disables the add button when the browser does not support passkeys', async () => {
      isPasskeySupportedMock.mockReturnValue(false);
      renderSettings({ authenticated: true });
      fireEvent.click(screen.getByText('settingsSecurity'));
      await waitFor(() => expect(screen.getByText('securityPasskeyUnsupported')).toBeInTheDocument());
      expect(screen.getByText('securityPasskeyAdd').closest('button')).toBeDisabled();
    });
  });
});

describe('SettingsPanel: Connection tab (Offline Mode)', () => {
  function renderSettings(overrides = {}) {
    const props = {
      t, lang: 'tr', setLang: vi.fn(), onClose: vi.fn(),
      soundEnabled: true, setSoundEnabled: vi.fn(),
      soundVolume: 0.1, setSoundVolume: vi.fn(),
      sidebarCollapsed: false, setSidebarCollapsed: vi.fn(),
      onOpenGuide: vi.fn(),
      ...overrides,
    };
    render(<SettingsPanel {...props} />);
    return props;
  }

  beforeEach(() => {
    localStorage.removeItem('bqi_app_mode');
  });

  afterEach(() => {
    localStorage.removeItem('bqi_app_mode');
  });

  it('renders the Connection tab and reflects the current (auto) mode', () => {
    renderSettings();
    fireEvent.click(screen.getByText('settingsConnection'));
    expect(screen.getByText('appModeTitle')).toBeInTheDocument();
    expect(screen.getByText('appModeAuto').closest('button')).toHaveClass('border-cyan-300/70');
    expect(screen.queryByText('appModeManualBadge')).not.toBeInTheDocument();
  });

  it('reflects an already-offline stored mode without any confirmation', () => {
    setAppMode('offline');
    renderSettings();
    fireEvent.click(screen.getByText('settingsConnection'));
    expect(screen.getByText('appModeOffline').closest('button')).toHaveClass('border-gold/70');
    expect(screen.getByText('appModeManualBadge')).toBeInTheDocument();
  });

  it('switching to Offline shows a confirm modal and only calls setAppMode on confirm', () => {
    renderSettings();
    fireEvent.click(screen.getByText('settingsConnection'));
    fireEvent.click(screen.getByText('appModeOffline'));

    expect(screen.getByText('appModeOfflineConfirmTitle')).toBeInTheDocument();
    expect(getAppMode()).toBe('auto');

    fireEvent.click(screen.getByText('appModeOfflineConfirmBtn'));
    expect(getAppMode()).toBe('offline');
  });

  it('canceling the Offline confirm modal leaves the mode unchanged', async () => {
    renderSettings();
    fireEvent.click(screen.getByText('settingsConnection'));
    fireEvent.click(screen.getByText('appModeOffline'));
    expect(screen.getByText('appModeOfflineConfirmTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('appModeOfflineCancelBtn'));
    // The modal's exit animation (AnimatePresence) can keep it mounted for a
    // tick after confirmOpen clears -- mirrors the passkey-remove-confirm
    // test above.
    await waitFor(() => expect(screen.queryAllByText('appModeOfflineConfirmTitle')).toHaveLength(0));
    expect(getAppMode()).toBe('auto');
  });

  it('switching to Auto does not show a confirm modal and calls setAppMode immediately', () => {
    setAppMode('offline');
    renderSettings();
    fireEvent.click(screen.getByText('settingsConnection'));
    fireEvent.click(screen.getByText('appModeAuto'));

    expect(screen.queryByText('appModeOfflineConfirmTitle')).not.toBeInTheDocument();
    expect(getAppMode()).toBe('auto');
  });
});

describe('SecurityPanel: passkey gating under Offline Mode', () => {
  beforeEach(() => {
    localStorage.removeItem('bqi_app_mode');
    listCredentialsMock.mockReset().mockResolvedValue([]);
    isPasskeySupportedMock.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    localStorage.removeItem('bqi_app_mode');
  });

  it('disables the add-passkey button, shows a hint, and never calls listCredentials when Offline Mode is on', async () => {
    setAppMode('offline');
    render(<SettingsPanel t={t} lang="tr" setLang={vi.fn()} onClose={vi.fn()} soundEnabled setSoundEnabled={vi.fn()} soundVolume={0.1} setSoundVolume={vi.fn()} authenticated />);
    fireEvent.click(screen.getByText('settingsSecurity'));
    await waitFor(() => expect(screen.getByText('securityPasskeyEmpty')).toBeInTheDocument());
    expect(screen.getByText('securityPasskeyOfflineModeHint')).toBeInTheDocument();
    expect(screen.getByText('securityPasskeyAdd').closest('button')).toBeDisabled();
    // The empty list above must come from skipping the fetch, not from a
    // real (mocked) round-trip that happened to resolve empty.
    expect(listCredentialsMock).not.toHaveBeenCalled();
  });

  it('fetches the passkey list once Offline Mode flips back to Auto', async () => {
    setAppMode('offline');
    render(<SettingsPanel t={t} lang="tr" setLang={vi.fn()} onClose={vi.fn()} soundEnabled setSoundEnabled={vi.fn()} soundVolume={0.1} setSoundVolume={vi.fn()} authenticated />);
    fireEvent.click(screen.getByText('settingsSecurity'));
    await waitFor(() => expect(screen.getByText('securityPasskeyEmpty')).toBeInTheDocument());
    expect(listCredentialsMock).not.toHaveBeenCalled();

    setAppMode('auto');
    await waitFor(() => expect(listCredentialsMock).toHaveBeenCalled());
  });

  it('leaves the add-passkey button enabled in Auto mode', async () => {
    render(<SettingsPanel t={t} lang="tr" setLang={vi.fn()} onClose={vi.fn()} soundEnabled setSoundEnabled={vi.fn()} soundVolume={0.1} setSoundVolume={vi.fn()} authenticated />);
    fireEvent.click(screen.getByText('settingsSecurity'));
    await waitFor(() => expect(screen.getByText('securityPasskeyEmpty')).toBeInTheDocument());
    expect(screen.queryByText('securityPasskeyOfflineModeHint')).not.toBeInTheDocument();
    expect(screen.getByText('securityPasskeyAdd').closest('button')).not.toBeDisabled();
  });
});

describe('InfoModal', () => {
  it('renders the "about" panel content', () => {
    render(<InfoModal panel="about" t={t} onClose={vi.fn()} />);
    expect(screen.getByText('aboutUsTitle')).toBeInTheDocument();
  });

  it('renders the "mission" panel with both mission and vision sections', () => {
    render(<InfoModal panel="mission" t={t} onClose={vi.fn()} />);
    expect(screen.getByText('missionLabel')).toBeInTheDocument();
    expect(screen.getByText('visionLabel')).toBeInTheDocument();
  });

  it('renders the "contact" panel with the contact email', () => {
    render(<InfoModal panel="contact" t={t} onClose={vi.fn()} />);
    expect(screen.getByText(/info@boldas\.com\.tr/)).toBeInTheDocument();
  });

  it('renders nothing for an unrecognized panel', () => {
    const { container } = render(<InfoModal panel="bogus" t={t} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    render(<InfoModal panel="about" t={t} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('GuideModal', () => {
  it('renders Turkish guide modules by default', () => {
    render(<GuideModal onClose={vi.fn()} t={t} lang="tr" />);
    expect(screen.getByText('1) Üst Çubuk')).toBeInTheDocument();
  });

  it('renders English guide modules when lang="en"', () => {
    render(<GuideModal onClose={vi.fn()} t={t} lang="en" />);
    expect(screen.getByText('1) Top Bar')).toBeInTheDocument();
  });

  it('falls back to English for an unsupported language', () => {
    render(<GuideModal onClose={vi.fn()} t={t} lang="xx" />);
    expect(screen.getByText('1) Top Bar')).toBeInTheDocument();
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    render(<GuideModal onClose={onClose} t={t} lang="tr" />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
