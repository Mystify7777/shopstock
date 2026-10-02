import { useState } from 'react';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

// Confirmation + execution of "Remove" for a category, location or tag
// (Phase 7C). Uses the app's existing inline role="alertdialog" pattern.
//
// Flow: show who is affected and what will happen -> explicit confirm ->
// classificationService.removeWithFallback() -> honest outcome.
//
// The operation is NOT atomic (see classificationService.js). If it
// fails partway this component says so plainly, nothing is hidden, and
// "Try again" simply runs the removal again (products already updated are
// not touched twice).

const CONSEQUENCE = {
  category: 'They will become Uncategorized.',
  location: 'This location will be taken off them. Any other locations they have stay.',
  tag: 'This tag will be taken off them.'
};

const LIST_LIMIT = 10;

function countProducts(n) {
  return `${n} ${n === 1 ? 'product' : 'products'}`;
}

/**
 * @param {{
 *   config: { type: string, singular: string },
 *   classification: { id: string, name: string },
 *   service: object,                       classificationService
 *   onCancel: () => void,
 *   onRemoved: (result: object) => void    called once removal fully completed
 * }} props
 */
export default function ClassificationRemoval({ config, classification, service, onCancel, onRemoved }) {
  const { type, singular } = config;
  const headingId = `remove-${classification.id}-heading`;

  const preview = useAsyncResource(
    () => service.previewRemoval(type, classification.id),
    [service, type, classification.id]
  );

  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState(null); // an unsuccessful removeWithFallback() result
  const [unexpectedError, setUnexpectedError] = useState(false);

  async function handleConfirm() {
    setRunning(true);
    setFailure(null);
    setUnexpectedError(false);
    try {
      const result = await service.removeWithFallback(type, classification.id);
      if (result.status === 'completed') {
        onRemoved(result);
        return;
      }
      setFailure(result);
    } catch (error) {
      console.error('Classification removal failed unexpectedly:', error);
      setUnexpectedError(true);
    }
    setRunning(false);
  }

  if (preview.status === 'loading') {
    return <p role="status">Checking which products use this {singular}&hellip;</p>;
  }

  if (preview.status === 'error') {
    return (
      <div role="alert">
        <p>Couldn&rsquo;t check which products use this {singular}. Nothing was changed.</p>
        <button type="button" onClick={preview.reload}>
          Try again
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  const { affectedCount, affectedProducts, archivedAffectedCount } = preview.data;

  return (
    <div role="alertdialog" aria-labelledby={headingId}>
      <h3 id={headingId}>
        Remove {singular} &ldquo;{classification.name}&rdquo;?
      </h3>

      <p>
        {affectedCount === 0
          ? `No products use this ${singular}.`
          : `${countProducts(affectedCount)} ${affectedCount === 1 ? 'uses' : 'use'} this ${singular}${
              archivedAffectedCount > 0 ? ` (${archivedAffectedCount} archived)` : ''
            }.`}
      </p>

      {affectedCount > 0 && (
        <>
          <p>{CONSEQUENCE[type]}</p>
          <ul>
            {affectedProducts.slice(0, LIST_LIMIT).map((product) => (
              <li key={product.id}>
                {typeof product.name === 'string' && product.name.trim() !== ''
                  ? product.name.trim()
                  : 'Unnamed product'}
              </li>
            ))}
          </ul>
          {affectedCount > LIST_LIMIT && <p>and {affectedCount - LIST_LIMIT} more.</p>}
        </>
      )}

      <p>
        No products will be deleted. The {singular} itself will be archived, and you can restore it
        later.
      </p>

      {failure && failure.status === 'partial' && (
        <div role="alert">
          <p>
            Couldn&rsquo;t update {failure.failures.length} of {countProducts(failure.affectedCount)}, so
            &ldquo;{classification.name}&rdquo; was not removed. Products that were already updated stay
            updated, and nothing was deleted.
          </p>
          <ul>
            {failure.failures.map((item) => (
              <li key={item.productId}>
                {item.productName}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {failure && failure.status === 'archive-failed' && (
        <div role="alert">
          <p>
            Every product was updated, but &ldquo;{classification.name}&rdquo; couldn&rsquo;t be archived.
            Try again to finish.
          </p>
        </div>
      )}

      {unexpectedError && (
        <div role="alert">
          <p>Something went wrong. Nothing more was changed. You can try again.</p>
        </div>
      )}

      <button type="button" onClick={onCancel} disabled={running}>
        {failure || unexpectedError ? 'Close' : 'Cancel'}
      </button>
      <button type="button" onClick={handleConfirm} disabled={running}>
        {running ? 'Removing…' : failure || unexpectedError ? 'Try again' : `Remove ${singular}`}
      </button>
    </div>
  );
}
