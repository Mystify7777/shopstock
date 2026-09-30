import { Link } from 'react-router-dom';

/**
 * Shared "this thing doesn't exist" state (Phase 7B): a message plus a
 * safe way out, so an invalid destination is never a dead end.
 *
 * The message is the ONLY role="alert" element: the link sits outside it,
 * so assistive tech announces the problem, not the navigation, and the
 * alert's text stays exactly the message callers pass in.
 *
 * @param {{ message: string, linkTo: string, linkLabel: string }} props
 */
export default function NotFoundState({ message, linkTo, linkLabel }) {
  return (
    <div className="not-found-state">
      <p role="alert">{message}</p>
      <Link to={linkTo}>{linkLabel}</Link>
    </div>
  );
}
