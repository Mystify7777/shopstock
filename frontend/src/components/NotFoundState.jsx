import { Link } from 'react-router-dom';

/**
 * Shared "this thing doesn't exist" state (Phase 7B): a message plus a
 * safe way out, so an invalid destination is never a dead end.
 *
 * The message is the ONLY role="alert" element: the link sits outside it,
 * so assistive tech announces the problem, not the navigation, and the
 * alert's text stays exactly the message callers pass in.
 *
 * Redesign R9a (presentation only): the message is a NEUTRAL notice, because a
 * thing that does not exist is not a system failure (danger is kept for real
 * failures), and the way out is a quiet link.
 *
 * @param {{ message: string, linkTo: string, linkLabel: string }} props
 */
export default function NotFoundState({ message, linkTo, linkLabel }) {
  return (
    <div className="not-found-state">
      <p role="alert" className="notice notice--neutral">
        {message}
      </p>
      <Link to={linkTo} className="touch-link quiet-link">
        {linkLabel}
      </Link>
    </div>
  );
}
