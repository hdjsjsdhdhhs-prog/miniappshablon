import { ArrowSquareOutIcon, SparkleIcon } from '@phosphor-icons/react';
import { richSegments } from '@/domain/bot-welcome';
import { cn } from '@/lib/utils';

export interface PreviewButton {
  text: string;
  /** Premium emoji id of the button icon (shown as a marker: the real emoji is drawn by Telegram only). */
  emojiId?: string | null;
  /** A link that leaves Telegram's Mini App (the manager button). */
  external?: boolean;
  /** Dimmed: the button is not sent yet (e.g. no manager link). */
  muted?: boolean;
}

/**
 * Telegram-like preview of a bot message: optional photo, text and the inline keyboard. Used by «Подключение бота»
 * (welcome) and «Рассылка». Premium emoji are shown by the regular emoji the owner typed inside the tag, with a
 * dotted outline — Telegram draws the Premium one for users who can see it.
 */
export function TelegramPreview({
  text,
  photoUrl,
  buttons,
  testId = 'bot-preview',
}: {
  text: string;
  photoUrl?: string | null;
  buttons: PreviewButton[];
  testId?: string;
}) {
  const segments = richSegments(text);
  return (
    <div className="rounded-xl bg-[#0e1621] p-3" data-testid={testId}>
      <div className="max-w-[300px] space-y-1">
        <div className="overflow-hidden rounded-2xl rounded-bl-sm bg-[#182533] text-sm text-white">
          {photoUrl && <img src={photoUrl} alt="Фотография сообщения" className="max-h-64 w-full object-cover" data-testid={`${testId}-photo`} />}
          <div className="px-3 py-2 whitespace-pre-wrap break-words" data-testid={`${testId}-text`}>
            {segments.length
              ? segments.map((s, i) =>
                  s.emojiId ? (
                    <span key={i} className="rounded-sm outline-1 outline-offset-1 outline-white/40 outline-dotted" title={`Premium Emoji · ID ${s.emojiId}`} data-testid={`${testId}-premium-emoji`}>
                      {s.text}
                    </span>
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )
              : ' '}
          </div>
        </div>
        {buttons.length > 0 && (
          <div className="grid gap-1">
            {buttons.map((b, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-center text-sm text-white',
                  b.muted ? 'bg-[#2b5278]/30 opacity-60' : 'bg-[#2b5278]/70',
                )}
                data-testid={`${testId}-button-${i + 1}`}
              >
                {b.emojiId && (
                  <span title={`Premium Emoji · ID ${b.emojiId}`} data-testid={`${testId}-button-${i + 1}-premium`}>
                    <SparkleIcon aria-label="Premium Emoji" weight="fill" className="size-3.5 text-[#6ab3f3]" />
                  </span>
                )}
                {b.text || '—'}
                {b.external && <ArrowSquareOutIcon aria-hidden className="size-3" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
