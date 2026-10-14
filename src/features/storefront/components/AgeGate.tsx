import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const key = (shopId: string) => `tma-age-ok:${shopId}`;

/** One-time age confirmation per shop when the shop declares an age restriction. */
export function AgeGate({ shopId, age, legalNotice }: { shopId: string; age: number; legalNotice: string }) {
  const [open, setOpen] = useState(() => {
    if (age <= 0) return false;
    try {
      return localStorage.getItem(key(shopId)) !== '1';
    } catch {
      return true;
    }
  });
  const [declined, setDeclined] = useState(false);
  if (age <= 0) return null;
  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Вам исполнилось {age}?</DialogTitle>
          <DialogDescription>{declined ? 'Доступ к витрине ограничен по возрасту.' : legalNotice}</DialogDescription>
        </DialogHeader>
        {!declined && (
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclined(true)}>
              Нет
            </Button>
            <Button
              onClick={() => {
                try {
                  localStorage.setItem(key(shopId), '1');
                } catch {
                  /* ignore */
                }
                setOpen(false);
              }}
            >
              Да, мне есть {age}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
