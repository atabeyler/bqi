import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AppFooter from './AppFooter.jsx';
import { LangProvider } from '../services/langContext.jsx';

describe('AppFooter', () => {
  it('renders the project code', () => {
    const { getByText } = render(<LangProvider><AppFooter /></LangProvider>);
    expect(getByText(/QTR-200120401018/)).toBeInTheDocument();
  });

  it('applies fixed positioning classes when fixed=true', () => {
    const { container } = render(<LangProvider><AppFooter fixed /></LangProvider>);
    expect(container.querySelector('footer').className).toContain('fixed');
  });

  it('uses relative positioning by default', () => {
    const { container } = render(<LangProvider><AppFooter /></LangProvider>);
    expect(container.querySelector('footer').className).toContain('relative');
  });
});
