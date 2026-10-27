import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** Copies a link to the clipboard (falls back to a hidden textarea where the Clipboard API is unavailable). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyLinkButton({ url, label = 'Копировать ссылку', testId }: { url: string; label?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId}
      aria-label={`${label}: ${url}`}
      onClick={async () => {
        if (await copyText(url)) {
          setCopied(true);
          toast.success('Ссылка скопирована');
          window.setTimeout(() => setCopied(false), 1500);
        } else {
          toast.error('Не удалось скопировать. Выделите ссылку вручную.');
        }
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      {copied ? 'Скопировано' : label}
    </Button>
  );
}
