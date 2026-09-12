import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VoiceButton from './VoiceButton.jsx';
import { LangProvider } from '../services/langContext.jsx';

const useVoiceMock = vi.fn();
vi.mock('../hooks/useVoice.js', () => ({ useVoice: () => useVoiceMock() }));

function renderVoiceButton(props) {
  return render(<LangProvider><VoiceButton {...props} /></LangProvider>);
}

beforeEach(() => {
  useVoiceMock.mockReset();
});

describe('VoiceButton mode="input"', () => {
  it('starts recording on click when not already recording', () => {
    const startRecording = vi.fn();
    useVoiceMock.mockReturnValue({ recording: false, speaking: false, startRecording, stopRecording: vi.fn(), speak: vi.fn(), stopSpeaking: vi.fn() });
    renderVoiceButton({ mode: 'input', onTranscript: vi.fn() });
    fireEvent.click(screen.getByRole('button'));
    expect(startRecording).toHaveBeenCalled();
  });

  it('stops recording on click when already recording', () => {
    const stopRecording = vi.fn();
    useVoiceMock.mockReturnValue({ recording: true, speaking: false, startRecording: vi.fn(), stopRecording, speak: vi.fn(), stopSpeaking: vi.fn() });
    renderVoiceButton({ mode: 'input', onTranscript: vi.fn() });
    fireEvent.click(screen.getByRole('button'));
    expect(stopRecording).toHaveBeenCalled();
  });

  it('forwards the recognized transcript to onTranscript', () => {
    const onTranscript = vi.fn();
    let capturedCallback;
    useVoiceMock.mockReturnValue({
      recording: false,
      speaking: false,
      startRecording: (_lang, cb) => { capturedCallback = cb; },
      stopRecording: vi.fn(),
      speak: vi.fn(),
      stopSpeaking: vi.fn(),
    });
    renderVoiceButton({ mode: 'input', onTranscript });
    fireEvent.click(screen.getByRole('button'));
    capturedCallback('merhaba dünya');
    expect(onTranscript).toHaveBeenCalledWith('merhaba dünya');
  });
});

describe('VoiceButton mode="output"', () => {
  it('speaks the given text on click when not already speaking', () => {
    const speak = vi.fn();
    useVoiceMock.mockReturnValue({ recording: false, speaking: false, startRecording: vi.fn(), stopRecording: vi.fn(), speak, stopSpeaking: vi.fn() });
    renderVoiceButton({ mode: 'output', text: 'okunacak metin' });
    fireEvent.click(screen.getByRole('button'));
    expect(speak).toHaveBeenCalledWith('okunacak metin', navigator.language);
  });

  it('stops speaking on click when already speaking', () => {
    const stopSpeaking = vi.fn();
    useVoiceMock.mockReturnValue({ recording: false, speaking: true, startRecording: vi.fn(), stopRecording: vi.fn(), speak: vi.fn(), stopSpeaking });
    renderVoiceButton({ mode: 'output', text: 'x' });
    fireEvent.click(screen.getByRole('button'));
    expect(stopSpeaking).toHaveBeenCalled();
  });
});

describe('VoiceButton unknown mode', () => {
  it('renders nothing for an unrecognized mode', () => {
    useVoiceMock.mockReturnValue({ recording: false, speaking: false, startRecording: vi.fn(), stopRecording: vi.fn(), speak: vi.fn(), stopSpeaking: vi.fn() });
    const { container } = renderVoiceButton({ mode: 'bogus' });
    expect(container).toBeEmptyDOMElement();
  });
});
