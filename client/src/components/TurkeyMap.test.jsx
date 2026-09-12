import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TurkeyMap from './TurkeyMap.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { api } from '../services/api.js';

// WorldGlobe pulls in three.js/@react-three -- stub it with a lightweight
// component that just exposes a way to trigger onSelectCity, since TurkeyMap's
// own logic (the region-emergency modal) is what's under test here, not the
// 3D rendering itself (see WorldGlobe.test.jsx for that).
vi.mock('./WorldGlobe.jsx', () => ({
  default: ({ cities, onSelectCity }) => (
    <div>
      {cities.map((c) => (
        <button key={c.id} onClick={() => onSelectCity(c)}>{c.name}</button>
      ))}
    </div>
  ),
}));

vi.mock('../services/api.js', () => ({ api: { emergencyRegion: vi.fn(async () => ({ success: true })) } }));

function renderMap() {
  return render(<LangProvider><TurkeyMap /></LangProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TurkeyMap', () => {
  it('opens the region-emergency modal when a city is selected', async () => {
    renderMap();
    fireEvent.click(await screen.findByText('Ankara'));
    expect(screen.getByText('ANKARA')).toBeInTheDocument();
  });

  it('closes the modal via the close button', async () => {
    renderMap();
    fireEvent.click(await screen.findByText('İzmir'));
    fireEvent.click(screen.getByLabelText('Kapat'));
    expect(screen.queryByText('İZMİR')).not.toBeInTheDocument();
  });

  it('sends the regional alert with the city name and message, then closes', async () => {
    renderMap();
    fireEvent.click(await screen.findByText('Trabzon'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'acil durum bildirimi' } });
    fireEvent.click(screen.getByRole('button', { name: /gönder|sending/i }));

    await waitFor(() => expect(api.emergencyRegion).toHaveBeenCalledWith('Trabzon', 'acil durum bildirimi'));
    await waitFor(() => expect(screen.queryByText('TRABZON')).not.toBeInTheDocument());
  });

  it('disables the send button while the message is empty', async () => {
    renderMap();
    fireEvent.click(await screen.findByText('Antalya'));
    expect(screen.getByRole('button', { name: /gönder|sending/i })).toBeDisabled();
  });
});
