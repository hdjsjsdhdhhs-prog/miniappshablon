import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { checkoutFormSchema, type CheckoutFormValues } from './checkout-schema';

export function CheckoutForm({
  defaultName,
  disabled,
  submitting,
  submitLabel,
  onSubmit,
}: {
  defaultName: string;
  disabled: boolean;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (v: CheckoutFormValues) => void;
}) {
  const form = useForm<CheckoutFormValues>({
    resolver: zodResolver(checkoutFormSchema),
    defaultValues: { name: defaultName, phone: '', comment: '' },
  });
  const { errors } = form.formState;
  return (
    <form className="space-y-4" noValidate onSubmit={form.handleSubmit(onSubmit)} aria-label="Оформление заказа">
      <div className="space-y-1.5">
        <Label htmlFor="co-name">Имя</Label>
        <Input id="co-name" autoComplete="name" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'co-name-err' : undefined} {...form.register('name')} />
        {errors.name && <p id="co-name-err" className="text-sm text-destructive">{errors.name.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="co-phone">Телефон (необязательно)</Label>
        <Input id="co-phone" type="tel" inputMode="tel" autoComplete="tel" aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'co-phone-err' : undefined} {...form.register('phone')} />
        {errors.phone && <p id="co-phone-err" className="text-sm text-destructive">{errors.phone.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="co-comment">Комментарий (необязательно)</Label>
        <Textarea id="co-comment" rows={3} aria-invalid={!!errors.comment} {...form.register('comment')} />
        {errors.comment && <p className="text-sm text-destructive">{errors.comment.message}</p>}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={disabled || submitting} data-testid="checkout-submit">
        {submitting ? 'Отправляем…' : submitLabel}
      </Button>
    </form>
  );
}
