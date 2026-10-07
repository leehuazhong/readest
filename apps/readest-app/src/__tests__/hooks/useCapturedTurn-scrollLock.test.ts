import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { FoliateView } from '@/types/view';
import type { ViewSettings } from '@/types/book';
import type { TouchDetail } from '@/app/reader/hooks/useTouchInterceptor';
import { CURL_ROLL_BACKWARD, curlFoldFromFinger } from '@/utils/pageCurl';

// The captured page-turn (slide/curl) swipe is handled by an app-side touch
// interceptor because `no-swipe` disables the paginator's own swipe. Push mode
// stays on the paginator's native swipe, which bows out while `scrollLocked`
// is set (instant highlight engaged). This test pins the captured turn to the
// same gate so a hold-then-swipe extends the highlight instead of paginating.
const h = vi.hoisted(() => ({
  controllerHost: null as null | {
    onBeforeCapture?: (style: 'curl' | 'slide') => Promise<void> | void;
    onCovered?: (style: 'curl' | 'slide', surfaceAlreadyPainted?: boolean) => Promise<void> | void;
    onCancelled?: (style: 'curl' | 'slide') => Promise<void> | void;
    preparePixelCapture?: () =>
      | void
      | (() => void | Promise<void>)
      | Promise<void | (() => void | Promise<void>)>;
  },
  hoveredBookKey: 'book-1' as string | null,
  setHoveredBookKey: vi.fn(),
  settingsDialogOpen: false,
  settingsListeners: new Set<
    (state: { isSettingsDialogOpen: boolean }, previous: { isSettingsDialogOpen: boolean }) => void
  >(),
  controller: {
    turn: vi.fn(async () => {}),
    beginDrag: vi.fn(async () => true),
    moveDrag: vi.fn(),
    endDrag: vi.fn(async () => {}),
    prepareCapture: vi.fn(async () => true),
    retainPreparedCapture: vi.fn(),
    releasePreparedCapture: vi.fn(),
    invalidatePreparedCapture: vi.fn(),
    invalidatePendingPreparedCapture: vi.fn(),
    dispose: vi.fn(),
  },
  viewListeners: new Map<string, Set<EventListener>>(),
  selection: null as { rangeCount: number; isCollapsed: boolean } | null,
  renderer: {
    listeners: new Map<string, Set<EventListener>>(),
    scrollLocked: false,
    atEnd: false,
    atStart: false,
    primaryIndex: 0,
    getContents() {
      return [{ index: 0, doc: { getSelection: () => h.selection } }];
    },
    getAttribute: vi.fn(() => null as string | null),
    hasAttribute: () => false,
    setAttribute: () => {},
    removeAttribute: () => {},
    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? new Set<EventListener>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: EventListener) {
      this.listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: Event) {
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    },
  },
  viewSettings: {
    pageTurnStyle: 'curl',
    animated: true,
    scrolled: false,
    disableSwipe: false,
    isEink: false,
    rtl: false,
  } as ViewSettings,
}));

vi.mock('@/store/readerStore', () => {
  const useReaderStore = () => ({
    getViewSettings: () => h.viewSettings,
    setHoveredBookKey: h.setHoveredBookKey,
  });
  useReaderStore.getState = () => ({
    hoveredBookKey: h.hoveredBookKey,
    bottomBarTab: '',
    viewStates: { 'book-1': { inited: true, ttsEnabled: false } },
  });
  useReaderStore.subscribe = () => () => {};
  return { useReaderStore };
});
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData: () => ({ isFixedLayout: false }) }),
}));
vi.mock('@/store/settingsStore', () => {
  const useSettingsStore = () => ({ isSettingsDialogOpen: h.settingsDialogOpen });
  useSettingsStore.getState = () => ({ isSettingsDialogOpen: h.settingsDialogOpen });
  useSettingsStore.subscribe = (
    listener: (
      state: { isSettingsDialogOpen: boolean },
      previous: { isSettingsDialogOpen: boolean },
    ) => void,
  ) => {
    h.settingsListeners.add(listener);
    return () => h.settingsListeners.delete(listener);
  };
  return { useSettingsStore };
});
vi.mock('@/utils/bridge', () => ({ captureWebviewRegion: vi.fn() }));
vi.mock('@/utils/viewTransition', () => ({ detectViewTransitionGroup: () => false }));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri',
  getInitializedAppService: () => ({
    isMobileApp: process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri',
    isMacOSApp: false,
  }),
}));
vi.mock('@/app/reader/utils/capturedTurn', () => ({
  CapturedPageTurn: class {
    constructor(host: NonNullable<typeof h.controllerHost>) {
      h.controllerHost = host;
      Object.assign(this, h.controller);
    }
  },
}));

import { useCapturedTurn } from '@/app/reader/hooks/useCapturedTurn';
import { dispatchTouchInterceptors } from '@/app/reader/hooks/useTouchInterceptor';

const makeView = () =>
  ({
    renderer: h.renderer,
    prev: vi.fn(),
    next: vi.fn(),
    addEventListener(type: string, listener: EventListener) {
      const listeners = h.viewListeners.get(type) ?? new Set<EventListener>();
      listeners.add(listener);
      h.viewListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: EventListener) {
      h.viewListeners.get(type)?.delete(listener);
    },
  }) as unknown as FoliateView;

const detail = (
  phase: TouchDetail['phase'],
  deltaX = 0,
  deltaY = 0,
  deltaT = 16,
  startX = 0,
  startY = 0,
): TouchDetail => ({
  phase,
  touch: { screenX: startX + deltaX, screenY: deltaY },
  touchStart: { screenX: startX, screenY: startY },
  deltaX,
  deltaY,
  deltaT,
});

