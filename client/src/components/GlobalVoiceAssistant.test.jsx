import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The component reads `window.SpeechRecognition || window.webkitSpeechRecognition`
// at module-load time and renders null entirely when neither exists (real
// unsupported-browser behavior) -- so the "unsupported" case is tested
// first, before stubbing it in for the rest of the suite.
describe('GlobalVoiceAssistant (browser without SpeechRecognition support)', () => {
  it('renders nothing', async () => {
    vi.resetModules();
    const { default: GlobalVoiceAssistant } = await import('./GlobalVoiceAssistant.jsx');
    const { container } = render(<GlobalVoiceAssistant lang="tr" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('GlobalVoiceAssistant (with SpeechRecognition support)', () => {
  let GlobalVoiceAssistant;

  beforeEach(async () => {
    vi.resetModules();
    class FakeSpeechRecognition {
      start() {}
      abort() {}
    }
    vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition);
    ({ default: GlobalVoiceAssistant } = await import('./GlobalVoiceAssistant.jsx'));
  });

  it('starts off, showing the mic-off label and no status pill', () => {
    render(<GlobalVoiceAssistant lang="tr" />);
    expect(screen.getByText('Asistan Kapalı')).toBeInTheDocument();
    expect(screen.queryByText(/Dinliyor|Düşünüyor|Konuşuyor|Bekliyor/)).not.toBeInTheDocument();
  });

  it('turns on and shows the listening status pill', () => {
    render(<GlobalVoiceAssistant lang="tr" />);
    fireEvent.click(screen.getByText('Asistan Kapalı').closest('button'));
    expect(screen.getByText('Q · Asistan')).toBeInTheDocument();
  });

  it('turns back off and hides the status pill', () => {
    render(<GlobalVoiceAssistant lang="tr" />);
    const button = screen.getByText('Asistan Kapalı').closest('button');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByText('Asistan Kapalı')).toBeInTheDocument();
  });

  it('does not toggle when the click follows a drag beyond the movement threshold', () => {
    render(<GlobalVoiceAssistant lang="tr" />);
    const button = screen.getByText('Asistan Kapalı').closest('button');

    fireEvent.mouseDown(button, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 40 });
    fireEvent.mouseUp(window);
    fireEvent.click(button);

    expect(screen.getByText('Asistan Kapalı')).toBeInTheDocument();
  });
});
