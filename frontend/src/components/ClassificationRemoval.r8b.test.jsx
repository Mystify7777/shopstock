// Redesign R8b: the removal panel's classes and hierarchy, with the SAME states,
// words, focus and semantics as before. Behavior (preview, confirm, failures,
// Escape, focus) is pinned by ClassificationsPage.test.jsx, which passes
// unmodified. The last block is an integration test over REAL repositories and
// services on fake IndexedDB (never mocked), with the failures injected by
// wrapping a real dependency, so the panel is shown what a real partial
// failure produces.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import ClassificationRemoval from './ClassificationRemoval.jsx';
import { createDatabase } from '../data/db/schema.js';
import { createProductRepository } from '../data/repositories/productRepository.js';
import { createClassificationRepository } from '../data/repositories/classificationRepository.js';
import { createProductService } from '../services/productService.js';
import { createClassificationService } from '../services/classificationService.js';
import { captureConsoleError } from '../../tests/helpers/captureConsoleError.js';

const config = { type: 'category', singular: 'category' };
const cat = { id: 'c1', name: 'Snacks' };
const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';

const preview = (over = {}) => ({
  classification: cat,
  affectedCount: 3,
  affectedProducts: [
    { id: 'p1', name: 'Maggi' },
    { id: 'p2', name: 'Good Day' },
    { id: 'p3', name: 'Parle-G' }
  ],
  archivedAffectedCount: 0,
  ...over
});
function makeService(over = {}) {
  return {
    previewRemoval: vi.fn().mockResolvedValue(preview()),
    removeWithFallback: vi.fn().mockResolvedValue({ status: 'completed' }),
    ...over
  };
}
function renderPanel(service = makeService(), props = {}) {
  const handlers = { onCancel: vi.fn(), onRemoved: vi.fn() };
  render(<ClassificationRemoval config={config} classification={cat} service={service} {...handlers} {...props} />);
  return { service, ...handlers };
}
const dialog = () => screen.findByRole('dialog');
const confirm = (d) => within(d).getByRole('button', { name: /^(Remove category|Try again|Removing…)$/ });

afterEach(() => vi.restoreAllMocks());

