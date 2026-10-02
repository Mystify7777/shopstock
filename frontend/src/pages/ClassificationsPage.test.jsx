import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../contexts/AppContext.jsx';
import ClassificationsPage from './ClassificationsPage.jsx';
import { CLASSIFICATION_TYPES, classificationPath } from '../components/classificationTypes.js';
import { createDatabase } from '../data/db/schema.js';
import { createProductRepository } from '../data/repositories/productRepository.js';
import { createClassificationRepository } from '../data/repositories/classificationRepository.js';
import { createProductService } from '../services/productService.js';
import { createClassificationService } from '../services/classificationService.js';

// Page behavior is tested against a STUBBED classificationService (precise
// control of every success/failure branch). The service's own behavior has
// its own real-Dexie tests; the last describe block here drives the real
// service through the UI end to end.

const config = (type) => CLASSIFICATION_TYPES.find((c) => c.type === type);

function item(overrides = {}) {
  return { id: 'c1', name: 'Snacks', archived: false, isDefault: false, ...overrides };
}

const ok = (classification = item()) => ({ classification, errors: [] });

function makeService(overrides = {}) {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(ok()),
    rename: vi.fn().mockResolvedValue(ok()),
    archive: vi.fn().mockResolvedValue(ok()),
    restore: vi.fn().mockResolvedValue(ok()),
    previewRemoval: vi.fn().mockResolvedValue({
      classification: item(),
      affectedCount: 0,
      affectedProducts: [],
      archivedAffectedCount: 0
    }),
    removeWithFallback: vi.fn().mockResolvedValue({
      status: 'completed',
      affectedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      failures: [],
      archiveError: null,
      retryable: false
    }),
    ...overrides
  };
}

function renderPage(type, service) {
  return render(
    <AppProvider services={{ classificationService: service }}>
      <MemoryRouter initialEntries={[classificationPath(config(type).slug)]}>
        <ClassificationsPage key={type} type={type} />
      </MemoryRouter>
    </AppProvider>
  );
}

const product = (overrides = {}) => ({ id: `p-${Math.random()}`, name: 'Product', archived: false, ...overrides });

