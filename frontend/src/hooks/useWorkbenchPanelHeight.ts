'use client';
import { useEffect, useRef } from 'react';
/** Account for banners above the panel so its sticky actions stay inside the viewport. */
export function useWorkbenchPanelHeight() {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = panel.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame = 0, previous = '';
    const measure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { const available = `${Math.max(260, Math.floor(window.innerHeight - Math.max(16,element.getBoundingClientRect().top) - 16))}px`; if (available !== previous) { element.style.setProperty('--wb-panel-height',available); previous = available; } }); };
    const observer = new ResizeObserver(measure); observer.observe(element.closest('.wb-main') || element.parentElement!); window.addEventListener('resize',measure); measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize',measure); };
  }, []);
  return panel;
}
