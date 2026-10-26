import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Drawer({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); previous?.focus(); };
  }, []);
  return <><button className="av-drawer-backdrop" aria-label={'关闭' + title} onClick={onClose} /><aside ref={panel} role="dialog" aria-modal="true" aria-label={title} className={'av-story-drawer ' + (wide ? 'av-wide-drawer' : '')} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') || [])].filter(item => item.getClientRects().length > 0);
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><header><div><span className="av-eyebrow">{eyebrow}</span><h2>{title}</h2></div><button className="av-icon-button" aria-label={'关闭' + title} onClick={onClose}><X size={19} /></button></header><div className="av-drawer-body">{children}</div></aside></>;
}
