// src/lib/hqAccess.js — who is shown the Fortune HQ board, and its six desks (Ezra, 2026-10-27).
//
// The board is the owner's own: only an admin whose sign-in email is in HQ_OWNER_EMAILS sees the nav entry.
// This decides whether the door is DRAWN; netlify/functions/hq-board.js is the wall (403 for anyone else),
// the same split the PREOWNED_ROLES list in App.jsx describes.
//
// Later each division head gets a login that shows only their own division. The page already takes that as
// one parameter (FortuneHQ's `scope`, a tab id); the server must filter by the same id before it is offered.
import { useEffect, useState } from 'react';
import { api } from './api.js';

export const HQ_OWNER_EMAILS = ['owner@example.com'];

/** The six desks, in board order. The server's `tabs` list wins when it arrives; this is the first paint. */
export const HQ_TABS = [
  { id: 'company', label: 'Joey · CEO', subtitle: 'Company' },
  { id: 'finance', label: 'George', subtitle: 'Finance' },
  { id: 'online', label: 'Georgette', subtitle: 'Online' },
  { id: 'salon', label: 'Cindy', subtitle: 'Salon' },
  { id: 'manager', label: 'HQ Manager', subtitle: 'Reviews & memory' },
  { id: 'legal', label: 'Legal Team', subtitle: 'Terms & policies' },
];
export const HQ_TAB_IDS = HQ_TABS.map((t) => t.id);

export const isHqOwnerEmail = (email) => HQ_OWNER_EMAILS.includes(String(email || '').trim().toLowerCase());

/**
 * True when the signed-in person is the owner. auth-me does not carry the email today, so an admin's own row
 * is read from the user list (admins only; it is the same call Admin → Users makes). A future auth-me that
 * returns `email` is used directly.
 * @param {{ role?: string|null, userId?: string|null, email?: string|null }} auth
 */
export function useHqOwner(auth) {
  const [found, setFound] = useState(/** @type {string|null} */ (null));
  const admin = auth.role === 'admin';
  useEffect(() => {
    if (!admin || !auth.userId || auth.email) return undefined;
    let alive = true;
    api.adminUsers.list()
      .then((r) => {
        const me = (r?.users || []).find((u) => u.id === auth.userId);
        if (alive) setFound(me?.email || null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [admin, auth.userId, auth.email]);
  return admin && isHqOwnerEmail(auth.email || found);
}
