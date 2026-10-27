import { TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Confirmation for a physical delete. The server decides whether the delete is allowed; when it refuses, `error`
 * explains why and `alternative` offers the safe action (archive / deactivate) right in the dialog.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  error,
  alternative,
  pending,
  confirmDisabled,
  confirmLabel = 'Удалить навсегда',
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  error?: string | null;
  alternative?: ReactNode;
  pending: boolean;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  testId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <DialogContent data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {error && (
          <Alert variant="destructive" data-testid={`${testId}-error`}>
            <WarningCircleIcon aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          {alternative}
          <Button variant="destructive" disabled={pending || confirmDisabled} onClick={onConfirm} data-testid={`${testId}-confirm`}>
            <TrashIcon aria-hidden /> {pending ? 'Удаляем…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