describe('semantics are unchanged', () => {
  it('is an inline, non-modal dialog, labelled and described, never an alertdialog', async () => {
    renderPanel();
    const d = await dialog();
    expect(d).toHaveAttribute('role', 'dialog');
    expect(d).not.toHaveAttribute('aria-modal');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(d.getAttribute('aria-labelledby')).toBe('remove-c1-heading');
    expect(d.getAttribute('aria-describedby')).toBe('remove-c1-summary remove-c1-note');
    expect(document.getElementById('remove-c1-heading')).toHaveTextContent('Remove category “Snacks”?');
  });

  it('focus moves to Cancel, the safe choice, when it opens', async () => {
    renderPanel();
    const d = await dialog();
    await waitFor(() => expect(within(d).getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('Escape cancels while focus is inside it', async () => {
    const { onCancel } = renderPanel();
    const d = await dialog();
    fireEvent.keyDown(within(d).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('the buttons: a quiet Cancel and the one danger action', () => {
  it('Cancel is quiet and the confirm button is a danger action; neither is primary; they are the only controls besides the list', async () => {
    renderPanel();
    const d = await dialog();
    const cancel = within(d).getByRole('button', { name: 'Cancel' });
    const remove = within(d).getByRole('button', { name: 'Remove category' });
    expect(cancel).toHaveClass('quiet-action');
    expect(remove).toHaveClass('danger-action');
    expect(d.querySelectorAll('.primary-action')).toHaveLength(0);
    expect(d.querySelectorAll(INTERACTIVE)).toHaveLength(2);
    expect(cancel).toHaveAttribute('type', 'button');
    expect(remove).toHaveAttribute('type', 'button');
  });

  it('the danger action is the LAST control, so the safe choice comes first', async () => {
    renderPanel();
    const d = await dialog();
    const buttons = within(d).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Remove category']);
  });

  it('confirming runs the removal, disables both buttons while it runs, and reports completion once', async () => {
    let finish;
    const service = makeService({ removeWithFallback: vi.fn(() => new Promise((r) => { finish = r; })) });
    const { onRemoved } = renderPanel(service);
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Remove category' }));
    await waitFor(() => expect(within(d).getByRole('button', { name: 'Removing…' })).toBeDisabled());
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(d).getByRole('button', { name: 'Removing…' })).toHaveClass('danger-action');
    finish({ status: 'completed' });
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  });
});

describe('failures are the shared danger notice, in the same words', () => {
  const partial = {
    status: 'partial',
    affectedCount: 3,
    failures: [{ productId: 'p2', productName: 'Good Day', message: 'disk full' }]
  };

  async function failWith(result) {
    const consoleError = captureConsoleError('Classification removal did not finish:');
    renderPanel(makeService({ removeWithFallback: vi.fn().mockResolvedValue(result) }));
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Remove category' }));
    const alert = await within(d).findByRole('alert');
    expect(consoleError).toHaveBeenCalledTimes(1);
    return { d, alert };
  }

  it('a partial failure: a danger notice with the same sentences and the failed products listed', async () => {
    const { alert } = await failWith(partial);
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent(
      'Couldn’t update 1 of 3 products, so “Snacks” was not removed. Products that were already updated stay updated, and nothing was deleted.'
    );
    expect(within(alert).getByRole('listitem')).toHaveTextContent('Good Day: couldn’t be updated.');
    expect(alert).toHaveTextContent('Try again to finish, or Close to leave things as they are.');
  });

  it('an archive failure: a danger notice with its sentence', async () => {
    const { alert } = await failWith({ status: 'archive-failed', failures: [] });
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Every product was updated, but “Snacks” couldn’t be archived. Try again to finish.');
  });

  it('an unexpected failure: a danger notice with its sentence', async () => {
    const consoleError = captureConsoleError('Classification removal failed unexpectedly:');
    renderPanel(makeService({ removeWithFallback: vi.fn().mockRejectedValue(new Error('boom')) }));
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Remove category' }));
    const alert = await within(d).findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Something went wrong. Nothing more was changed. You can try again.');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('after a failure the buttons become Close (quiet, focused) and Try again (still the danger action)', async () => {
    const { d } = await failWith(partial);
    const close = within(d).getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('quiet-action');
    await waitFor(() => expect(close).toHaveFocus());
    const retry = within(d).getByRole('button', { name: 'Try again' });
    expect(retry).toHaveClass('danger-action');
    expect(retry).not.toBeDisabled();
  });

  it('every alert inside the dialog is a notice: no bare alert block is left', async () => {
    const { d } = await failWith(partial);
    for (const alert of d.querySelectorAll('[role="alert"]')) expect(alert).toHaveClass('notice', 'notice--danger');
    expect(d.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  });
});

describe('the states before there is a dialog', () => {
  it('while it checks, the loading line is the focus target, in the same words', async () => {
    renderPanel(makeService({ previewRemoval: vi.fn(() => new Promise(() => {})) }));
    const line = screen.getByText(/Checking which products use this category/);
    expect(line.tagName).toBe('P');
    expect(line).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(line).toHaveFocus());
  });

  it('if the check fails: a danger notice with two quiet actions (Try again, Cancel), the safe Cancel focused, and nothing destructive', async () => {
    renderPanel(makeService({ previewRemoval: vi.fn().mockRejectedValue(new Error('read failed')) }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Couldn’t check which products use this category. Nothing was changed.');
    const retry = within(alert).getByRole('button', { name: 'Try again' });
    // Re-checking is recovery, not removal: quiet, like cancelling. Never danger or primary.
    expect(retry).toHaveClass('quiet-action');
    expect(retry).not.toHaveClass('danger-action');
    expect(retry).not.toHaveClass('primary-action');
    const cancel = within(alert).getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveClass('quiet-action');
    expect(alert.querySelectorAll('button')).toHaveLength(2);
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(alert.querySelector('.danger-action')).toBeNull();
  });
});

describe('a REAL partial failure (real repositories and services on fake IndexedDB)', () => {
  let db;
  let classificationRepository;
  let productService;
  beforeEach(() => {
    db = createDatabase();
    const productRepository = createProductRepository(db);
    classificationRepository = createClassificationRepository(db);
    productService = createProductService(productRepository, classificationRepository);
  });
  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  async function seed() {
    const { classification } = await createClassificationService(classificationRepository, productService).create('category', 'Snacks');
    const products = [];
    for (const name of ['P1', 'P2', 'P3']) {
      products.push((await productService.createProduct({ name, categoryId: classification.id })).product);
    }
    return { classification, products };
  }
  const reload = (id) => productService.getProduct(id);

  it('shows what really happened, keeps the category active, and a retry then finishes it', async () => {
    const { classification, products } = await seed();
    const [p1, p2, p3] = products;
    let failing = true;
    const flakyProducts = {
      ...productService,
      updateProduct: async (existing, patch) => {
        if (failing && existing.id === p2.id) throw new Error('disk full');
        return productService.updateProduct(existing, patch);
      }
    };
    const service = createClassificationService(classificationRepository, flakyProducts);
    const consoleError = captureConsoleError('Classification removal did not finish:');
    const { onRemoved } = renderPanel(service, { classification });

    const d = await dialog();
    expect(within(d).getAllByRole('listitem').map((li) => li.textContent).sort()).toEqual(['P1', 'P2', 'P3']);
    fireEvent.click(within(d).getByRole('button', { name: 'Remove category' }));

    const alert = await within(d).findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Couldn’t update 1 of 3 products, so “Snacks” was not removed.');
    expect(within(alert).getByRole('listitem')).toHaveTextContent('P2: couldn’t be updated.');
    expect(onRemoved).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    // what the database really holds: not atomic, and honest about it
    expect((await classificationRepository.getById('category', classification.id)).archived).toBe(false);
    expect((await reload(p1.id)).categoryId).toBeNull();
    expect((await reload(p2.id)).categoryId).toBe(classification.id);
    expect((await reload(p3.id)).categoryId).toBeNull();

    failing = false;
    fireEvent.click(within(d).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect((await classificationRepository.getById('category', classification.id)).archived).toBe(true);
    expect((await reload(p2.id)).categoryId).toBeNull();
  });

  it('shows an archive-only failure when every product was updated but the archive write fails', async () => {
    const { classification, products } = await seed();
    let failNext = true;
    const flakyRepository = {
      ...classificationRepository,
      update: async (type, record) => {
        if (failNext) {
          failNext = false;
          throw new Error('storage unavailable');
        }
        return classificationRepository.update(type, record);
      }
    };
    const service = createClassificationService(flakyRepository, productService);
    const consoleError = captureConsoleError('Classification removal did not finish:');
    const { onRemoved } = renderPanel(service, { classification });

    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Remove category' }));
    const alert = await within(d).findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Every product was updated, but “Snacks” couldn’t be archived. Try again to finish.');
    expect(consoleError).toHaveBeenCalledTimes(1);
    for (const p of products) expect((await reload(p.id)).categoryId).toBeNull();
    expect((await classificationRepository.getById('category', classification.id)).archived).toBe(false);

    fireEvent.click(within(d).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect((await classificationRepository.getById('category', classification.id)).archived).toBe(true);
  });
});
