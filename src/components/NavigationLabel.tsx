import { useLayoutEffect, useRef } from 'react';
import type { Settings } from '../shared/model';

export function NavigationLabel({
  children,
  theme,
}: {
  children: string;
  theme?: Settings['theme'];
}) {
  const container = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const label = container.current!,
      content = text.current!;
    let frame: number | undefined,
      disposed = false;
    const fit = () => {
      if (!label.isConnected || !label.clientWidth) return;
      const width = content.getBoundingClientRect().width;
      if (!width) return;
      const maximum = parseFloat(getComputedStyle(label).fontSize);
      const current = parseFloat(getComputedStyle(content).fontSize);
      const size = Math.min(maximum, Math.max(10, (current * (label.clientWidth - 1)) / width));
      if (Math.abs(size - current) > 0.1) content.style.fontSize = `${size}px`;
    };
    const schedule = () => {
      if (disposed || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        fit();
      });
    };
    fit();
    // Apply size changes outside observer delivery to avoid resize-loop errors.
    const observer = new ResizeObserver(schedule);
    observer.observe(label);
    // Font swaps and active markers/counts can change the space needed independently.
    document.fonts.addEventListener('loadingdone', schedule);
    void document.fonts.ready.then(schedule);
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', schedule);
    };
  }, [children, theme]);
  return (
    <span ref={container} className="nav-label">
      <span ref={text}>{children}</span>
    </span>
  );
}
