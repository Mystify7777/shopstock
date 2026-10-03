import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ResourceView from './ResourceView.jsx';

const resource = (overrides) => ({ status: 'success', data: 'DATA', error: null, isReloading: false, reload: vi.fn(), ...overrides });

function renderView(res, props = {}) {
  return render(
    <ResourceView resource={res} loadingMessage="Loading it" errorMessage="Couldn't load it." {...props}>
      {(data) => <p>content: {data}</p>}
    </ResourceView>
  );
}

describe('ResourceView', () => {
  it('shows the loading message as a status', () => {
    renderView(resource({ status: 'loading', data: undefined }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading it');
    expect(screen.queryByText(/content/)).not.toBeInTheDocument();
  });

  it('renders the content with the data once loaded', () => {
    renderView(resource());
    expect(screen.getByText('content: DATA')).toBeInTheDocument();
  });

  describe('error', () => {
    const failed = () => resource({ status: 'error', data: undefined, error: new Error('db exploded') });

    it('shows the friendly message and a working Try again, but NOT the raw error, by default', () => {
      const res = failed();
      renderView(res);
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load it.");
      expect(screen.queryByText('db exploded')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(res.reload).toHaveBeenCalledTimes(1);
    });

    it('with showDetail also shows the underlying error message on its own line', () => {
      renderView(failed(), { showDetail: true });
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load it.");
      expect(screen.getByText('db exploded')).toBeInTheDocument();
    });

    it('showDetail with an error that has no message adds nothing extra', () => {
      renderView(resource({ status: 'error', data: undefined, error: new Error('') }), { showDetail: true });
      expect(screen.getByRole('alert').querySelectorAll('p')).toHaveLength(1);
    });
  });
});
