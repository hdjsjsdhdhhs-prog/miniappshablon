import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { bindBackButton } from './telegram';

/** Telegram Back button: visible everywhere except the given root path. */
export function useTelegramBackButton(rootPath: string): void {
  const location = useLocation();
  const navigate = useNavigate();
  const isRoot = location.pathname === rootPath || location.pathname === rootPath.replace(/\/$/, '');

  useEffect(
    () =>
      bindBackButton(!isRoot, () => {
        // location.key === 'default' means this is the first entry: go to the shop root instead.
        if (location.key === 'default') navigate(rootPath, { replace: true });
        else navigate(-1);
      }),
    [isRoot, location.key, navigate, rootPath],
  );
}
