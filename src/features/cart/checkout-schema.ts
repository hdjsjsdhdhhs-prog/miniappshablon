import { z } from 'zod';

export const checkoutFormSchema = z.object({
  name: z.string().trim().min(1, 'Укажите имя').max(80, 'Не длиннее 80 символов'),
  phone: z
    .string()
    .trim()
    .max(32, 'Слишком длинный номер')
    .refine((v) => v === '' || /^[+\d][\d\s()-]{5,}$/.test(v), 'Номер в формате +7 900 000-00-00'),
  comment: z.string().trim().max(500, 'Не длиннее 500 символов'),
});

export type CheckoutFormValues = z.infer<typeof checkoutFormSchema>;
