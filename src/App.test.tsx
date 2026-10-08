import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, StartupWarningsBanner } from './App';

type NavigateEvent = { payload?: { path?: unknown } };

const state = vi.hoisted(() => ({
  lexnote: { onboarded: true, initState: 'ready', startupWarnings: [] as string[] },
  loadWords: [] as boolean[],
  listeners: new Map<string, (event: NavigateEvent) => void>(),
  unlisten: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('./contexts/LexNoteContext', () => ({
  LexNoteProvider: ({ children, loadWords }: { children: ReactNode; loadWords?: boolean }) => {
    state.loadWords.push(loadWords ?? true);
    return <>{children}</>;
  },
  useLexNote: () => state.lexnote,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => state.listen(...args),
}));

vi.mock('./components/shell/NativeThemeSync', () => ({ NativeThemeSync: () => null }));
vi.mock('./components/updater/UpdateBanner', () => ({ UpdateBanner: () => <div>update-banner</div> }));
vi.mock('./pages/Library', () => ({ Library: () => <div>library-page</div> }));
vi.mock('./pages/Settings', () => ({ Settings: () => <div>settings-page</div> }));
vi.mock('./pages/Onboarding', () => ({ Onboarding: () => <div>onboarding-page</div> }));
vi.mock('./pages/Lookup', () => ({ Lookup: () => <div>lookup-page</div> }));
vi.mock('./pages/Review', () => ({ Review: () => <div>review-page</div> }));
vi.mock('./pages/Insights', () => ({ Insights: () => <div>insights-page</div> }));
vi.mock('./pages/OcrSelect', () => ({ OcrSelect: () => <div>ocr-page</div> }));

const NAVIGATE = 'gege://navigate';

/** What the lookup window does when it wants the main window to show a page. */
function askToShow(payload: NavigateEvent['payload'] | undefined) {
  const handler = state.listeners.get(NAVIGATE);
  if (!handler) throw new Error('nobody is listening for the request');
  act(() => handler(payload === undefined ? {} : { payload }));
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
  state.lexnote = { onboarded: true, initState: 'ready', startupWarnings: [] };
  state.loadWords.length = 0;
  state.listeners.clear();
  state.unlisten.mockReset();
  state.listen.mockReset();
  state.listen.mockImplementation(async (name: string, handler: (event: NavigateEvent) => void) => {
    state.listeners.set(name, handler);
    return state.unlisten;
  });
});

afterEach(() => {
  cleanup();
});

describe('the main window', () => {
  it('opens on the library', async () => {
    render(<App />);

    expect(await screen.findByText('library-page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/library');
  });

  it('loads the library, and carries the notices of the app', async () => {
    state.lexnote.startupWarnings = ['数据库已从备份恢复'];
    render(<App />);

    await screen.findByText('library-page');
    expect(state.loadWords.length).toBeGreaterThan(0);
    expect(state.loadWords.every(Boolean)).toBe(true);
    expect(screen.getByText('update-banner')).toBeInTheDocument();
    expect(screen.getByText('启动时发现问题')).toBeInTheDocument();
  });

  it('shows only the name of the app while what was saved is being read', () => {
    state.lexnote.initState = 'loading';
    render(<App />);

    expect(screen.getByText('加载中…')).toBeInTheDocument();
    expect(screen.queryByText('library-page')).not.toBeInTheDocument();
  });

  it('leads someone who has not set up a model service to the onboarding, wherever they were going', async () => {
    state.lexnote.onboarded = false;
    window.history.pushState({}, '', '/settings');
    render(<App />);

    expect(await screen.findByText('onboarding-page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/onboarding');
  });

  it('leads someone who has set one up away from the onboarding', async () => {
    window.history.pushState({}, '', '/onboarding');
    render(<App />);

    expect(await screen.findByText('library-page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/library');
  });

  describe('when the lookup window asks for a page', () => {
    it('shows it, and shows the next one it asks for after that', async () => {
      render(<App />);
      await screen.findByText('library-page');
      await waitFor(() => expect(state.listeners.has(NAVIGATE)).toBe(true));

      askToShow({ path: '/settings' });
      expect(await screen.findByText('settings-page')).toBeInTheDocument();
      expect(window.location.pathname).toBe('/settings');

      askToShow({ path: '/review' });
      expect(await screen.findByText('review-page')).toBeInTheDocument();
      expect(window.location.pathname).toBe('/review');
    });

    it('listens once, and not again every time the page changes', async () => {
      render(<App />);
      await screen.findByText('library-page');
      await waitFor(() => expect(state.listeners.has(NAVIGATE)).toBe(true));

      askToShow({ path: '/settings' });
      await screen.findByText('settings-page');
      askToShow({ path: '/insights' });
      await screen.findByText('insights-page');

      expect(state.listen).toHaveBeenCalledTimes(1);
      expect(state.unlisten).not.toHaveBeenCalled();
    });

    it.each([
      ['a path without its slash', { path: 'settings' }],
      ['something that is not a path', { path: 42 }],
      ['a request that names no page', {}],
      ['no request at all', undefined],
    ])('does not move for %s', async (_name, payload) => {
      render(<App />);
      await screen.findByText('library-page');
      await waitFor(() => expect(state.listeners.has(NAVIGATE)).toBe(true));

      askToShow(payload);

      expect(screen.getByText('library-page')).toBeInTheDocument();
      expect(window.location.pathname).toBe('/library');
    });

    it('is no longer listened for once the window is gone', async () => {
      const view = render(<App />);
      await screen.findByText('library-page');
      await waitFor(() => expect(state.listeners.has(NAVIGATE)).toBe(true));

      view.unmount();

      await waitFor(() => expect(state.unlisten).toHaveBeenCalledTimes(1));
    });

    it('puts the listener away at once when the window is gone before it was set up', async () => {
      let finishSetup!: (stop: () => void) => void;
      state.listen.mockImplementation(() => new Promise<() => void>((resolve) => (finishSetup = resolve)));
      const view = render(<App />);
      await waitFor(() => expect(state.listen).toHaveBeenCalled());

      view.unmount();
      finishSetup(state.unlisten);

      await waitFor(() => expect(state.unlisten).toHaveBeenCalledTimes(1));
    });
  });
});

describe.each([
  ['lookup', '/lookup', 'lookup-page'],
  ['text selection', '/ocr-select', 'ocr-page'],
])('the %s window', (_name, path, page) => {
  beforeEach(() => {
    window.history.pushState({}, '', path);
  });

  it('shows its page alone: no notices, no library, and no one to ask for another page', async () => {
    state.lexnote.startupWarnings = ['数据库已从备份恢复'];
    render(<App />);

    expect(await screen.findByText(page)).toBeInTheDocument();
    expect(screen.queryByText('update-banner')).not.toBeInTheDocument();
    expect(screen.queryByText('启动时发现问题')).not.toBeInTheDocument();
    expect(state.loadWords.length).toBeGreaterThan(0);
    expect(state.loadWords.some(Boolean)).toBe(false);
    expect(state.listen).not.toHaveBeenCalled();
  });
});

describe('the warnings of the start', () => {
  it('are not there when nothing went wrong', () => {
    const { container } = render(<StartupWarningsBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('say what went wrong, and are read out politely', () => {
    state.lexnote.startupWarnings = ['数据库已从备份恢复', '词库文件夹不可写'];
    render(<StartupWarningsBanner />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('启动时发现问题')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '数据库已从备份恢复',
      '词库文件夹不可写',
    ]);
  });

  it('can be put away, which puts all of them away', async () => {
    state.lexnote.startupWarnings = ['数据库已从备份恢复', '词库文件夹不可写'];
    const { container } = render(<StartupWarningsBanner />);

    await userEvent.click(screen.getByRole('button', { name: '关闭启动警告' }));

    expect(container).toBeEmptyDOMElement();
  });

  it('come back only for what is new, when the backend repeats them with something added', async () => {
    state.lexnote.startupWarnings = ['数据库已从备份恢复'];
    const view = render(<StartupWarningsBanner />);
    await userEvent.click(screen.getByRole('button', { name: '关闭启动警告' }));

    state.lexnote.startupWarnings = ['数据库已从备份恢复', '词库文件夹不可写'];
    view.rerender(<StartupWarningsBanner />);

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['词库文件夹不可写']);
  });

  it('stay away when the backend repeats what was put away', async () => {
    state.lexnote.startupWarnings = ['数据库已从备份恢复'];
    const view = render(<StartupWarningsBanner />);
    await userEvent.click(screen.getByRole('button', { name: '关闭启动警告' }));

    state.lexnote.startupWarnings = ['数据库已从备份恢复'];
    view.rerender(<StartupWarningsBanner />);

    expect(view.container).toBeEmptyDOMElement();
  });
});
