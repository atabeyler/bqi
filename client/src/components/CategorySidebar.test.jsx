import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CategorySidebar, { CATEGORIES } from './CategorySidebar.jsx';
import { LangProvider } from '../services/langContext.jsx';

function renderSidebar(props = {}) {
  return render(
    <LangProvider>
      <CategorySidebar activeCategory={null} onSelect={() => {}} onHome={() => {}} {...props} />
    </LangProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('CategorySidebar', () => {
  it('renders every category from CATEGORIES', () => {
    renderSidebar();
    for (const cat of CATEGORIES) {
      // Several categories share the same status label (e.g. "Kritik",
      // "Kuantum"), so match on the category's own name instead, which is
      // unique per row.
      expect(screen.getAllByText(cat.desc.tr).length).toBeGreaterThan(0);
    }
  });

  it('calls onSelect with the category id when a category is clicked', () => {
    const onSelect = vi.fn();
    renderSidebar({ onSelect });
    // BDDK's status label ("Kuantum") is unique enough to locate its row button.
    const bddkStatus = screen.getAllByText('Kuantum')[0];
    fireEvent.click(bddkStatus.closest('button'));
    expect(onSelect).toHaveBeenCalledWith('bddk');
  });

  it('calls onSelect(null) for "new analysis" and onHome for the home button', () => {
    const onSelect = vi.fn();
    const onHome = vi.fn();
    renderSidebar({ onSelect, onHome });
    // Exact (not case-insensitive) match: the source strings contain the
    // Turkish dotted İ, whose lowercase form isn't a plain ASCII "i" --
    // a case-insensitive regex would otherwise silently fail to match.
    fireEvent.click(screen.getByText('YENİ ANALİZ BAŞLAT').closest('button'));
    expect(onSelect).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByText('Ana Ekran').closest('button'));
    expect(onHome).toHaveBeenCalled();
  });

  it('does not render a collapse toggle when onToggleCollapse is not provided', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: /daralt|collapse|genişlet|expand/i })).not.toBeInTheDocument();
  });

  it('renders a collapse toggle and calls it when provided', () => {
    const onToggleCollapse = vi.fn();
    renderSidebar({ onToggleCollapse, collapsed: false });
    const toggle = screen.getAllByRole('button')[0];
    fireEvent.click(toggle);
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it('hides category text labels when collapsed', () => {
    const { container } = renderSidebar({ collapsed: true, onToggleCollapse: () => {} });
    // Category descriptions live in a container with the "hidden" class when collapsed.
    expect(container.querySelector('.hidden')).toBeTruthy();
  });
});
