// Redesign R5: the filter disclosure, the removable chips and the focus rules on
// the Product List. Search and filter SEMANTICS are pinned by
// ProductListPage.test.jsx (unchanged apart from opening the disclosure in one
// test); these tests cover only what R5 added around them.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductListPage from './ProductListPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';

const OPTIONS = {
  category: [
    { id: 'cat1', name: 'Snacks' },
    { id: 'cat2', name: 'Cleaning' }
  ],
  location: [
    { id: 'loc1', name: 'Counter' },
    { id: 'loc2', name: 'Back Room' }
  ],
  tag: [{ id: 'tag1', name: 'popular' }]
};

const prod = (id, name, quantity = 50) => ({
  id,
  name,
  quantity,
  lowStockThreshold: null,
  lowStockDisabled: false,
  archived: false
});

function renderPage({ url = '/products', options = OPTIONS, products = [prod('1', 'Parle-G')], searchProducts } = {}) {
  const productService = {
    listProducts: vi.fn().mockResolvedValue(products),
    searchProducts:
      searchProducts ?? vi.fn().mockResolvedValue({ matches: products, related: [], hasExactMatch: false })
  };
  const classificationRepository = { list: vi.fn(async (type) => options[type] ?? []) };
  const view = render(
    <AppProvider services={{ productService, classificationRepository }}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/products" element={<ProductListPage />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
  return { productService, ...view };
}

const toggle = () => screen.findByRole('button', { name: /^Filters/ });
const panel = () => document.getElementById('product-filters-panel');
const chip = (name) => screen.queryByRole('button', { name: `Remove filter: ${name}` });
const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';

afterEach(() => vi.restoreAllMocks());

describe('search (R5 presentation)', () => {
  it('is a labelled field that comes before the filters and the results', async () => {
    renderPage();
    const search = screen.getByLabelText('Search');
    expect(search).toHaveAttribute('type', 'text');
    expect(search).toHaveAttribute('placeholder', 'Search products…');
    const filters = await toggle();
    await screen.findByText('Parle-G');
    expect(search.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filters.compareDocumentPosition(screen.getByRole('listitem')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('its label stays in the DOM as the accessible name, only visually hidden', () => {
    renderPage();
    expect(screen.getByText('Search', { selector: 'label' })).toHaveClass('visually-hidden');
  });
});

describe('filter disclosure', () => {
  it('starts collapsed: the toggle says so and the controlled region is hidden', async () => {
    renderPage();
    const button = await toggle();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'product-filters-panel');
    expect(panel()).not.toBeNull();
    expect(panel()).toHaveAttribute('hidden');
    expect(screen.queryByRole('combobox', { name: 'Category' })).not.toBeInTheDocument();
  });

  it('aria-controls points at the region that holds the real controls, which keep mounted', async () => {
    renderPage();
    const button = await toggle();
    const region = document.getElementById(button.getAttribute('aria-controls'));
    expect(within(region).getByLabelText('Category')).toBeInTheDocument();
    expect(within(region).getByRole('group', { name: 'Locations', hidden: true })).toBeInTheDocument();
    expect(within(region).getByRole('group', { name: 'Tags', hidden: true })).toBeInTheDocument();
  });

  it('opens and closes with the button, flipping aria-expanded and the hidden attribute', async () => {
    renderPage();
    const button = await toggle();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(panel()).not.toHaveAttribute('hidden');
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toHaveAttribute('hidden');
  });

  it('keeps focus on the button when it opens and closes', async () => {
    renderPage();
    const button = await toggle();
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
  });

  it('Escape inside the open panel closes it and returns focus to the button', async () => {
    renderPage();
    const button = await toggle();
    fireEvent.click(button);
    const select = screen.getByRole('combobox', { name: 'Category' });
    select.focus();
    fireEvent.keyDown(select, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('collapsing never discards a selection: the chosen filter stays active and searched', async () => {
    const { productService } = renderPage();
    const button = await toggle();
    fireEvent.click(button);
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'cat1' } });
    fireEvent.click(button);
    expect(chip('Snacks')).toBeInTheDocument();
    await waitFor(() =>
      expect(productService.searchProducts).toHaveBeenLastCalledWith('', expect.objectContaining({ categoryId: 'cat1' }))
    );
    fireEvent.click(button);
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('cat1');
  });

  it('is absent when there are no filter options and no active filter', async () => {
    renderPage({ options: {} });
    await screen.findByText('Parle-G');
    expect(screen.queryByRole('button', { name: /^Filters/ })).not.toBeInTheDocument();
  });
});

describe('filter area order', () => {
  it('reads: Filters toggle, then the active chips, then the (collapsible) panel, then the results', async () => {
    renderPage({ url: '/products?stockStatus=low' });
    const button = await toggle();
    const removeLow = await screen.findByRole('button', { name: 'Remove filter: Low stock' });
    const follows = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(button, removeLow)).toBe(true);
    expect(follows(removeLow, panel())).toBe(true);
    await screen.findByText('Parle-G');
    expect(follows(panel(), screen.getByRole('listitem'))).toBe(true);
  });
});

describe('active filter count and chips', () => {
  it('shows no count and no chips when nothing is active', async () => {
    renderPage();
    const button = await toggle();
    expect(button).toHaveAccessibleName('Filters');
    expect(document.querySelector('.filters-toggle__count')).toBeNull();
    expect(document.querySelector('.filter-chip')).toBeNull();
  });

  it('counts every active filter and names the count for assistive technology', async () => {
    renderPage({ url: '/products?stockStatus=low' });
    const button = await toggle();
    expect(button).toHaveAccessibleName('Filters, 1 active');
    fireEvent.click(button);
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'cat1' } });
    fireEvent.click(screen.getByLabelText('Counter'));
    fireEvent.click(screen.getByLabelText('popular'));
    expect(await screen.findByRole('button', { name: /^Filters/ })).toHaveAccessibleName('Filters, 4 active');
    expect(document.querySelector('.filters-toggle__count')).toHaveTextContent('4');
    expect(document.querySelector('.filters-toggle__count')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders one removable chip per active filter, in the order category, locations, tags, stock status', async () => {
    renderPage({ url: '/products?stockStatus=out' });
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByLabelText('popular'));
    fireEvent.click(screen.getByLabelText('Back Room'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'cat2' } });
    await screen.findByRole('button', { name: 'Remove filter: Cleaning' });
    const labels = [...document.querySelectorAll('.filter-chip')].map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Remove filter: Cleaning',
      'Remove filter: Back Room',
      'Remove filter: popular',
      'Remove filter: Out of stock'
    ]);
  });

  it('each chip is a single plain button (no nested controls) with its own accessible removal name', async () => {
    renderPage({ url: '/products?stockStatus=low' });
    const remove = await screen.findByRole('button', { name: 'Remove filter: Low stock' });
    expect(remove.tagName).toBe('BUTTON');
    expect(remove.querySelectorAll(INTERACTIVE)).toHaveLength(0);
    expect(remove.querySelector('[aria-hidden="true"]')).toHaveTextContent('×');
  });

  it('chips are not list items, so product rows stay the only list items on the page', async () => {
    renderPage({ url: '/products?stockStatus=low' });
    await screen.findByRole('button', { name: 'Remove filter: Low stock' });
    expect(document.querySelector('.product-list__chips')?.querySelector('li')).toBeNull();
  });

  it('removing a chip removes exactly that filter from the real state and re-runs the search', async () => {
    const { productService } = renderPage();
    fireEvent.click(await toggle());
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'cat1' } });
    fireEvent.click(screen.getByLabelText('Counter'));
    fireEvent.click(screen.getByLabelText('Back Room'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove filter: Counter' }));

    expect(screen.getByLabelText('Counter')).not.toBeChecked();
    expect(screen.getByLabelText('Back Room')).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('cat1');
    await waitFor(() =>
      expect(productService.searchProducts).toHaveBeenLastCalledWith(
        '',
        expect.objectContaining({ categoryId: 'cat1', locationIds: ['loc2'] })
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Snacks' }));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('');
  });

  it('removing the URL-seeded stock-status chip clears it (it has no other control)', async () => {
    renderPage({ url: '/products?stockStatus=low' });
    expect(await screen.findByText('Showing low stock products only.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Low stock' }));
    expect(screen.queryByText('Showing low stock products only.')).not.toBeInTheDocument();
    expect(chip('Low stock')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Filters.*active/ })).not.toBeInTheDocument());
  });

  it('Clear filters removes every filter and every chip, with its existing name', async () => {
    renderPage({ url: '/products?stockStatus=out' });
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByLabelText('Counter'));
    await screen.findByRole('button', { name: 'Remove filter: Counter' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(document.querySelector('.filter-chip')).toBeNull();
    expect(screen.getByLabelText('Counter')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });
});

