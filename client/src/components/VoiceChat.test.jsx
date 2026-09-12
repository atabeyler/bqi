import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../services/api.js', () => ({
  api: { chatConsult: vi.fn(async () => ({ response: 'Merhaba, size nasıl yardımcı olabilirim?' })) },
  memoryApi: {
    getProfile: vi.fn(async () => null),
    getContext: vi.fn(async () => ({ context: '' })),
    saveConversation: vi.fn(async () => ({ success: true })),
  },
}));

// ConsultChat/PersonaSelector/MemoryPanel each have their own dedicated test
// files with their own mocking -- stub them here so VoiceChat tests only
// exercise VoiceChat's own tab/panel/voice-loop logic.
vi.mock('./ConsultChat.jsx', () => ({ default: () => <div>ConsultChat stub</div> }));
vi.mock('./PersonaSelector.jsx', () => ({ default: () => <div>PersonaSelector stub</div> }));
vi.mock('./MemoryPanel.jsx', () => ({ default: () => <div>MemoryPanel stub</div> }));

class FakeSpeechRecognition {
  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }
  start() {}
  abort() {}
  stop() {}
}
FakeSpeechRecognition.instances = [];

let VoiceChat;
let LangProvider;
let api;

beforeEach(async () => {
  vi.resetModules();
  FakeSpeechRecognition.instances = [];
  vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition);
  // Imported fresh after resetModules so it shares the same langContext.jsx
  // module instance (and thus the same React Context object) that VoiceChat
  // itself resolves -- otherwise useLang() inside VoiceChat reads from a
  // different Context than the one this LangProvider provides.
  ({ default: VoiceChat } = await import('./VoiceChat.jsx'));
  ({ LangProvider } = await import('../services/langContext.jsx'));
  ({ api } = await import('../services/api.js'));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceChat', () => {
  it('renders the default persona and consultation mode label', async () => {
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);
    expect(await screen.findByText('General')).toBeInTheDocument();
    expect(screen.getByText('DANIŞMA MODU')).toBeInTheDocument();
  });

  it('closes via the home-screen button', () => {
    const onClose = vi.fn();
    render(<LangProvider><VoiceChat onClose={onClose} /></LangProvider>);
    fireEvent.click(screen.getByText('ANA EKRAN'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes via the phone-off button', () => {
    const onClose = vi.fn();
    render(<LangProvider><VoiceChat onClose={onClose} /></LangProvider>);
    const phoneButtons = document.querySelectorAll('.lucide-phone-off');
    fireEvent.click(phoneButtons[0].closest('button'));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches to the chat tab and shows the stubbed ConsultChat', () => {
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);
    fireEvent.click(screen.getByText('SOHBET'));
    expect(screen.getByText('ConsultChat stub')).toBeInTheDocument();
  });

  it('toggles the auto-listen setting', () => {
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);
    // The button's text is "OTO-DİNLE AKTİF" (two interpolated i18n strings),
    // so match on the button containing "OTO-DİNLE" rather than exact text.
    const autoBtn = screen.getAllByRole('button').find((b) => b.textContent.includes('OTO-DİNLE'));
    expect(autoBtn.className).toContain('bg-gold/10'); // on by default
    fireEvent.click(autoBtn);
    expect(autoBtn.className).not.toContain('bg-gold/10');
  });

  it('opens and closes the persona side panel', async () => {
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);
    fireEvent.click(screen.getByText('Karakter'));
    expect(screen.getByText('PersonaSelector stub')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Karakter'));
    await waitFor(() => expect(screen.queryByText('PersonaSelector stub')).not.toBeInTheDocument());
  });

  it('opens the archive side panel', () => {
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);
    fireEvent.click(screen.getByText('Arşiv'));
    expect(screen.getByText('MemoryPanel stub')).toBeInTheDocument();
  });

  it('runs a full voice round-trip: mic click -> transcript -> AI reply added to history', async () => {
    vi.useFakeTimers();
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);

    const micButton = document.querySelector('.lucide-mic.w-8').closest('button');
    fireEvent.click(micButton);
    await act(async () => { vi.advanceTimersByTime(200); });

    const rec = FakeSpeechRecognition.instances.at(-1);
    expect(rec).toBeTruthy();

    await act(async () => {
      await rec.onresult({ results: [[{ transcript: 'merhaba' }]] });
    });
    // Switch to real timers before any further testing-library queries --
    // waitFor/findBy* poll via setTimeout internally, which never fires on
    // its own under fake timers (nothing is advancing them).
    vi.useRealTimers();

    expect(api.chatConsult).toHaveBeenCalledWith('merhaba', [{ role: 'user', content: 'merhaba' }]);
    expect(await screen.findByText('Merhaba, size nasıl yardımcı olabilirim?')).toBeInTheDocument();
    // History is non-empty now, so save/clear controls should appear.
    expect(screen.getByText('Temizle')).toBeInTheDocument();
  });

  it('saves the conversation via memoryApi', async () => {
    vi.useFakeTimers();
    const { memoryApi } = await import('../services/api.js');
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);

    const micButton = document.querySelector('.lucide-mic.w-8').closest('button');
    fireEvent.click(micButton);
    await act(async () => { vi.advanceTimersByTime(200); });
    const rec = FakeSpeechRecognition.instances.at(-1);
    await act(async () => { await rec.onresult({ results: [[{ transcript: 'merhaba' }]] }); });
    vi.useRealTimers();
    await screen.findByText('Merhaba, size nasıl yardımcı olabilirim?');

    fireEvent.click(screen.getByText('Kaydet'));
    await waitFor(() => expect(memoryApi.saveConversation).toHaveBeenCalled());
  });

  it('clears the conversation history', async () => {
    vi.useFakeTimers();
    render(<LangProvider><VoiceChat onClose={vi.fn()} /></LangProvider>);
    const micButton = document.querySelector('.lucide-mic.w-8').closest('button');
    fireEvent.click(micButton);
    await act(async () => { vi.advanceTimersByTime(200); });
    const rec = FakeSpeechRecognition.instances.at(-1);
    await act(async () => { await rec.onresult({ results: [[{ transcript: 'merhaba' }]] }); });
    vi.useRealTimers();
    await screen.findByText('Merhaba, size nasıl yardımcı olabilirim?');

    fireEvent.click(screen.getByText('Temizle'));
    expect(screen.queryByText('Merhaba, size nasıl yardımcı olabilirim?')).not.toBeInTheDocument();
  });
});
