import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceWorkerManager } from '../ServiceWorkerManager';
const previous = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const installServiceWorker = () => {
  const serviceWorker = { register: vi.fn().mockResolvedValue({}), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  return serviceWorker;
};
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'novaDesktop');
  Reflect.deleteProperty(window, 'workbox');
  if (previous) Object.defineProperty(navigator, 'serviceWorker', previous);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
});
describe('runtime PWA registration', () => {
  it('does not register or subscribe to PWA events on desktop', () => {
    const serviceWorker = installServiceWorker();
    Object.defineProperty(window, 'novaDesktop', { configurable: true, value: { features: { serviceWorker: false } } });
    render(<ServiceWorkerManager />);
    expect(serviceWorker.register).not.toHaveBeenCalled();
    expect(serviceWorker.addEventListener).not.toHaveBeenCalled();
  });
  it('registers the Web PWA even when App Router has no Workbox global', () => {
    const serviceWorker = installServiceWorker();
    const view = render(<ServiceWorkerManager />);
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js');
    view.unmount();
    expect(serviceWorker.removeEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function));
  });
  it('uses Workbox when available and handles a failed registration', async () => {
    const serviceWorker = installServiceWorker();
    const register = vi.fn().mockRejectedValue(new Error('synthetic unavailable'));
    Object.defineProperty(window, 'workbox', { configurable: true, value: { register } });
    render(<ServiceWorkerManager />);
    await waitFor(() => expect(register).toHaveBeenCalledOnce());
    expect(serviceWorker.register).not.toHaveBeenCalled();
  });
});
