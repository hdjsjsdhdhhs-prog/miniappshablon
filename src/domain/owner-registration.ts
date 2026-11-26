import { z } from 'zod';
import { passwordIssue } from './password';

/** 32 random bytes in base64url. The server refuses anything else before touching the database. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Path of the buyer's page. The token travels in the URL FRAGMENT: it is never sent to a server, a proxy or a Referer. */
export const OWNER_REGISTRATION_PATH = '/admin/register';

export function ownerLinkUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}${OWNER_REGISTRATION_PATH}#${token}`;
}

/** The token of `location.hash` ("#<token>"), or null when the address does not carry a well-formed one. */
export function readInviteToken(hash: string): string | null {
  const value = hash.replace(/^#/, '');
  return INVITE_TOKEN_RE.test(value) ? value : null;
}

export const registrationSchema = z
  .object({
    email: z.string().trim().min(1, 'Введите электронную почту').pipe(z.email('Введите корректный адрес электронной почты')),
    password: z.string().superRefine((value, ctx) => {
      const issue = passwordIssue(value);
      if (issue) ctx.addIssue({ code: 'custom', message: issue });
    }),
    repeat: z.string().min(1, 'Повторите пароль'),
  })
  .refine((v) => v.password === v.repeat, { path: ['repeat'], message: 'Пароли не совпадают' });

export type RegistrationInput = z.infer<typeof registrationSchema>;

export const signInSchema = z.object({
  email: z.string().trim().min(1, 'Введите электронную почту').pipe(z.email('Введите корректный адрес электронной почты')),
  password: z.string().min(1, 'Введите пароль'),
});

export type SignInInput = z.infer<typeof signInSchema>;

/** Status of a link as the buyer's page learns it (owner_invite_preview). */
export type InvitePreviewStatus = 'invalid' | 'expired' | 'revoked' | 'used' | 'unavailable' | 'busy' | 'active';
