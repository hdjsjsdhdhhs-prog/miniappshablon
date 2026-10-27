import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutForm, DEFAULT_PICKUP_INSTRUCTIONS } from './CheckoutForm';
import { checkoutFormSchema, toFulfillment } from './checkout-schema';

const both = { delivery: true, pickup: true, pickupInstructions: 'ул. Мира, 1, ежедневно 10–20' };

function renderForm(fulfillment = both, onSubmit = vi.fn()) {
  render(<CheckoutForm fulfillment={fulfillment} disabled={false} submitting={false} submitLabel="Оформить" onSubmit={onSubmit} />);
  return onSubmit;
}

describe('CheckoutForm', () => {
  it('has no name/phone fields; delivery requires an address; the comment stays', async () => {
    const onSubmit = renderForm();
    expect(screen.queryByLabelText('Имя')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Телефон/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Комментарий/)).toBeInTheDocument();
    expect(screen.getByTestId('fulfillment-delivery')).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByTestId('checkout-submit'));
    expect(await screen.findByText('Укажите адрес доставки')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Адрес доставки'), '  ул. Ленина, 1  ');
    await userEvent.click(screen.getByTestId('checkout-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(toFulfillment(onSubmit.mock.calls[0]![0])).toEqual({ method: 'delivery', address: 'ул. Ленина, 1' });
  });

  it('pickup hides the address and shows the owner-defined instructions; no address is sent', async () => {
    const onSubmit = renderForm();
    await userEvent.type(screen.getByLabelText('Адрес доставки'), 'ул. Ленина, 1');
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    expect(screen.queryByLabelText('Адрес доставки')).not.toBeInTheDocument();
    expect(screen.getByTestId('pickup-instructions')).toHaveTextContent(both.pickupInstructions);
    await userEvent.click(screen.getByTestId('checkout-submit'));
    expect(toFulfillment(onSubmit.mock.calls[0]![0])).toEqual({ method: 'pickup' });
  });

  it('a single enabled method is pre-selected, the other is disabled; empty instructions use the default text', () => {
    renderForm({ delivery: false, pickup: true, pickupInstructions: '' });
    expect(screen.getByTestId('fulfillment-pickup')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('fulfillment-delivery')).toBeDisabled();
    expect(screen.getByTestId('pickup-instructions')).toHaveTextContent(DEFAULT_PICKUP_INSTRUCTIONS);
  });

  it('both methods disabled: clear message and the order can not be submitted', async () => {
    const onSubmit = renderForm({ delivery: false, pickup: false, pickupInstructions: '' });
    expect(screen.getByTestId('checkout-no-methods')).toHaveTextContent('способы получения не настроены');
    expect(screen.queryByTestId('fulfillment-methods')).not.toBeInTheDocument();
    expect(screen.getByTestId('checkout-submit')).toBeDisabled();
    await userEvent.click(screen.getByTestId('checkout-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('checkoutFormSchema', () => {
  it('rejects unknown methods, blank and too long addresses', () => {
    expect(checkoutFormSchema.safeParse({ method: 'courier', address: 'x', comment: '' }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ method: 'delivery', address: '   ', comment: '' }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ method: 'delivery', address: 'x'.repeat(301), comment: '' }).success).toBe(false);
    expect(checkoutFormSchema.safeParse({ method: 'pickup', address: '', comment: '' }).success).toBe(true);
  });
});
