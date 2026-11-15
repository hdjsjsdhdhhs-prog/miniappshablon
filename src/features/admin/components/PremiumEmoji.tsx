import { SparkleIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CUSTOM_EMOJI_ID_RE, isEmojiIdInput, tgEmojiTag } from '@/domain/bot-welcome';

/**
 * Small, collapsed-by-default note on Telegram Premium (custom) emoji: how to add one by its ID and what Telegram
 * allows. Shown where they are supported — the welcome message and broadcasts — and nowhere else.
 */
export function PremiumEmojiHint({ where }: { where: 'welcome' | 'broadcast' }) {
  return (
    <details className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="premium-emoji-hint">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-foreground select-none">
        <SparkleIcon aria-hidden weight="fill" className="size-3.5 text-[#6ab3f3]" /> Premium Emoji: как добавить
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        <li>
          В тексте: вставьте <span className="font-mono text-foreground">&lt;tg-emoji emoji-id="ID"&gt;🙂&lt;/tg-emoji&gt;</span>. Внутри тега —
          обычный эмодзи: его увидят там, где Premium Emoji показать нельзя.
        </li>
        <li>На кнопке: укажите ID в поле «Premium Emoji ID». Обычный эмодзи можно просто написать в тексте кнопки.</li>
        <li>
          Как узнать ID: отправьте боту вашего магазина команду <span className="font-mono text-foreground">/emoji</span> и нужные Premium Emoji в
          одном сообщении — бот ответит их ID.
        </li>
        <li>
          Ограничение Telegram: боту разрешены Premium Emoji, только если у его владельца есть подписка Telegram Premium (или для бота куплен
          дополнительный username на Fragment). Иначе {where === 'welcome' ? 'приветствие' : 'рассылка'} всё равно будет отправлена — с обычными
          эмодзи и без значков на кнопках.
        </li>
        {where === 'welcome' && <li>В кнопке меню слева от поля ввода Telegram показывает только текст.</li>}
      </ul>
    </details>
  );
}

/** "ID + regular emoji → tag": builds <tg-emoji …> and hands it to the caller, which puts it into the message text. */
export function PremiumEmojiInsert({ onInsert, idPrefix }: { onInsert: (tag: string) => void; idPrefix: string }) {
  const [id, setId] = useState('');
  const [fallback, setFallback] = useState('');
  const valid = CUSTOM_EMOJI_ID_RE.test(id.trim()) && fallback.trim().length > 0 && fallback.trim().length <= 16 && !/[<>]/.test(fallback);
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid={`${idPrefix}-emoji-insert`}>
      <div className="min-w-40 flex-1 space-y-1">
        <Label htmlFor={`${idPrefix}-emoji-id`} className="text-xs text-muted-foreground">
          Premium Emoji ID
        </Label>
        <Input
          id={`${idPrefix}-emoji-id`}
          inputMode="numeric"
          autoComplete="off"
          placeholder="5368324170671202286"
          value={id}
          maxLength={25}
          aria-invalid={!isEmojiIdInput(id)}
          onChange={(e) => setId(e.target.value.replace(/\D/g, ''))}
          data-testid={`${idPrefix}-emoji-insert-id`}
        />
      </div>
      <div className="w-24 space-y-1">
        <Label htmlFor={`${idPrefix}-emoji-fallback`} className="text-xs text-muted-foreground">
          Обычный
        </Label>
        <Input
          id={`${idPrefix}-emoji-fallback`}
          autoComplete="off"
          placeholder="🔥"
          value={fallback}
          maxLength={16}
          onChange={(e) => setFallback(e.target.value)}
          data-testid={`${idPrefix}-emoji-insert-fallback`}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9"
        disabled={!valid}
        onClick={() => {
          onInsert(tgEmojiTag(id, fallback));
          setId('');
          setFallback('');
        }}
        data-testid={`${idPrefix}-emoji-insert-add`}
      >
        Вставить в текст
      </Button>
    </div>
  );
}

/** Optional icon of an inline button. */
export function ButtonEmojiField({ id, value, onChange, testId }: { id: string; value: string; onChange: (value: string) => void; testId: string }) {
  const invalid = !isEmojiIdInput(value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="pt-2">
        Premium Emoji ID <span className="font-normal text-muted-foreground">— необязательно</span>
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="Например, 5368324170671202286"
        maxLength={25}
        value={value}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value.replace(/\s/g, ''))}
        data-testid={testId}
      />
      {invalid && (
        <p className="text-xs text-destructive" data-testid={`${testId}-error`}>
          ID Premium Emoji состоит только из цифр.
        </p>
      )}
    </div>
  );
}

