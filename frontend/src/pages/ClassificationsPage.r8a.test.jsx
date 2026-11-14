// Redesign R8a: the classifications page's tabs, rows, forms and messages.
// Action semantics (add, rename, archive, restore, remove, focus restoration)
// are pinned by ClassificationsPage.test.jsx, which passes unmodified. The
// removal panel itself is R8b and is not asserted here beyond opening.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../contexts/AppContext.jsx';
import ClassificationsPage from './ClassificationsPage.jsx';
import { CLASSIFICATION_TYPES, classificationPath } from '../components/classificationTypes.js';
import { captureConsoleError } from '../../tests/helpers/captureConsoleError.js';

const config = (type) => CLASSIFICATION_TYPES.find((c) => c.type === type);
const item = (over = {}) => ({ id: 'c1', name: 'Snacks', archived: false, isDefault: false, ...over });
const ok = (classification = item()) => ({ classification, errors: [] });
const INTERACTIVE = 'a, button, input, select, textarea, summary, [tabindex], [role="button"]';

function makeService(over = {}) {
  return {
    list: vi.fn().mockResolvedValue([item(), item({ id: 'c2', name: 'Cleaning' }), item({ id: 'c3', name: 'Old stock', archived: true })]),
    create: vi.fn().mockResolvedValue(ok()),
    rename: vi.fn().mockResolvedValue(ok()),
    archive: vi.fn().mockResolvedValue(ok()),
    restore: vi.fn().mockResolvedValue(ok()),
    previewRemoval: vi.fn().mockResolvedValue({ classification: item(), affectedCount: 0, affectedProducts: [], archivedAffectedCount: 0 }),
    removeWithFallback: vi.fn(),
    ...over
  };
}
function renderPage(type, service = makeService()) {
  render(
    <AppProvider services={{ classificationService: service }}>
      <MemoryRouter initialEntries={[classificationPath(config(type).slug)]}>
        <ClassificationsPage key={type} type={type} />
      </MemoryRouter>
    </AppProvider>
  );
  return service;
}
const activeRow = async (name) => (await screen.findByText(name, { selector: '.classifications__name' })).closest('li');

afterEach(() => vi.restoreAllMocks());

