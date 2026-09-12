import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import QuantumLogo from './QuantumLogo.jsx';

describe('QuantumLogo', () => {
  it('renders the BQI brand image', () => {
    const { getByAltText } = render(<QuantumLogo />);
    expect(getByAltText('BQI')).toBeInTheDocument();
  });

  it('scales up for size="lg"', () => {
    const { container } = render(<QuantumLogo size="lg" />);
    expect(container.firstChild.style.width).toBe('112px');
  });

  it('scales down for size="sm"', () => {
    const { container } = render(<QuantumLogo size="sm" />);
    expect(container.firstChild.style.width).toBe('40px');
  });

  it('defaults to the medium size', () => {
    const { container } = render(<QuantumLogo />);
    expect(container.firstChild.style.width).toBe('52px');
  });
});
