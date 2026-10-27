import { zodResolver } from '@hookform/resolvers/zod';
import { InfoIcon } from '@phosphor-icons/react';
import { useForm, useWatch } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { availableMethods, checkoutFormSchema, FULFILLMENT_LABELS, type CheckoutFormValues } from './checkout-schema';

export const DEFAULT_PICKUP_INSTRUCTIONS = 'Адрес и время самовывоза магазин сообщит после подтверждения заказа.';

export function CheckoutForm({
  fulfillment,
  disabled,
  submitting,
  submitLabel,
  onSubmit,
}: {
  fulfillment: { delivery: boolean; pickup: boolean; pickupInstructions: string };
  disabled: boolean;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (v: CheckoutFormValues) => void;
}) {
  const methods = availableMethods(fulfillment);
  const form = useForm<CheckoutFormValues>({
    resolver: zodResolver(checkoutFormSchema),
    // A single available method is selected automatically.
    defaultValues: { method: methods[0] ?? 'delivery', address: '', comment: '' },
  });
  const { errors } = form.formState;
  const method = useWatch({ control: form.control, name: 'method' });
  const noMethods = methods.length === 0;
  return (
    <form className="space-y-4" noValidate onSubmit={form.handleSubmit(onSubmit)} aria-label="Оформление заказа">
      {noMethods ? (
        <p role="alert" className="rounded-lg border border-destructive/50 p-3 text-sm text-destructive" data-testid="checkout-no-methods">
          Магазин временно не принимает заказы: способы получения не настроены.
        </p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Способ получения</legend>
          <div role="radiogroup" aria-label="Способ получения" className="grid grid-cols-2 gap-2" data-testid="fulfillment-methods">
            {(['delivery', 'pickup'] as const).map((m) => {
              const enabled = methods.includes(m);
              const active = method === m && enabled;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!enabled}
                  onClick={() => form.setValue('method', m, { shouldValidate: form.formState.isSubmitted })}
                  data-testid={`fulfillment-${m}`}
                  className={cn(
                    'min-h-11 rounded-lg border px-3 py-2 text-sm transition-colors',
                    active ? 'border-primary bg-primary/15 font-medium' : 'bg-card hover:border-primary/60',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  {FULFILLMENT_LABELS[m]}
                  {!enabled && <span className="sr-only"> — недоступно</span>}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {!noMethods && method === 'delivery' && (
        <div className="space-y-1.5">
          <Label htmlFor="co-address">Адрес доставки</Label>
          <Textarea
            id="co-address"
            rows={2}
            autoComplete="street-address"
            maxLength={300}
            aria-required
            aria-invalid={!!errors.address}
            aria-describedby={errors.address ? 'co-address-err' : undefined}
            {...form.register('address')}
          />
          {errors.address && <p id="co-address-err" className="text-sm text-destructive">{errors.address.message}</p>}
        </div>
      )}
      {!noMethods && method === 'pickup' && (
        <div role="note" className="glass-card flex gap-3 rounded-xl p-3 text-sm" data-testid="pickup-instructions">
          <InfoIcon aria-hidden weight="fill" className="mt-0.5 size-5 shrink-0 text-primary" />
          <p className="whitespace-pre-line break-words">{fulfillment.pickupInstructions.trim() || DEFAULT_PICKUP_INSTRUCTIONS}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="co-comment">Комментарий (необязательно)</Label>
        <Textarea id="co-comment" rows={3} aria-invalid={!!errors.comment} {...form.register('comment')} />
        {errors.comment && <p className="text-sm text-destructive">{errors.comment.message}</p>}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={disabled || submitting || noMethods} data-testid="checkout-submit">
        {submitting ? 'Отправляем…' : submitLabel}
      </Button>
    </form>
  );
}