describe('tabs: the current type is identifiable in the markup and by its own styling hook', () => {
  it.each(CLASSIFICATION_TYPES.map((c) => [c.type, c.plural]))('on %s exactly one tab is current, and it is "%s"', (type, plural) => {
    renderPage(type);
    const nav = screen.getByRole('navigation', { name: 'Classification types' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(4);
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(plural);
    expect(nav.querySelector('ul')).toHaveClass('classifications__tabs');
  });

  it('every tab is a plain link, and none is nested in another control', () => {
    renderPage('category');
    const nav = screen.getByRole('navigation', { name: 'Classification types' });
    expect(nav.querySelectorAll(INTERACTIVE)).toHaveLength(4);
    for (const link of nav.querySelectorAll('a')) expect(link.querySelector(INTERACTIVE)).toBeNull();
  });
});

describe('rows: a name and a line of quiet actions', () => {
  it('an active row has its name and Rename, Archive and Remove as quiet buttons, none primary', async () => {
    renderPage('category');
    const row = await activeRow('Snacks');
    expect(row.parentElement).toHaveClass('classifications__list');
    const buttons = within(row).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Rename Snacks', 'Archive Snacks', 'Remove Snacks']);
    for (const button of buttons) {
      expect(button).toHaveClass('quiet-action');
      expect(button).not.toHaveClass('primary-action');
      expect(button).toHaveAttribute('type', 'button');
    }
    expect(row.querySelectorAll(INTERACTIVE)).toHaveLength(3);
  });

  it('Remove is a quiet action that opens the existing removal dialog; the confirmation, not the entry point, is the destructive step', async () => {
    renderPage('category');
    const row = await activeRow('Snacks');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Snacks' }));
    const dialog = await screen.findByRole('dialog');
    expect(row).toContainElement(dialog);
    expect(within(row).getByRole('button', { name: 'Remove Snacks' })).toHaveClass('quiet-action');
  });

  it('units can be renamed and archived but have no Remove', async () => {
    renderPage('unit', makeService({ list: vi.fn().mockResolvedValue([item({ id: 'u1', name: 'Kg' })]) }));
    const row = await activeRow('Kg');
    expect(within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Rename Kg', 'Archive Kg']);
  });

  it('an archived row keeps its name and a quiet Restore', async () => {
    renderPage('category');
    const section = await screen.findByRole('region', { name: 'Archived categories' });
    const row = within(section).getByText('Old stock').closest('li');
    expect(row.parentElement).toHaveClass('classifications__list');
    expect(within(row).getByRole('button', { name: 'Restore Old stock' })).toHaveClass('quiet-action');
  });

  // Each form has one primary action; the rows' own actions are all quiet.
  it('outside an edit form, Add is the only primary action on the page', async () => {
    renderPage('category');
    await activeRow('Snacks');
    expect(document.querySelectorAll('.primary-action')).toHaveLength(1);
    const add = screen.getByRole('button', { name: 'Add category' });
    expect(add).toHaveClass('primary-action');
    expect(add.closest('form')).not.toBeNull();
  });

  it('inside the rename form, Save is that form\'s primary action and Cancel is quiet; Add stays the page\'s', async () => {
    renderPage('category');
    const row = await activeRow('Snacks');
    fireEvent.click(within(row).getByRole('button', { name: 'Rename Snacks' }));
    expect(screen.getByLabelText('Name for Snacks')).toBeInTheDocument();
    const renameForm = row.querySelector('form');
    const save = within(renameForm).getByRole('button', { name: 'Save' });
    const cancel = within(renameForm).getByRole('button', { name: 'Cancel' });
    expect(save).toHaveClass('primary-action');
    expect(save).toHaveAttribute('type', 'submit');
    expect(cancel).toHaveClass('quiet-action');
    expect(cancel).not.toHaveClass('primary-action');
    // exactly one primary action per form, in two different forms
    expect(renameForm.querySelectorAll('.primary-action')).toHaveLength(1);
    const addForm = screen.getByRole('button', { name: 'Add category' }).closest('form');
    expect(addForm).not.toBe(renameForm);
    expect(addForm.querySelectorAll('.primary-action')).toHaveLength(1);
    expect(document.querySelectorAll('.primary-action')).toHaveLength(2);
    // none of the rows' own actions is ever primary
    for (const button of screen.getAllByRole('button', { name: /^(Rename|Archive|Remove) / })) {
      expect(button).not.toHaveClass('primary-action');
    }
  });

  it('closing the rename form takes its primary action away again', async () => {
    renderPage('category');
    const row = await activeRow('Snacks');
    fireEvent.click(within(row).getByRole('button', { name: 'Rename Snacks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(row.querySelector('form')).toBeNull());
    expect(document.querySelectorAll('.primary-action')).toHaveLength(1);
  });
});

describe('messages are the shared notices, in the same words', () => {
  it('a rejected add is a danger notice, still the alert the field is described by', async () => {
    renderPage('category', makeService({ create: vi.fn().mockResolvedValue({ classification: null, errors: ['Enter a name.'] }) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add category' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveAttribute('id', 'classification-add-error');
    expect(alert).toHaveTextContent('Enter a name.');
    const input = screen.getByLabelText('New category name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'classification-add-error');
  });

  it('a rejected rename is a danger notice described by the rename field', async () => {
    renderPage('category', makeService({ rename: vi.fn().mockResolvedValue({ classification: null, errors: ['That name is taken.'] }) }));
    const row = await activeRow('Snacks');
    fireEvent.click(within(row).getByRole('button', { name: 'Rename Snacks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveAttribute('id', 'rename-error-c1');
    expect(screen.getByLabelText('Name for Snacks')).toHaveAttribute('aria-describedby', 'rename-error-c1');
  });

  it('a failed action is a danger notice with the same generic message', async () => {
    const consoleError = captureConsoleError('Classification action failed:');
    renderPage('category', makeService({ archive: vi.fn().mockRejectedValue(new Error('boom')) }));
    const row = await activeRow('Snacks');
    fireEvent.click(within(row).getByRole('button', { name: 'Archive Snacks' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('notice', 'notice--danger');
    expect(alert).toHaveTextContent('Something went wrong. Please try again.');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['archive', 'Archive Snacks', 'Archived “Snacks”.'],
    ['restore', null, 'Restored “Old stock”.']
  ])('a successful %s is a neutral status notice with its existing wording', async (kind, name, text) => {
    renderPage('category');
    if (kind === 'archive') {
      fireEvent.click(within(await activeRow('Snacks')).getByRole('button', { name }));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Restore Old stock' }));
    }
    const status = await screen.findByRole('status');
    expect(status).toHaveClass('notice', 'notice--neutral');
    expect(status).toHaveTextContent(text);
    expect(status).not.toHaveClass('notice--danger');
  });

  it('a successful add says so in a neutral notice', async () => {
    renderPage('category');
    await activeRow('Snacks');
    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'Drinks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added “Drinks”.'));
    expect(screen.getByRole('status')).toHaveClass('notice--neutral');
  });
});