describe('focus after a control disappears', () => {
  it('removing a chip moves focus to the next chip', async () => {
    renderPage();
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByLabelText('Counter'));
    fireEvent.click(screen.getByLabelText('Back Room'));
    fireEvent.click(screen.getByLabelText('popular'));
    const first = await screen.findByRole('button', { name: 'Remove filter: Counter' });
    first.focus();
    fireEvent.click(first);
    await waitFor(() => expect(chip('Back Room')).toHaveFocus());
  });

  it('removing the last chip moves focus to the previous one, and the only chip to the Filters button', async () => {
    renderPage();
    fireEvent.click(await toggle());
    fireEvent.click(screen.getByLabelText('Counter'));
    fireEvent.click(screen.getByLabelText('popular'));
    const last = await screen.findByRole('button', { name: 'Remove filter: popular' });
    fireEvent.click(last);
    await waitFor(() => expect(chip('Counter')).toHaveFocus());
    fireEvent.click(chip('Counter'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus());
  });

  it('Clear filters returns focus to the Filters button instead of losing it', async () => {
    renderPage({ url: '/products?stockStatus=low' });
    const clear = await screen.findByRole('button', { name: 'Clear filters' });
    clear.focus();
    fireEvent.click(clear);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus());
  });
});

describe('product rows on the list', () => {
  it('are the shared ProductRow: one link each, no nested controls, no duplicate badge or quantity markup', async () => {
    renderPage({ products: [prod('1', 'Dettol', 0), prod('2', 'Parle-G', 3), prod('3', 'Good Day', 40)] });
    await screen.findByText('Dettol');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelectorAll(INTERACTIVE)).toHaveLength(1);
      expect(row.querySelector('a')).toHaveClass('product-row__link');
      expect(row.querySelectorAll('.product-row__quantity')).toHaveLength(1);
      expect(row.querySelectorAll('.badge')).toHaveLength(1);
    }
    expect(document.querySelectorAll('.product-list__results .badge')).toHaveLength(3);
  });
});