const setSettingsDialogOpen = (open: boolean) => {
  const previous = { isSettingsDialogOpen: h.settingsDialogOpen };
  h.settingsDialogOpen = open;
  const state = { isSettingsDialogOpen: open };
  for (const listener of h.settingsListeners) listener(state, previous);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.controller.beginDrag.mockResolvedValue(true);
  h.setHoveredBookKey.mockReset();
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
  h.renderer.scrollLocked = false;
  h.renderer.atEnd = false;
  h.renderer.atStart = false;
  h.renderer.getAttribute.mockReset().mockReturnValue(null);
  h.selection = null;
  h.viewListeners.clear();
  h.renderer.listeners.clear();
  h.controllerHost = null;
  h.hoveredBookKey = 'book-1';
  h.settingsDialogOpen = false;
  h.settingsListeners.clear();
  h.viewSettings.pageTurnStyle = 'curl';
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  document.documentElement.classList.remove('captured-turn-filter-transient-overlays');
  document.getElementById('gridcell-book-1')?.remove();
  document.querySelectorAll('[data-capture-blocking-test]').forEach((element) => element.remove());
  cleanup();
});

describe('useCapturedTurn scroll-lock gate', () => {
  test('starts an eligible snapshot warm-up immediately on touchstart', () => {
    h.viewSettings.pageTurnStyle = 'slide';
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));

    expect(h.controller.retainPreparedCapture).toHaveBeenCalledOnce();
    expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
    expect(h.controller.prepareCapture).toHaveBeenCalledWith('slide');
    expect(h.controller.beginDrag).not.toHaveBeenCalled();
    expect(h.controller.releasePreparedCapture.mock.invocationCallOrder[0]).toBeLessThan(
      h.controller.retainPreparedCapture.mock.invocationCallOrder[0]!,
    );
    expect(h.controller.retainPreparedCapture.mock.invocationCallOrder[0]).toBeLessThan(
      h.controller.prepareCapture.mock.invocationCallOrder[0]!,
    );
  });

  test('invalidates around Settings and never prepares a modal-covered snapshot', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    setSettingsDialogOpen(true);
    expect(h.controller.invalidatePreparedCapture).toHaveBeenCalledOnce();

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(h.controller.retainPreparedCapture).not.toHaveBeenCalled();
    expect(h.controller.prepareCapture).not.toHaveBeenCalled();

    setSettingsDialogOpen(false);
    // Opening invalidates immediately and the blocked touch defensively clears
    // any surface that raced the overlay observer. Closing keeps the empty
    // slot and schedules a post-paint replacement without another epoch bump.
    expect(h.controller.invalidatePreparedCapture).toHaveBeenCalledTimes(2);

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(h.controller.retainPreparedCapture).toHaveBeenCalledOnce();
    expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
  });

  test('pauses idle preparation until Settings has closed and repainted', async () => {
    vi.useFakeTimers();
    h.settingsDialogOpen = true;
    const { unmount } = renderHook(() => useCapturedTurn('book-1', { current: makeView() }));
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(h.controller.prepareCapture).not.toHaveBeenCalled();

      act(() => setSettingsDialogOpen(false));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
      expect(h.controller.prepareCapture).toHaveBeenCalledWith('curl');
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  test('invalidates and pauses preparation for a semantic modal outside Settings', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useCapturedTurn('book-1', { current: makeView() }));
    const dialog = document.createElement('div');
    dialog.setAttribute('data-capture-blocking-test', '');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    try {
      await act(async () => {
        document.body.appendChild(dialog);
        await Promise.resolve();
      });
      expect(h.controller.invalidatePreparedCapture).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(h.controller.prepareCapture).not.toHaveBeenCalled();

      await act(async () => {
        dialog.remove();
        await Promise.resolve();
      });
      expect(h.controller.invalidatePreparedCapture).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
      expect(h.controller.prepareCapture).toHaveBeenCalledWith('curl');
    } finally {
      dialog.remove();
      unmount();
      vi.useRealTimers();
    }
  });

  test('does not warm a surface while a host popup is expanded', async () => {
    const popupTrigger = document.createElement('button');
    popupTrigger.setAttribute('data-capture-blocking-test', '');
    popupTrigger.setAttribute('aria-haspopup', 'menu');
    popupTrigger.setAttribute('aria-expanded', 'true');
    document.body.appendChild(popupTrigger);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(h.controller.retainPreparedCapture).not.toHaveBeenCalled();
    expect(h.controller.prepareCapture).not.toHaveBeenCalled();
    expect(dispatchTouchInterceptors('book-1', detail('move', -30, 0, 16, 150))).toBe(false);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();

    await act(async () => {
      popupTrigger.setAttribute('aria-expanded', 'false');
      await Promise.resolve();
    });
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(h.controller.retainPreparedCapture).toHaveBeenCalledOnce();
    expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
  });

  test('does not treat a closed offscreen popup container as a blocking overlay', () => {
    const closedPopup = document.createElement('div');
    closedPopup.setAttribute('data-capture-blocking-test', '');
    closedPopup.className = 'popup-container';
    closedPopup.setAttribute('aria-hidden', 'true');
    document.body.appendChild(closedPopup);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));

    expect(h.controller.retainPreparedCapture).toHaveBeenCalledOnce();
    expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
  });

  test('blocks explicit capture overlays until their visible marker is removed', async () => {
    const viewer = document.createElement('div');
    viewer.setAttribute('data-capture-blocking-test', '');
    viewer.setAttribute('data-capture-blocking-overlay', 'true');
    document.body.appendChild(viewer);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(h.controller.prepareCapture).not.toHaveBeenCalled();

    await act(async () => {
      viewer.removeAttribute('data-capture-blocking-overlay');
      await Promise.resolve();
    });
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));

    expect(h.controller.retainPreparedCapture).toHaveBeenCalledOnce();
    expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
  });

  test('invalidates for a transient toast without swallowing the page-turn gesture', () => {
    const toast = document.createElement('div');
    toast.setAttribute('data-capture-blocking-test', '');
    toast.setAttribute('data-capture-invalidating-overlay', 'true');
    document.body.appendChild(toast);
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(h.controller.invalidatePendingPreparedCapture).toHaveBeenCalledOnce();
    expect(h.controller.invalidatePreparedCapture).not.toHaveBeenCalled();
    expect(h.controller.retainPreparedCapture).not.toHaveBeenCalled();
    expect(h.controller.prepareCapture).not.toHaveBeenCalled();

    expect(dispatchTouchInterceptors('book-1', detail('move', -30, 0, 16, 150))).toBe(true);
    expect(h.controller.beginDrag).toHaveBeenCalledWith(true, false, 'curl');
  });

  test('reference-counts overlapping native pixel filters', async () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    const releaseA = await h.controllerHost!.preparePixelCapture!();
    const releaseB = await h.controllerHost!.preparePixelCapture!();
    expect(
      document.documentElement.classList.contains('captured-turn-filter-transient-overlays'),
    ).toBe(true);

    await releaseA?.();
    expect(
      document.documentElement.classList.contains('captured-turn-filter-transient-overlays'),
    ).toBe(true);

    await releaseB?.();
    expect(
      document.documentElement.classList.contains('captured-turn-filter-transient-overlays'),
    ).toBe(false);
  });

  test('removes a stalled native pixel filter after its safety timeout', async () => {
    vi.useFakeTimers();
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    await h.controllerHost!.preparePixelCapture!();
    expect(
      document.documentElement.classList.contains('captured-turn-filter-transient-overlays'),
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      document.documentElement.classList.contains('captured-turn-filter-transient-overlays'),
    ).toBe(false);
  });

  test('falls back without a captured surface for a programmatic turn under an overlay', async () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('data-capture-blocking-test', '');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);
    const view = makeView();
    const originalNext = view.next as ReturnType<typeof vi.fn>;
    renderHook(() => useCapturedTurn('book-1', { current: view }));

    await view.next();

    expect(originalNext).toHaveBeenCalledOnce();
    expect(h.controller.turn).not.toHaveBeenCalled();
  });

  test.each(['end', 'cancel'] as const)('releases an unclaimed touch lease on %s', (phase) => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    dispatchTouchInterceptors('book-1', detail(phase, 2, 0, 16, 150));

    // Once before acquiring the new lease, once when the unclaimed touch
    // ends. No drag controller lifecycle was started.
    expect(h.controller.releasePreparedCapture).toHaveBeenCalledTimes(2);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();
    expect(h.controller.endDrag).not.toHaveBeenCalled();
  });

  test('a replacement touch releases the previous lease before retaining the next one', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));

    expect(h.controller.releasePreparedCapture).toHaveBeenCalledTimes(2);
    expect(h.controller.retainPreparedCapture).toHaveBeenCalledTimes(2);
    expect(h.controller.releasePreparedCapture.mock.invocationCallOrder[1]).toBeLessThan(
      h.controller.retainPreparedCapture.mock.invocationCallOrder[1]!,
    );
  });

  test('does not speculatively capture a touch reserved for the brightness strip', () => {
    h.renderer.getAttribute.mockReturnValue('0.1');
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 10));

    expect(h.controller.retainPreparedCapture).not.toHaveBeenCalled();
    expect(h.controller.prepareCapture).not.toHaveBeenCalled();
    expect(h.controller.invalidatePreparedCapture).toHaveBeenCalledOnce();
  });

  test('claims the first inward sample from the right edge', () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 285));
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -1, 0, 16, 285));

    expect(consumed).toBe(true);
    expect(h.controller.beginDrag).toHaveBeenCalledWith(true, false, 'curl');
  });

  test('an edge claim at a boundary cannot reverse into a second turn', () => {
    h.renderer.atEnd = true;
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 285));
    expect(dispatchTouchInterceptors('book-1', detail('move', -1, 0, 16, 285))).toBe(true);
    expect(dispatchTouchInterceptors('book-1', detail('move', 30, 0, 32, 285))).toBe(false);

    expect(h.controller.beginDrag).not.toHaveBeenCalled();
    expect(h.controller.releasePreparedCapture).toHaveBeenCalledTimes(2);
  });

  test('claims a central drag after two coherent samples at 6px', () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(dispatchTouchInterceptors('book-1', detail('move', -3, 0, 16, 150))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', -6, 0, 32, 150))).toBe(true);

    expect(h.controller.beginDrag).toHaveBeenCalledWith(true, false, 'curl');
  });

  test('starts a claimed Slide flat and follows only post-claim finger travel', () => {
    h.viewSettings.pageTurnStyle = 'slide';
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    dispatchTouchInterceptors('book-1', detail('move', -3, 0, 16, 150));
    dispatchTouchInterceptors('book-1', detail('move', -6, 0, 32, 150));

    expect(h.controller.beginDrag).toHaveBeenCalledWith(true, false, 'slide');
    expect(h.controller.moveDrag).toHaveBeenLastCalledWith(0, 0.5, null, null);

    dispatchTouchInterceptors('book-1', detail('move', -36, 0, 48, 150));
    expect(h.controller.moveDrag).toHaveBeenLastCalledWith(30 / 300, 0.5, null, null);
  });

  test('keeps a short Slide flick visually flat at claim but uses its full release intent', () => {
    h.viewSettings.pageTurnStyle = 'slide';
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(dispatchTouchInterceptors('book-1', detail('move', -30, 0, 16, 150))).toBe(true);

    expect(h.controller.beginDrag).toHaveBeenCalledWith(true, false, 'slide');
    expect(h.controller.moveDrag).toHaveBeenLastCalledWith(0, 0.5, null, null);

    expect(dispatchTouchInterceptors('book-1', detail('end', -30, 0, 16, 150))).toBe(true);
    expect(h.controller.endDrag).toHaveBeenCalledWith(true, expect.any(Number));
  });

  test('does not use the central fast path for an outward edge drag', () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 45));
    expect(dispatchTouchInterceptors('book-1', detail('move', -3, 0, 16, 45))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', -6, 0, 32, 45))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', -15, 0, 48, 45))).toBe(true);

    expect(h.controller.beginDrag).toHaveBeenCalledTimes(1);
  });

  test('does not combine coherent samples separated by more than 80ms', () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(dispatchTouchInterceptors('book-1', detail('move', -3, 0, 16, 150))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', -6, 0, 120, 150))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', -9, 0, 136, 150))).toBe(true);

    expect(h.controller.beginDrag).toHaveBeenCalledTimes(1);
  });

  test('does not early-claim inside the left brightness strip', () => {
    h.renderer.getAttribute.mockReturnValue('0.1');
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 10));
    expect(dispatchTouchInterceptors('book-1', detail('move', 3, 0, 16, 10))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', 6, 0, 32, 10))).toBe(false);

    expect(h.controller.beginDrag).not.toHaveBeenCalled();
  });

  test('uses the 24px fallback inside the left brightness strip', () => {
    h.renderer.getAttribute.mockReturnValue('0.1');
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 10));
    expect(dispatchTouchInterceptors('book-1', detail('move', 15, 0, 16, 10))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', 23, 0, 32, 10))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', 24, 0, 48, 10))).toBe(true);

    expect(h.controller.beginDrag).toHaveBeenCalledTimes(1);
  });

  test('does not claim after a central gesture locks vertically', () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(dispatchTouchInterceptors('book-1', detail('move', -4, 0, 16, 150))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', -4, -10, 32, 150))).toBe(false);
    expect(dispatchTouchInterceptors('book-1', detail('move', -30, -10, 48, 150))).toBe(false);

    expect(h.controller.beginDrag).not.toHaveBeenCalled();
  });

  test('a horizontal swipe starts the captured turn when scroll is not locked', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 3));

    expect(consumed).toBe(true);
    expect(h.controller.beginDrag).toHaveBeenCalled();
  });

  test('catches the captured drag up to the activation-threshold distance', async () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    dispatchTouchInterceptors('book-1', detail('move', -15, 0, 16, 150));
    await act(async () => {
      await Promise.resolve();
    });

    const [progress, grabY, fold] = h.controller.moveDrag.mock.calls.at(-1)!;
    // The fold pivots on the held page edge at the height the reader touched,
    // and the finger is that pivot carried by the gesture — so the distance
    // consumed during gesture recognition is part of the fold, not dropped.
    expect(fold).toEqual({
      corner: { x: 1, y: 0 },
      finger: { x: 1 - 15 / window.innerWidth, y: 0 },
    });
    // The painted sweep is the crease's own position, which for a straight
    // fold only covers half the finger's travel.
    expect(progress).toBeCloseTo(
      curlFoldFromFinger(window.innerWidth, window.innerHeight, fold!)!.progress,
      6,
    );
    expect(grabY).toBe(0.5);
  });

  test('preserves total travel when horizontal intent is recognized later', async () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    dispatchTouchInterceptors('book-1', detail('move', -4, 6, 16, 150));
    expect(h.controller.beginDrag).not.toHaveBeenCalled();

    dispatchTouchInterceptors('book-1', detail('move', -100, 80, 32, 150));
    await act(async () => {
      await Promise.resolve();
    });

    const [, , fold] = h.controller.moveDrag.mock.calls.at(-1)!;
    // The fold pivots where the gesture began, so all 100px of travel counts
    // even though the first samples were only recognised later.
    expect(fold).toEqual({
      corner: { x: 1, y: 0 },
      finger: { x: 1 - 100 / window.innerWidth, y: 80 / window.innerHeight },
    });
  });

  test('pulls a curl drag back so the crease cannot lift the far corners', async () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 640));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    // Hold the edge at 58% height and stray down-left. Unclamped, this crease
    // runs corner to corner and folds the far half of the sheet over itself.
    const corner = { x: 1, y: 374 / 640 };
    const raw = { x: 1 - 70 / 320, y: 429 / 640 };
    const rawFold = curlFoldFromFinger(320, 640, { finger: raw, corner })!;
    const side = (fold: NonNullable<typeof rawFold>, point: [number, number]) =>
      (point[0] - fold.fold[0]) * fold.dir[0] + (point[1] - fold.fold[1]) * fold.dir[1];
    expect(side(rawFold, [0, 0])).toBeGreaterThan(0);

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150, 374));
    dispatchTouchInterceptors('book-1', detail('move', -70, 55, 16, 150, 374));
    await act(async () => {
      await Promise.resolve();
    });

    const [progress, , fold] = h.controller.moveDrag.mock.calls.at(-1)!;
    // The fold survives — it is pulled back along its own ray, so the crease
    // angle is the reader's — but no far corner may end up on the folded side.
    expect(fold).not.toBeNull();
    const solved = curlFoldFromFinger(320, 640, fold!)!;
    expect(side(solved, [0, 0])).toBeLessThanOrEqual(1e-6);
    expect(side(solved, [0, 640])).toBeLessThanOrEqual(1e-6);
    expect(fold!.finger.x).toBeGreaterThan(raw.x);
    // The painted sweep is still the crease's own position, so a release
    // settles from where the sheet actually is.
    expect(progress).toBeCloseTo(solved.progress, 6);
  });

  test('folds nothing when a stray curl drag has no legal crease left', async () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 640));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    // A horizontal-dominant drag (so the turn is claimed) from low on the held
    // edge, angled down: every crease direction left would hinge the sheet on
    // the far corner, so the sheet stays put instead of folding somewhere it
    // cannot.
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150, 500));
    dispatchTouchInterceptors('book-1', detail('move', -100, 80, 16, 150, 500));
    await act(async () => {
      await Promise.resolve();
    });

    expect(h.controller.beginDrag).toHaveBeenCalled();
    const [progress, , fold] = h.controller.moveDrag.mock.calls.at(-1)!;
    // Nothing is folded, so the frame goes to the swept model: a release that
    // still commits the turn animates rather than sitting flat.
    expect(fold).toBeNull();
    expect(progress).toBe(0);
  });

  test('scripts a backward curl drag into a vertical crease with its own roll', async () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 640));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    // A reverse swipe (rightward in an LTR book) that arcs well off the row:
    // a finger-solved crease would go diagonal here, which is the whole reason
    // reversing gets its own, always-vertical crease.
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 40, 380));
    dispatchTouchInterceptors('book-1', detail('move', 160, 120, 16, 40, 380));
    await act(async () => {
      await Promise.resolve();
    });

    const [progress, , fold, roll] = h.controller.moveDrag.mock.calls.at(-1)!;
    expect(roll).toEqual(CURL_ROLL_BACKWARD);
    const solved = curlFoldFromFinger(320, 640, fold!)!;
    // The crease is vertical: its normal has no vertical component at all.
    expect(Math.abs(solved.dir[0])).toBeCloseTo(1, 6);
    expect(solved.dir[1]).toBeCloseTo(0, 6);
    // ...and it follows the horizontal drag one to one: 160px across a 320px
    // page puts the crease at the middle, not at a quarter as a bisector would.
    expect(solved.fold[0]).toBeCloseTo(160, 6);
    expect(progress).toBeCloseTo(160 / 320, 6);
  });

  test('forwards the latest sample before queueing release while capture is pending', async () => {
    let finishCapture!: (ok: boolean) => void;
    h.controller.beginDrag.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishCapture = resolve)),
    );
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -15, 0, 16));
    dispatchTouchInterceptors('book-1', detail('move', -240, 10, 32));
    const released = dispatchTouchInterceptors('book-1', detail('end', -240, 10, 48));

    expect(released).toBe(true);
    expect(h.controller.endDrag).toHaveBeenCalledWith(true, 5);
    const [progress, grabY, fold] = h.controller.moveDrag.mock.calls.at(-1)!;
    // All 240px of travel across the 300px captured reader cell is the finger
    // the pending capture will be revealed at.
    expect(fold).toEqual({
      corner: { x: 1, y: 0 },
      finger: { x: 1 - 240 / 300, y: 10 / 500 },
    });
    expect(progress).toBeCloseTo(curlFoldFromFinger(300, 500, fold!)!.progress, 6);
    expect(grabY).toBeCloseTo(0.52);
    expect(h.controller.moveDrag.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      h.controller.endDrag.mock.invocationCallOrder[0]!,
    );

    await act(async () => {
      finishCapture(true);
      await Promise.resolve();
    });
  });

  test('commits a short fast flick before halfway', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    dispatchTouchInterceptors('book-1', detail('move', -20, 0, 16, 150));
    dispatchTouchInterceptors('book-1', detail('end', -20, 0, 50, 150));

    // 20px / 50ms = 0.4px/ms, above the 0.3 flick threshold.
    expect(h.controller.endDrag).toHaveBeenCalledWith(true, 0.4);
  });

  test('commits a slow curl drag past halfway even though a fold sweeps only half of it', () => {
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    // 160px across the 300px reader cell, taken slowly: nowhere near the flick
    // threshold, so the commit has to come from the gesture distance.
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    dispatchTouchInterceptors('book-1', detail('move', -160, 0, 900, 150));
    const [, , fold] = h.controller.moveDrag.mock.calls.at(-1)!;
    // The same gesture only folds a third of the sheet, which is well under the
    // halfway bar: intent and sweep are deliberately different numbers.
    expect(curlFoldFromFinger(300, 500, fold!)!.progress).toBeLessThan(0.4);
    dispatchTouchInterceptors('book-1', detail('end', -160, 0, 920, 150));

    expect(h.controller.endDrag).toHaveBeenCalledWith(true, expect.any(Number));
  });

  test('lets distance and sub-flick release speed combine to commit a Slide', () => {
    h.viewSettings.pageTurnStyle = 'slide';
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -102, 0, 310));
    dispatchTouchInterceptors('book-1', detail('move', -102, 0, 410));
    dispatchTouchInterceptors('book-1', detail('end', -120, 0, 500));

    // Neither 40% distance nor 0.2px/ms speed passes the old independent
    // threshold. Together they project to 56%, so the Slide commits.
    expect(h.controller.endDrag).toHaveBeenCalledWith(true, 0.2);
  });

  test('cancels a rested Slide below halfway', () => {
    h.viewSettings.pageTurnStyle = 'slide';
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -108, 0, 500));
    dispatchTouchInterceptors('book-1', detail('end', -108, 0, 600));

    expect(h.controller.endDrag).toHaveBeenCalledWith(false, 0);
  });

  test('lets a sub-flick reverse release pull projected Slide progress back', () => {
    h.viewSettings.pageTurnStyle = 'slide';
    const cell = document.createElement('div');
    cell.id = 'gridcell-book-1';
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500));
    document.body.appendChild(cell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -174, 0, 410));
    dispatchTouchInterceptors('book-1', detail('move', -174, 0, 510));
    dispatchTouchInterceptors('book-1', detail('end', -165, 0, 600));

    // Distance alone is 55%, but projecting the -0.1px/ms release returns it
    // to 47%, so the Slide cancels.
    expect(h.controller.endDrag).toHaveBeenCalledWith(false, -0.1);
  });

  test("uses recent release velocity without changing Curl's full-gesture commit rule", () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -40, 0, 200));
    dispatchTouchInterceptors('book-1', detail('move', -40, 0, 300));
    dispatchTouchInterceptors('book-1', detail('end', -120, 0, 340));

    // Commit still uses 120px / 340ms; settle momentum uses the latest
    // 80px of movement inside the interpolated 90ms release window.
    expect(h.controller.endDrag).toHaveBeenCalledWith(true, 80 / 90);
  });

  test('drops release momentum after the finger pauses for more than 80ms', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -120, 0, 40));
    dispatchTouchInterceptors('book-1', detail('end', -120, 0, 130));

    expect(h.controller.endDrag).toHaveBeenCalledWith(true, 0);
  });

  test('passes a reverse release velocity to a cancelling settle', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -120, 0, 40));
    dispatchTouchInterceptors('book-1', detail('move', -120, 0, 100));
    dispatchTouchInterceptors('book-1', detail('end', -40, 0, 140));

    expect(h.controller.endDrag).toHaveBeenCalledWith(false, -80 / 90);
  });

  test('cancels an unfinished drag before accepting a replacement touch sequence', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -60, 0));
    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -60, 0));

    expect(h.controller.beginDrag).toHaveBeenCalledTimes(2);
    expect(h.controller.endDrag).toHaveBeenCalledWith(false);
    expect(h.controller.endDrag.mock.invocationCallOrder[0]!).toBeLessThan(
      h.controller.beginDrag.mock.invocationCallOrder[1]!,
    );
  });

  test('an accepted programmatic turn permanently rejects a pending touch sequence', () => {
    const view = makeView();
    renderHook(() => useCapturedTurn('book-1', { current: view }));

    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    void view.next();
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 0, 16, 150));

    expect(h.controller.turn).toHaveBeenCalledWith(true, false, 'curl');
    expect(consumed).toBe(false);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();
  });

  test('a touch that starts during a programmatic turn stays rejected until its release', async () => {
    let resolveTurn!: () => void;
    h.controller.turn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveTurn = resolve;
        }),
    );
    const view = makeView();
    renderHook(() => useCapturedTurn('book-1', { current: view }));

    const turning = view.next() as unknown as Promise<void>;
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(dispatchTouchInterceptors('book-1', detail('move', -60, 0, 16, 150))).toBe(false);

    resolveTurn();
    await act(async () => turning);
    expect(dispatchTouchInterceptors('book-1', detail('move', -90, 0, 32, 150))).toBe(false);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();

    dispatchTouchInterceptors('book-1', detail('end', -90, 0, 48, 150));
    dispatchTouchInterceptors('book-1', detail('start', 0, 0, 0, 150));
    expect(dispatchTouchInterceptors('book-1', detail('move', -60, 0, 16, 150))).toBe(true);
    expect(h.controller.beginDrag).toHaveBeenCalledOnce();
  });

  test('touch cancellation always reverses an active captured drag', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    dispatchTouchInterceptors('book-1', detail('move', -60, 3));
    const consumed = dispatchTouchInterceptors('book-1', detail('cancel', -60, 3));

    expect(consumed).toBe(true);
    expect(h.controller.endDrag).toHaveBeenCalledWith(false);
  });

  test('scroll lock (instant highlight engaged) leaves the swipe to the highlight', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    // Instant highlight has engaged after the still-hold: it locks scrolling.
    h.renderer.scrollLocked = true;
    dispatchTouchInterceptors('book-1', detail('start'));
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 3));

    expect(consumed).toBe(false);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();
    expect(h.controller.invalidatePreparedCapture).toHaveBeenCalledOnce();
  });

  // Non-instant selection: a long-press selection (or a drag of its handles)
  // moves the finger horizontally without engaging scrollLocked. The push
  // paginator's native swipe bows out when the primary document holds a
  // non-collapsed selection (#onTouchMove); the captured slide/curl
  // interceptor must honor the same gate or it turns the page mid-selection
  // (iOS 18.7, where slide/curl always take the captured path).
  test('an active text selection leaves the swipe to the selection', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    h.selection = { rangeCount: 1, isCollapsed: false };
    dispatchTouchInterceptors('book-1', detail('start'));
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 3));

    expect(consumed).toBe(false);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();
    expect(h.controller.invalidatePreparedCapture).toHaveBeenCalledOnce();
  });

  test('a collapsed selection does not block the captured turn', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    h.selection = { rangeCount: 1, isCollapsed: true };
    dispatchTouchInterceptors('book-1', detail('start'));
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 3));

    expect(consumed).toBe(true);
    expect(h.controller.beginDrag).toHaveBeenCalled();
  });

  // A drag of the system selection handles adjusts the selection; app code can
  // deselect mid-drag (the instant quick action dismisses on selectionchange),
  // and on iOS WebKit the native handle drag re-confirms the selection right
  // after. The collapsed-selection window between the two must not let the
  // handle drag morph into a page turn: a gesture that began with an active
  // selection is a selection gesture for its whole lifetime.
  test('a gesture that starts with a selection never turns, even if deselected mid-drag', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    h.selection = { rangeCount: 1, isCollapsed: false };
    dispatchTouchInterceptors('book-1', detail('start'));
    // Mid-gesture deselect (e.g. the quick action's dismiss).
    h.selection = null;
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 3));

    expect(consumed).toBe(false);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();
  });

  test('the selection latch clears on the next gesture', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    h.selection = { rangeCount: 1, isCollapsed: false };
    dispatchTouchInterceptors('book-1', detail('start'));
    h.selection = null;
    dispatchTouchInterceptors('book-1', detail('end', -60, 3));

    // A fresh gesture with no selection swipes normally.
    dispatchTouchInterceptors('book-1', detail('start'));
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 3));

    expect(consumed).toBe(true);
    expect(h.controller.beginDrag).toHaveBeenCalled();
  });

  // Instant highlighting locks scrolling for the drag and unlocks at release —
  // but the unlock runs before the gesture's queued trailing touchmoves are
  // delivered, and their deltas span the whole highlight stroke. A gesture
  // that was ever blocked by the lock must stay claimed to its end, or those
  // trailing moves read as a full swipe and start a stray captured drag whose
  // endDrag races the capture (the stranded-overlay bug).
  test('a gesture ever blocked by scroll lock never turns, even after unlock', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    h.renderer.scrollLocked = true;
    dispatchTouchInterceptors('book-1', detail('move', -30, 3));
    // Instant highlight released: unlocked before the queued moves arrive.
    h.renderer.scrollLocked = false;
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -70, 3));

    expect(consumed).toBe(false);
    expect(h.controller.beginDrag).not.toHaveBeenCalled();
  });

  test('the scroll-lock claim clears on the next gesture', () => {
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    dispatchTouchInterceptors('book-1', detail('start'));
    h.renderer.scrollLocked = true;
    dispatchTouchInterceptors('book-1', detail('move', -30, 3));
    h.renderer.scrollLocked = false;
    dispatchTouchInterceptors('book-1', detail('end', -70, 3));

    dispatchTouchInterceptors('book-1', detail('start'));
    const consumed = dispatchTouchInterceptors('book-1', detail('move', -60, 3));

    expect(consumed).toBe(true);
    expect(h.controller.beginDrag).toHaveBeenCalled();
  });

  test.each([
    'curl',
    'slide',
  ] as const)('hides live toolbar without transitions once the %s snapshot covers it', async (style) => {
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    h.setHoveredBookKey.mockImplementationOnce(() => {
      expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);
    });
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    await act(async () => {
      await h.controllerHost?.onBeforeCapture?.(style);
      await h.controllerHost?.onCovered?.(style);
    });

    expect(h.setHoveredBookKey).toHaveBeenCalledWith(null);
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(false);
  });

  test.each([
    'curl',
    'slide',
  ] as const)('restores a previously visible toolbar when a %s turn is cancelled', async (style) => {
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    await act(async () => {
      await h.controllerHost?.onBeforeCapture?.(style);
      await h.controllerHost?.onCovered?.(style);
      await h.controllerHost?.onCancelled?.(style);
    });

    expect(h.setHoveredBookKey.mock.calls).toEqual([[null], ['book-1']]);
  });

  test('does not show the toolbar after cancellation when it started hidden', async () => {
    h.hoveredBookKey = null;
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    await act(async () => {
      await h.controllerHost?.onBeforeCapture?.('curl');
      await h.controllerHost?.onCovered?.('curl');
      await h.controllerHost?.onCancelled?.('curl');
    });

    expect(h.setHoveredBookKey).not.toHaveBeenCalled();
  });

  test('restores the toolbar state captured before the snapshot starts', async () => {
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    await act(async () => {
      await h.controllerHost?.onBeforeCapture?.('curl');
      // A later event must not overwrite the gesture's original UI state.
      h.hoveredBookKey = null;
      await h.controllerHost?.onCovered?.('curl');
      await h.controllerHost?.onCancelled?.('curl');
    });

    expect(h.setHoveredBookKey.mock.calls).toEqual([[null], ['book-1']]);
  });

  test('paints the snapshot before hiding chrome and keeps transitions disabled for a painted frame', async () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    try {
      await h.controllerHost?.onBeforeCapture?.('curl');
      const covered = Promise.resolve(h.controllerHost?.onCovered?.('curl'));

      // The live toolbar must remain untouched until the flat snapshot has
      // survived a rendering opportunity.
      expect(h.setHoveredBookKey).not.toHaveBeenCalled();
      frames.shift()?.(16);
      await Promise.resolve();
      expect(h.setHoveredBookKey).not.toHaveBeenCalled();
      frames.shift()?.(32);
      await Promise.resolve();

      expect(h.setHoveredBookKey).toHaveBeenCalledWith(null);
      expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);

      // Keep transition:none through another painted frame before restoring
      // the normal CSS transition declaration.
      frames.shift()?.(48);
      await Promise.resolve();
      expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);
      frames.shift()?.(64);
      await covered;
      expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(false);
    } finally {
      raf.mockRestore();
    }
  });

  test('a pre-painted surface hides live chrome without another cover wait', async () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    try {
      await h.controllerHost?.onBeforeCapture?.('slide');
      await h.controllerHost?.onCovered?.('slide', true);

      expect(h.setHoveredBookKey).toHaveBeenCalledWith(null);
      expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);
      // Only the non-blocking transition-class cleanup is queued; there was
      // no leading pair of cover RAFs.
      expect(frames).toHaveLength(1);

      frames.shift()?.(16);
      await Promise.resolve();
      frames.shift()?.(32);
      await Promise.resolve();
      expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(false);
    } finally {
      raf.mockRestore();
    }
  });

  test('synchronizes toolbar state with a native layered slide lifecycle', async () => {
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    const dispatch = (phase: string) =>
      h.renderer.dispatchEvent(
        new CustomEvent('layered-turn-state', {
          detail: { phase, style: 'slide', forward: true },
        }),
      );

    act(() => {
      dispatch('before-capture');
      dispatch('covered');
    });
    expect(h.setHoveredBookKey).toHaveBeenLastCalledWith(null);
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);

    act(() => dispatch('ready'));
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(false);

    act(() => dispatch('cancelled'));
    expect(h.setHoveredBookKey).toHaveBeenLastCalledWith('book-1');
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);

    act(() => dispatch('finished'));
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(false);
  });

  test.each([
    'curl',
    'slide',
  ] as const)('synchronizes toolbar state with a web layered %s lifecycle', (style) => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    const gridCell = document.createElement('div');
    gridCell.id = 'gridcell-book-1';
    document.body.appendChild(gridCell);
    renderHook(() => useCapturedTurn('book-1', { current: makeView() }));

    const dispatch = (phase: string) =>
      h.renderer.dispatchEvent(
        new CustomEvent('layered-turn-state', {
          detail: { phase, style, forward: true },
        }),
      );

    act(() => {
      dispatch('before-capture');
      dispatch('covered');
    });
    expect(h.controllerHost).toBeNull();
    expect(h.setHoveredBookKey).toHaveBeenLastCalledWith(null);
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);

    act(() => dispatch('ready'));
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(false);

    act(() => dispatch('cancelled'));
    expect(h.setHoveredBookKey).toHaveBeenLastCalledWith('book-1');
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(true);

    act(() => dispatch('finished'));
    expect(gridCell.classList.contains('captured-turn-sync-chrome')).toBe(false);
  });

  // A warm surface is a photo of one page. Scrolled mode makes the pipeline
  // ineligible (getCapturedTurnStyle returns null), so nothing prepares a new
  // one -- but nothing dropped the old one either, and it outlived the whole
  // scrolled session. The first turn after returning to paginated then
  // animated a snapshot of wherever the reader had been before scrolling, over
  // the page they are on now: two different pages of the same book composited
  // with an offset, which reads as torn text spliced mid-word.
  //
  // Device-traced on a Xiaomi 13: that turn reused a cached surface 24,958 ms
  // old, from before the mode switch; every later turn reused a ~1,075 ms one.
  test('drops the warm surface when scrolled mode makes the pipeline ineligible', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useCapturedTurn('book-1', { current: makeView() }));
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
      h.controller.invalidatePreparedCapture.mockClear();

      h.viewSettings.scrolled = true;
      // Schedule an idle run WITHOUT invalidating first (the Settings close
      // path only schedules), so the assertion below can only be satisfied by
      // the run itself dropping the now-ineligible surface.
      act(() => setSettingsDialogOpen(true));
      act(() => setSettingsDialogOpen(false));
      h.controller.invalidatePreparedCapture.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(h.controller.prepareCapture).toHaveBeenCalledOnce();
      expect(h.controller.invalidatePreparedCapture).toHaveBeenCalled();
    } finally {
      h.viewSettings.scrolled = false;
      unmount();
      vi.useRealTimers();
    }
  });
});

describe('useCapturedTurn view.next replacement', () => {
  // The corner auto-turn awaits view.next() to keep its isAutoTurning guard up
  // (and the #873 selection scroll-pin suspended) until the turn settles. The
  // replaced view.next must return the turn's promise — discarding it resolves
  // awaiters while the page is still animating, and the pin snaps the turn back.
  test('the replaced view.next resolves only when the underlying turn settles', async () => {
    const savedStyle = h.viewSettings.pageTurnStyle;
    // push is never captured, so the wrapper takes the originals fallback path.
    h.viewSettings.pageTurnStyle = 'push';
    let resolveTurn!: () => void;
    const originalNext = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveTurn = r;
        }),
    );
    const view = makeView();
    view.next = originalNext;
    renderHook(() => useCapturedTurn('book-1', { current: view }));

    const settled = vi.fn();
    Promise.resolve(view.next() as unknown as Promise<void>).then(settled);
    await new Promise((r) => setTimeout(r, 0));
    expect(originalNext).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();

    resolveTurn();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toHaveBeenCalled();
    h.viewSettings.pageTurnStyle = savedStyle;
  });
});
