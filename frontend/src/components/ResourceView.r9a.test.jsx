// Redesign R9a: ResourceView's states are a quiet loading line and a danger
// notice with a quiet retry. Behavior (the three states, the friendly message vs
// the opt-in detail, the working retry, content only once data exists) is pinned
// by ResourceView.test.jsx, which passes unmodified.
//
// It also guards the neighbour that R9a must NOT disturb: the product list keeps
// its own search-failure block (not a ResourceView), still styled by
// .resource-error in dashboard.css.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ResourceView from './ResourceView.jsx';
import ProductListPage from '../pages/ProductListPage.jsx';
import { AppProvider } from '../contexts/AppContext.jsx';
import { captureConsoleError } from '../../tests/helpers/captureConsoleError.js';

const resource = (over) => ({ status: 'success', data: 'DATA', error: null, isReloading: false, reload: vi.fn(), ...over });
const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';
function renderView(res, props = {}) {
  return render(
    <ResourceView resource={res} loadingMessage="Loading it" errorMessage="Couldn't load it." {...props}>
      {(data) => <p>content: {data}</p>}
    </ResourceView>
  );
}
const failed = (over) => resource({ status: 'error', data: undefined, error: new Error('db exploded'), ...over });

afterEach(() => vi.restoreAllMocks());

describe('loading is quiet text, not a box', () => {
  it('keeps its words and its status role, with a plain hook class and no notice', () => {
    renderView(resource({ status: 'loading', data: undefined }));
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('Loading it');
    expect(line.tagName).toBe('P');
    expect(line).toHaveClass('resource-view-loading');
    expect(line).not.toHaveClass('notice');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(line.querySelectorAll(INTERACTIVE)).toHaveLength(0);
  });
});

describe('a failed section is a danger notice with a quiet retry', () => {
  it('is the same alert, now a notice.notice--danger, and no longer the old .resource-error block', () => {
    renderView(failed());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger', 'resource-view-error');
    expect(alert).not.toHaveClass('resource-error');
    expect(alert.tagName).toBe('DIV');
    expect(alert).toHaveTextContent("Couldn't load it.");
    expect(alert).not.toHaveTextContent('db exploded');
  });

  it('Try again is the only control, quiet, and calls reload once', () => {
    const reload = vi.fn();
    renderView(failed({ reload }));
    const alert = screen.getByRole('alert');
    expect(alert.querySelectorAll(INTERACTIVE)).toHaveLength(1);
    const retry = within(alert).getByRole('button', { name: 'Try again' });
    expect(retry).toHaveClass('quiet-action');
    expect(retry).not.toHaveClass('primary-action');
    expect(retry).not.toHaveClass('danger-action');
    expect(retry).toHaveAttribute('type', 'button');
    fireEvent.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('with showDetail the underlying message is a second paragraph inside the same notice', () => {
    renderView(failed(), { showDetail: true });
    const alert = screen.getByRole('alert');
    expect([...alert.querySelectorAll('p')].map((p) => p.textContent)).toEqual(["Couldn't load it.", 'db exploded']);
    expect(alert).toHaveClass('notice--danger');
  });

  it('there is exactly one alert, and content is still withheld until data exists', () => {
    renderView(failed());
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText(/content:/)).not.toBeInTheDocument();
  });
});

describe('the product list keeps its own failure block, which R9a does not touch', () => {
  it('a failed search still renders .resource-error (not a ResourceView), so its stylesheet rule must stay', async () => {
    const consoleError = captureConsoleError('Product search failed.');
    const productService = {
      listProducts: vi.fn().mockResolvedValue([]),
      searchProducts: vi.fn().mockRejectedValue(new Error('index unavailable'))
    };
    const classificationRepository = { list: vi.fn().mockResolvedValue([]) };
    render(
      <AppProvider services={{ productService, classificationRepository }}>
        <MemoryRouter initialEntries={['/products?q=parle']}>
          <ProductListPage />
        </MemoryRouter>
      </AppProvider>
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('resource-error');
    expect(alert).not.toHaveClass('resource-view-error');
    expect(alert).not.toHaveClass('notice');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
