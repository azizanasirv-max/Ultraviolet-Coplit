/** Path-based participant routing. Roles are still verified by the server. */

export type RouteInfo =
  | { kind: 'salesperson' }
  | { kind: 'customer'; inviteToken: string; legacyInvitation: boolean }
  | { kind: 'prototype-tabs' };

export const readRoute = (location: Location = window.location): RouteInfo => {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(location.search);

  if (path === '/sales') return { kind: 'salesperson' };

  if (path === '/join') {
    return { kind: 'customer', inviteToken: params.get('invite')?.trim() || '', legacyInvitation: false };
  }

  if (path.startsWith('/join/')) {
    return {
      kind: 'customer',
      inviteToken: decodeURIComponent(path.slice('/join/'.length)).trim(),
      legacyInvitation: false,
    };
  }

  // Old `?room=...&role=customer` links are not authorization: show the customer
  // shell with an explicit "invalid invitation" state instead of joining.
  if (params.get('prototype') === '2' && params.get('role') === 'customer') {
    return { kind: 'customer', inviteToken: '', legacyInvitation: true };
  }

  return { kind: 'prototype-tabs' };
};

export const navigate = (path: string): void => {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
};