describe('ClassificationsPage', () => {
  describe('navigation between types', () => {
    it('links to all four types and marks the current one', () => {
      renderPage('tag', makeService());
      const nav = screen.getByRole('navigation', { name: 'Classification types' });
      expect(within(nav).getAllByRole('link').map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
        ['Categories', '/classifications/categories'],
        ['Locations', '/classifications/locations'],
        ['Tags', '/classifications/tags'],
        ['Units', '/classifications/units']
      ]);
      expect(within(nav).getByRole('link', { name: 'Tags' })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: 'Categories' })).not.toHaveAttribute('aria-current');
    });
  });

  describe.each(CLASSIFICATION_TYPES)('$plural', ({ type, singular, plural, removable }) => {
    const lower = plural.toLowerCase();

    it('loads the list for its own type, including archived records', async () => {
      const service = makeService();
      renderPage(type, service);
      await screen.findByText(`No ${lower} yet. Add one above.`);
      expect(service.list).toHaveBeenCalledWith(type, { includeArchived: true });
    });

    it('shows a loading state', () => {
      renderPage(type, makeService({ list: vi.fn(() => new Promise(() => {})) }));
      expect(screen.getByRole('status')).toHaveTextContent(`Loading ${lower}`);
    });

    it('shows an empty state with an add form', async () => {
      renderPage(type, makeService());
      expect(await screen.findByText(`No ${lower} yet. Add one above.`)).toBeInTheDocument();
      expect(screen.getByLabelText(`New ${singular} name`)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Add ${singular}` })).toBeInTheDocument();
    });

    it('shows an error with a working retry', async () => {
      const list = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce([item({ name: 'Back' })]);
      renderPage(type, makeService({ list }));
      expect(await screen.findByRole('alert')).toHaveTextContent(`Couldn't load your ${lower}.`);
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Back')).toBeInTheDocument();
    });

    it('lists active items under the heading and archived ones separately with Restore', async () => {
      const service = makeService({
        list: vi.fn().mockResolvedValue([
          item({ id: 'a', name: 'Active One' }),
          item({ id: 'b', name: 'Old One', archived: true })
        ])
      });
      renderPage(type, service);

      const active = await screen.findByRole('region', { name: plural });
      expect(within(active).getByText('Active One')).toBeInTheDocument();
      expect(within(active).queryByText('Old One')).not.toBeInTheDocument();

      const archived = screen.getByRole('region', { name: `Archived ${lower}` });
      expect(within(archived).getByText('Old One')).toBeInTheDocument();
      expect(within(archived).getByRole('button', { name: 'Restore Old One' })).toBeInTheDocument();
    });

    it('omits the archived section when nothing is archived', async () => {
      renderPage(type, makeService({ list: vi.fn().mockResolvedValue([item()]) }));
      await screen.findByText('Snacks');
      expect(screen.queryByRole('region', { name: `Archived ${lower}` })).not.toBeInTheDocument();
    });

    it(removable ? 'offers Remove' : 'does NOT offer Remove (no unit removal semantics)', async () => {
      renderPage(type, makeService({ list: vi.fn().mockResolvedValue([item()]) }));
      await screen.findByText('Snacks');
      const button = screen.queryByRole('button', { name: 'Remove Snacks' });
      if (removable) expect(button).toBeInTheDocument();
      else {
        expect(button).not.toBeInTheDocument();
        expect(screen.getByText(/Units cannot be removed/)).toBeInTheDocument();
      }
    });

    describe('add', () => {
      it('creates, clears the box, confirms, and refreshes the list', async () => {
        const service = makeService();
        renderPage(type, service);
        await screen.findByText(`No ${lower} yet. Add one above.`);

        fireEvent.change(screen.getByLabelText(`New ${singular} name`), { target: { value: '  Snacks ' } });
        fireEvent.click(screen.getByRole('button', { name: `Add ${singular}` }));

        await waitFor(() => expect(service.create).toHaveBeenCalledWith(type, '  Snacks '));
        expect(await screen.findByText('Added “Snacks”.')).toBeInTheDocument();
        expect(screen.getByLabelText(`New ${singular} name`)).toHaveValue('');
        await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
      });

      it('shows the service validation message and keeps what was typed', async () => {
        const service = makeService({
          create: vi.fn().mockResolvedValue({ classification: null, errors: ['Name is required.'] })
        });
        renderPage(type, service);
        await screen.findByText(`No ${lower} yet. Add one above.`);

        fireEvent.change(screen.getByLabelText(`New ${singular} name`), { target: { value: '   ' } });
        fireEvent.click(screen.getByRole('button', { name: `Add ${singular}` }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Name is required.');
        expect(screen.getByLabelText(`New ${singular} name`)).toHaveAttribute('aria-invalid', 'true');
        expect(service.list).toHaveBeenCalledTimes(1); // nothing changed, nothing reloaded
      });

      it('reports an unexpected failure plainly (and logs it)', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const service = makeService({ create: vi.fn().mockRejectedValue(new Error('disk')) });
        renderPage(type, service);
        await screen.findByText(`No ${lower} yet. Add one above.`);

        fireEvent.change(screen.getByLabelText(`New ${singular} name`), { target: { value: 'X' } });
        fireEvent.click(screen.getByRole('button', { name: `Add ${singular}` }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
      });
    });

    describe('rename', () => {
      async function openRename(service) {
        renderPage(type, service);
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Snacks' }));
      }

      it('edits in place, saves, confirms, and refreshes', async () => {
        const service = makeService({ list: vi.fn().mockResolvedValue([item()]) });
        await openRename(service);

        const box = screen.getByLabelText('Name for Snacks');
        expect(box).toHaveValue('Snacks');
        fireEvent.change(box, { target: { value: ' Treats ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(service.rename).toHaveBeenCalledWith(type, 'c1', ' Treats '));
        expect(await screen.findByText('Renamed to “Treats”.')).toBeInTheDocument();
        expect(screen.queryByLabelText('Name for Snacks')).not.toBeInTheDocument();
        await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
      });

      it('Cancel leaves everything unchanged', async () => {
        const service = makeService({ list: vi.fn().mockResolvedValue([item()]) });
        await openRename(service);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByLabelText('Name for Snacks')).not.toBeInTheDocument();
        expect(service.rename).not.toHaveBeenCalled();
        expect(screen.getByText('Snacks')).toBeInTheDocument();
      });

      it('shows a validation message and stays in edit mode', async () => {
        const service = makeService({
          list: vi.fn().mockResolvedValue([item()]),
          rename: vi.fn().mockResolvedValue({ classification: null, errors: ['Name is required.'] })
        });
        await openRename(service);
        fireEvent.change(screen.getByLabelText('Name for Snacks'), { target: { value: ' ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Name is required.');
        expect(screen.getByLabelText('Name for Snacks')).toBeInTheDocument();
      });
    });

    describe('archive and restore', () => {
      it('archives without any confirmation and refreshes', async () => {
        const service = makeService({ list: vi.fn().mockResolvedValue([item()]) });
        renderPage(type, service);
        fireEvent.click(await screen.findByRole('button', { name: 'Archive Snacks' }));

        await waitFor(() => expect(service.archive).toHaveBeenCalledWith(type, 'c1'));
        expect(await screen.findByText('Archived “Snacks”.')).toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
      });

      it('restores an archived item and refreshes', async () => {
        const service = makeService({ list: vi.fn().mockResolvedValue([item({ archived: true })]) });
        renderPage(type, service);
        fireEvent.click(await screen.findByRole('button', { name: 'Restore Snacks' }));

        await waitFor(() => expect(service.restore).toHaveBeenCalledWith(type, 'c1'));
        expect(await screen.findByText('Restored “Snacks”.')).toBeInTheDocument();
        await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
      });

      it('shows a failure message if archiving fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const service = makeService({
          list: vi.fn().mockResolvedValue([item()]),
          archive: vi.fn().mockRejectedValue(new Error('x'))
        });
        renderPage(type, service);
        fireEvent.click(await screen.findByRole('button', { name: 'Archive Snacks' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
        consoleError.mockRestore();
      });
    });
  });

  describe.each(CLASSIFICATION_TYPES.filter((c) => c.removable))('removal of a $singular', ({ type, singular }) => {
    const consequence = {
      category: 'They will become Uncategorized.',
      location: 'This location will be taken off them. Any other locations they have stay.',
      tag: 'This tag will be taken off them.'
    }[type];

    function serviceWithPreview(preview, extra = {}) {
      return makeService({
        list: vi.fn().mockResolvedValue([item()]),
        previewRemoval: vi.fn().mockResolvedValue({ classification: item(), ...preview }),
        ...extra
      });
    }

    async function openRemoval(service) {
      renderPage(type, service);
      fireEvent.click(await screen.findByRole('button', { name: 'Remove Snacks' }));
      return screen.findByRole('alertdialog');
    }

    it('shows the affected count, who is affected, the consequence, and that nothing is deleted', async () => {
      const service = serviceWithPreview({
        affectedCount: 3,
        affectedProducts: [product({ name: 'Parle-G' }), product({ name: 'Good Day' }), product({ name: 'Old Thing', archived: true })],
        archivedAffectedCount: 1
      });
      const dialog = await openRemoval(service);

      expect(service.previewRemoval).toHaveBeenCalledWith(type, 'c1');
      expect(within(dialog).getByRole('heading', { name: `Remove ${singular} “Snacks”?` })).toBeInTheDocument();
      expect(within(dialog).getByText(`3 products use this ${singular} (1 archived).`)).toBeInTheDocument();
      expect(within(dialog).getByText(consequence)).toBeInTheDocument();
      for (const name of ['Parle-G', 'Good Day', 'Old Thing']) {
        expect(within(dialog).getByText(name)).toBeInTheDocument();
      }
      expect(within(dialog).getByText(/No products will be deleted/)).toBeInTheDocument();
      expect(within(dialog).getByText(new RegExp(`${singular} itself will be archived`))).toBeInTheDocument();
      // nothing happens until confirmed
      expect(service.removeWithFallback).not.toHaveBeenCalled();
    });

    it('uses singular wording for exactly one affected product', async () => {
      const dialog = await openRemoval(serviceWithPreview({ affectedCount: 1, affectedProducts: [product()], archivedAffectedCount: 0 }));
      expect(within(dialog).getByText(`1 product uses this ${singular}.`)).toBeInTheDocument();
    });

    it('says so, with no consequence list, when no product uses it', async () => {
      const dialog = await openRemoval(serviceWithPreview({ affectedCount: 0, affectedProducts: [], archivedAffectedCount: 0 }));
      expect(within(dialog).getByText(`No products use this ${singular}.`)).toBeInTheDocument();
      expect(within(dialog).queryByText(consequence)).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('list')).not.toBeInTheDocument();
    });

    it('lists at most ten products and counts the rest', async () => {
      const many = Array.from({ length: 12 }, (_, i) => product({ name: `Item ${i}` }));
      const dialog = await openRemoval(serviceWithPreview({ affectedCount: 12, affectedProducts: many, archivedAffectedCount: 0 }));
      expect(within(dialog).getAllByRole('listitem')).toHaveLength(10);
      expect(within(dialog).getByText('and 2 more.')).toBeInTheDocument();
    });

    it('Cancel closes the dialog and changes nothing', async () => {
      const service = serviceWithPreview({ affectedCount: 2, affectedProducts: [product(), product()], archivedAffectedCount: 0 });
      const dialog = await openRemoval(service);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(service.removeWithFallback).not.toHaveBeenCalled();
      expect(service.list).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Snacks')).toBeInTheDocument();
    });

    it('confirming removes, closes the dialog, reports how many products were updated, and refreshes', async () => {
      const service = serviceWithPreview(
        { affectedCount: 3, affectedProducts: [product(), product(), product()], archivedAffectedCount: 0 },
        {
          removeWithFallback: vi.fn().mockResolvedValue({
            status: 'completed',
            affectedCount: 3,
            updatedCount: 3,
            skippedCount: 0,
            failures: [],
            archiveError: null,
            retryable: false
          })
        }
      );
      const dialog = await openRemoval(service);
      fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${singular}` }));

      await waitFor(() => expect(service.removeWithFallback).toHaveBeenCalledWith(type, 'c1'));
      expect(await screen.findByText('Removed “Snacks”. 3 products were updated.')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
    });

    it('disables both buttons while removing', async () => {
      let finish;
      const service = serviceWithPreview(
        { affectedCount: 1, affectedProducts: [product()], archivedAffectedCount: 0 },
        { removeWithFallback: vi.fn(() => new Promise((resolve) => (finish = resolve))) }
      );
      const dialog = await openRemoval(service);
      fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${singular}` }));

      const busy = await within(dialog).findByRole('button', { name: 'Removing…' });
      expect(busy).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      finish({ status: 'completed', affectedCount: 1, updatedCount: 1, skippedCount: 0, failures: [], archiveError: null, retryable: false });
    });

    describe('partial failure and retry', () => {
      const partial = {
        status: 'partial',
        affectedCount: 3,
        updatedCount: 2,
        skippedCount: 0,
        failures: [{ productId: 'p2', productName: 'Parle-G', message: 'disk full' }],
        archiveError: null,
        retryable: true
      };

      it('says honestly what failed, that the item was NOT removed, and offers Try again / Close', async () => {
        const service = serviceWithPreview(
          { affectedCount: 3, affectedProducts: [product(), product(), product()], archivedAffectedCount: 0 },
          { removeWithFallback: vi.fn().mockResolvedValue(partial) }
        );
        const dialog = await openRemoval(service);
        fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${singular}` }));

        const alert = await within(dialog).findByRole('alert');
        expect(alert).toHaveTextContent(/Couldn.t update 1 of 3 products, so .Snacks. was not removed/);
        expect(alert).toHaveTextContent(/already updated stay updated, and nothing was deleted/);
        expect(within(alert).getByText('Parle-G: disk full')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeEnabled();
        expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
        // the dialog stays open and the item is still listed as active
        expect(screen.getByText('Snacks', { selector: 'span' })).toBeInTheDocument();
        expect(screen.queryByText(/^Removed /)).not.toBeInTheDocument();
      });

      it('Try again re-runs the removal and finishes when it now succeeds', async () => {
        const removeWithFallback = vi
          .fn()
          .mockResolvedValueOnce(partial)
          .mockResolvedValueOnce({
            status: 'completed',
            affectedCount: 1,
            updatedCount: 1,
            skippedCount: 0,
            failures: [],
            archiveError: null,
            retryable: false
          });
        const service = serviceWithPreview(
          { affectedCount: 3, affectedProducts: [product(), product(), product()], archivedAffectedCount: 0 },
          { removeWithFallback }
        );
        const dialog = await openRemoval(service);
        fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${singular}` }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Try again' }));

        expect(await screen.findByText('Removed “Snacks”. 1 product was updated.')).toBeInTheDocument();
        expect(removeWithFallback).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      });

      it('Close after a failure dismisses the dialog', async () => {
        const service = serviceWithPreview(
          { affectedCount: 3, affectedProducts: [product()], archivedAffectedCount: 0 },
          { removeWithFallback: vi.fn().mockResolvedValue(partial) }
        );
        const dialog = await openRemoval(service);
        fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${singular}` }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      });

      it('explains an archive-only failure', async () => {
        const service = serviceWithPreview(
          { affectedCount: 2, affectedProducts: [product(), product()], archivedAffectedCount: 0 },
          {
            removeWithFallback: vi.fn().mockResolvedValue({
              status: 'archive-failed',
              affectedCount: 2,
              updatedCount: 2,
              skippedCount: 0,
              failures: [],
              archiveError: 'storage unavailable',
              retryable: true
            })
          }
        );
        const dialog = await openRemoval(service);
        fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${singular}` }));
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(
          /Every product was updated, but .Snacks. couldn.t be archived/
        );
        expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      });

      it('handles an unexpected thrown error without closing, and logs it', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const service = serviceWithPreview(
          { affectedCount: 1, affectedProducts: [product()], archivedAffectedCount: 0 },
          { removeWithFallback: vi.fn().mockRejectedValue(new Error('boom')) }
        );
        const dialog = await openRemoval(service);
        fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${singular}` }));

        expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Something went wrong. Nothing more was changed/);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
      });
    });

    describe('while checking who is affected', () => {
      it('shows a checking state first', async () => {
        const service = makeService({
          list: vi.fn().mockResolvedValue([item()]),
          previewRemoval: vi.fn(() => new Promise(() => {}))
        });
        renderPage(type, service);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove Snacks' }));
        expect(await screen.findByText(new RegExp(`Checking which products use this ${singular}`))).toBeInTheDocument();
      });

      it('shows an error with retry and Cancel, and changes nothing, if the check fails', async () => {
        const previewRemoval = vi
          .fn()
          .mockRejectedValueOnce(new Error('x'))
          .mockResolvedValueOnce({ classification: item(), affectedCount: 0, affectedProducts: [], archivedAffectedCount: 0 });
        const service = makeService({ list: vi.fn().mockResolvedValue([item()]), previewRemoval });
        renderPage(type, service);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove Snacks' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(`Couldn’t check which products use this ${singular}. Nothing was changed.`);
        expect(service.removeWithFallback).not.toHaveBeenCalled();

        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      });
    });
  });

  it('shows only one removal dialog at a time', async () => {
    const service = makeService({
      list: vi.fn().mockResolvedValue([item({ id: 'a', name: 'Alpha' }), item({ id: 'b', name: 'Bravo' })])
    });
    renderPage('category', service);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Alpha' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bravo' }));
    await waitFor(() => expect(screen.getAllByRole('alertdialog')).toHaveLength(1));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Bravo');
  });
});

// ---------------------------------------------------------------------------
// End to end: the REAL classificationService and productService on real
// (fake-indexeddb) repositories, driven through the page. Proves the page
// and the service agree on contracts the stubs above merely assume.
// ---------------------------------------------------------------------------
describe('ClassificationsPage with the real service (integration)', () => {
  let db;
  let productService;
  let classificationService;

  beforeEach(() => {
    db = createDatabase();
    const classificationRepository = createClassificationRepository(db);
    productService = createProductService(createProductRepository(db), classificationRepository);
    classificationService = createClassificationService(classificationRepository, productService);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  it('adds, renames and archives/restores a category through the UI', async () => {
    renderPage('category', classificationService);
    await screen.findByText('No categories yet. Add one above.');

    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'Snacks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    expect(await screen.findByText('Snacks')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rename Snacks' }));
    fireEvent.change(screen.getByLabelText('Name for Snacks'), { target: { value: 'Treats' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Treats')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Treats' }));
    const archived = await screen.findByRole('region', { name: 'Archived categories' });
    expect(within(archived).getByText('Treats')).toBeInTheDocument();

    fireEvent.click(within(archived).getByRole('button', { name: 'Restore Treats' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Categories' })).toHaveTextContent('Treats'));
    expect(screen.queryByRole('region', { name: 'Archived categories' })).not.toBeInTheDocument();
  });

  it('rejects a blank name through the UI without persisting anything', async () => {
    renderPage('tag', classificationService);
    await screen.findByText('No tags yet. Add one above.');
    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Name is required.');
    expect(await db.tags.count()).toBe(0);
  });

  it('removes a category: products fall back to Uncategorized, the category is archived, nothing is deleted', async () => {
    const { classification: cat } = await classificationService.create('category', 'Snacks');
    const { product: a } = await productService.createProduct({ name: 'Parle-G', categoryId: cat.id });
    const { product: b } = await productService.createProduct({ name: 'Good Day', categoryId: cat.id });
    await productService.createProduct({ name: 'Unrelated' });

    renderPage('category', classificationService);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Snacks' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText('2 products use this category.')).toBeInTheDocument();
    expect(within(dialog).getByText('Parle-G')).toBeInTheDocument();
    expect(within(dialog).getByText('Good Day')).toBeInTheDocument();
    expect(within(dialog).queryByText('Unrelated')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove category' }));

    expect(await screen.findByText('Removed “Snacks”. 2 products were updated.')).toBeInTheDocument();
    expect((await productService.getProduct(a.id)).categoryId).toBeNull();
    expect((await productService.getProduct(b.id)).categoryId).toBeNull();
    expect(await db.products.count()).toBe(3);
    const archived = await screen.findByRole('region', { name: 'Archived categories' });
    expect(within(archived).getByText('Snacks')).toBeInTheDocument();
  });

  it('removes only the chosen location from a product that has several', async () => {
    const { classification: keep } = await classificationService.create('location', 'Counter');
    const { classification: drop } = await classificationService.create('location', 'Back Room');
    const { product } = await productService.createProduct({ name: 'Dettol', locationIds: [keep.id, drop.id] });

    renderPage('location', classificationService);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Back Room' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove location' }));

    await screen.findByText('Removed “Back Room”. 1 product was updated.');
    expect((await productService.getProduct(product.id)).locationIds).toEqual([keep.id]);
  });
});
