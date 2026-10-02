import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAppContext } from '../contexts/AppContext.jsx';
import { useAsyncResource } from '../hooks/useAsyncResource.js';
import ResourceView from '../components/ResourceView.jsx';
import ClassificationRemoval from '../components/ClassificationRemoval.jsx';
import { CLASSIFICATION_TYPES, classificationPath } from '../components/classificationTypes.js';

// Classification management (Phase 7C): /classifications/<slug>.
//
// One screen, parameterized by type, for categories, locations, tags and
// units. It exposes only what classificationService supports: list, add,
// rename, archive, restore, and (category / location / tag only) remove.
//
//   Archive  non-destructive. The item stops appearing in filters;
//            products that already use it keep it. Restorable.
//   Remove   takes the item off every product that uses it (using the
//            existing fallback rules), then archives it. Needs an
//            explicit confirmation showing who is affected.
//
// No duplicate-name rule, no default seeding, no `isDefault` behavior:
// none exists in the app, so none is invented here.

const GENERIC_ERROR = 'Something went wrong. Please try again.';

export default function ClassificationsPage({ type }) {
  const config = CLASSIFICATION_TYPES.find((entry) => entry.type === type);
  const { classificationService } = useAppContext();

  const list = useAsyncResource(
    () => classificationService.list(type, { includeArchived: true }),
    [classificationService, type]
  );

  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  // Runs a service call that returns { classification, errors }. Returns
  // true when it succeeded (no validation errors, nothing thrown).
  async function perform(call, onErrors) {
    setPending(true);
    setActionError(null);
    try {
      const { errors } = await call();
      if (errors.length > 0) {
        onErrors(errors.join(' '));
        return false;
      }
      list.reload();
      return true;
    } catch (error) {
      console.error('Classification action failed:', error);
      onErrors(GENERIC_ERROR);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function handleAdd(event) {
    event.preventDefault();
    setAddError(null);
    setNotice(null);
    const name = newName.trim();
    const ok = await perform(() => classificationService.create(type, newName), setAddError);
    if (ok) {
      setNewName('');
      setNotice(`Added “${name}”.`);
    }
  }

  function startRename(item) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditError(null);
    setNotice(null);
    setRemovingId(null);
  }

  async function handleRename(event, item) {
    event.preventDefault();
    const ok = await perform(() => classificationService.rename(type, item.id, editName), setEditError);
    if (ok) {
      setEditingId(null);
      setNotice(`Renamed to “${editName.trim()}”.`);
    }
  }

  async function handleArchive(item) {
    setNotice(null);
    setRemovingId(null);
    const ok = await perform(() => classificationService.archive(type, item.id), setActionError);
    if (ok) setNotice(`Archived “${item.name}”.`);
  }

  async function handleRestore(item) {
    setNotice(null);
    const ok = await perform(() => classificationService.restore(type, item.id), setActionError);
    if (ok) setNotice(`Restored “${item.name}”.`);
  }

  function handleRemoved(item, result) {
    setRemovingId(null);
    list.reload();
    setNotice(
      result.updatedCount > 0
        ? `Removed “${item.name}”. ${result.updatedCount} ${result.updatedCount === 1 ? 'product was' : 'products were'} updated.`
        : `Removed “${item.name}”.`
    );
  }

  return (
    <div className="classifications">
      <h1>Classifications</h1>

      <nav aria-label="Classification types">
        <ul className="classifications__tabs">
          {CLASSIFICATION_TYPES.map((entry) => (
            <li key={entry.type}>
              <NavLink to={classificationPath(entry.slug)}>{entry.plural}</NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <p>
        {config.removable
          ? 'Archiving hides an item from filters; products that already use it keep it. Removing takes it off every product that uses it.'
          : 'Archiving hides a unit from filters; products that already use it keep it. Units cannot be removed.'}
      </p>

      <form onSubmit={handleAdd}>
        <label htmlFor="new-classification-name">New {config.singular} name</label>
        <input
          id="new-classification-name"
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          aria-invalid={addError ? 'true' : undefined}
        />
        <button type="submit" disabled={pending}>
          Add {config.singular}
        </button>
        {addError && <p role="alert">{addError}</p>}
      </form>

      {notice && <p role="status">{notice}</p>}
      {actionError && <p role="alert">{actionError}</p>}

      <ResourceView
        resource={list}
        loadingMessage={`Loading ${config.plural.toLowerCase()}…`}
        errorMessage={`Couldn't load your ${config.plural.toLowerCase()}.`}
      >
        {(items) => {
          const active = items.filter((item) => !item.archived);
          const archived = items.filter((item) => item.archived);

          return (
            <>
              <section aria-labelledby="classifications-active-heading">
                <h2 id="classifications-active-heading">{config.plural}</h2>
                {active.length === 0 ? (
                  <p>No {config.plural.toLowerCase()} yet. Add one above.</p>
                ) : (
                  <ul>
                    {active.map((item) => (
                      <li key={item.id}>
                        {editingId === item.id ? (
                          <form onSubmit={(e) => handleRename(e, item)}>
                            <label htmlFor={`rename-${item.id}`}>Name for {item.name}</label>
                            <input
                              id={`rename-${item.id}`}
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              aria-invalid={editError ? 'true' : undefined}
                            />
                            <button type="submit" disabled={pending}>
                              Save
                            </button>
                            <button type="button" onClick={() => setEditingId(null)} disabled={pending}>
                              Cancel
                            </button>
                            {editError && <p role="alert">{editError}</p>}
                          </form>
                        ) : (
                          <>
                            <span>{item.name}</span>{' '}
                            <button
                              type="button"
                              onClick={() => startRename(item)}
                              aria-label={`Rename ${item.name}`}
                              disabled={pending}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              onClick={() => handleArchive(item)}
                              aria-label={`Archive ${item.name}`}
                              disabled={pending}
                            >
                              Archive
                            </button>
                            {config.removable && (
                              <button
                                type="button"
                                onClick={() => {
                                  setNotice(null);
                                  setRemovingId(item.id);
                                }}
                                aria-label={`Remove ${item.name}`}
                                disabled={pending || removingId === item.id}
                              >
                                Remove
                              </button>
                            )}
                          </>
                        )}
                        {removingId === item.id && (
                          <ClassificationRemoval
                            config={config}
                            classification={item}
                            service={classificationService}
                            onCancel={() => setRemovingId(null)}
                            onRemoved={(result) => handleRemoved(item, result)}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {archived.length > 0 && (
                <section aria-labelledby="classifications-archived-heading">
                  <h2 id="classifications-archived-heading">Archived {config.plural.toLowerCase()}</h2>
                  <ul>
                    {archived.map((item) => (
                      <li key={item.id}>
                        <span>{item.name}</span>{' '}
                        <button
                          type="button"
                          onClick={() => handleRestore(item)}
                          aria-label={`Restore ${item.name}`}
                          disabled={pending}
                        >
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          );
        }}
      </ResourceView>
    </div>
  );
}
