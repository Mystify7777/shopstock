import { NavLink } from 'react-router-dom';
import { NAV_ITEMS, MOBILE_BAR_MIN_ITEMS } from './navItems.js';

/**
 * Primary navigation. One <nav> element for every screen size: inline in
 * the header on wide screens; a bottom bar on narrow screens ONLY when
 * there are enough items (data-mobile-bar, consumed by shell.css).
 *
 * Active state: react-router's NavLink matches by path prefix on segment
 * boundaries, so /products, /products/new, /products/:id and
 * /products/:id/edit all mark Products active, while an unknown route
 * marks nothing active. The active link gets aria-current="page".
 *
 * @param {{ items?: Array<{label: string, to: string, end?: boolean}> }} props
 */
export default function PrimaryNav({ items = NAV_ITEMS }) {
  const showMobileBar = items.length >= MOBILE_BAR_MIN_ITEMS;

  return (
    <nav
      className="primary-nav"
      aria-label="Primary"
      data-mobile-bar={showMobileBar ? 'true' : 'false'}
    >
      <ul className="primary-nav__list">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end === true} className="primary-nav__link">
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
