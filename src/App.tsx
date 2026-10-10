import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AlertTriangleIcon, XIcon } from 'lucide-react';
import { LexNoteProvider, useLexNote } from './contexts/LexNoteContext';
import { NativeThemeSync } from './components/shell/NativeThemeSync';
import { UpdateBanner } from './components/updater/UpdateBanner';

// Keep the initial shell small. Library, settings, review and onboarding pull
// in sizeable feature trees (motion, export/import and provider controls) that
// are not needed until their route is actually shown.
const Library = React.lazy(() => import('./pages/Library').then(({ Library: page }) => ({ default: page })));
const Settings = React.lazy(() => import('./pages/Settings').then(({ Settings: page }) => ({ default: page })));
const Onboarding = React.lazy(() => import('./pages/Onboarding').then(({ Onboarding: page }) => ({ default: page })));
const Lookup = React.lazy(() => import('./pages/Lookup').then(({ Lookup: page }) => ({ default: page })));
const Review = React.lazy(() => import('./pages/Review').then(({ Review: page }) => ({ default: page })));
const Insights = React.lazy(() => import('./pages/Insights').then(({ Insights: page }) => ({ default: page })));
const OcrSelect = React.lazy(() => import('./pages/OcrSelect').then(({ OcrSelect: page }) => ({ default: page })));

function RouteLoading() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
      <span className="text-lg font-bold text-ink">鸽鸽词典</span>
      <span className="text-xs text-ink-subtle">加载中…</span>
    </div>
  );
}

/** The event the lookup window sends to have the main window show a page (its errors point at the settings). */
const NAVIGATE_EVENT = 'gege://navigate';

function MainRouter() {
  const { onboarded, initState } = useLexNote();
  const navigate = useNavigate();
  // The listener is set up once; it always calls the latest `navigate`, which changes with the location.
  const navigateRef = React.useRef(navigate);
  React.useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const isLookup = window.location.pathname === '/lookup';
  const isOcrSelect = window.location.pathname === '/ocr-select';

  React.useEffect(() => {
    if (isLookup || isOcrSelect) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const stop = await listen<{ path: string }>(NAVIGATE_EVENT, (event) => {
          const path = event.payload?.path;
          if (typeof path === 'string' && path.startsWith('/')) navigateRef.current(path);
        });
        if (active) unlisten = stop;
        else stop();
      } catch {
        /* non-tauri */
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [isLookup, isOcrSelect]);

  if (isOcrSelect) {
    return <React.Suspense fallback={<RouteLoading />}><OcrSelect /></React.Suspense>;
  }

  if (isLookup) {
    return <React.Suspense fallback={<RouteLoading />}><Lookup /></React.Suspense>;
  }

  if (initState === 'loading') {
    return <RouteLoading />;
  }

  if (!onboarded) {
    return (
      <React.Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </React.Suspense>
    );
  }

  return (
    <React.Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="/library" element={<Library />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/review" element={<Review />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/onboarding" element={<Navigate to="/library" replace />} />
        <Route path="/lookup" element={<Lookup />} />
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </React.Suspense>
  );
}

/**
 * What went wrong when the app started (a database that had to be recovered, a folder that could
 * not be used). It sits above the page rather than over it, so the window's own controls stay
 * reachable, and it can be put away: the same text comes back from the backend every half minute.
 */
export function StartupWarningsBanner() {
  const { startupWarnings } = useLexNote();
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
  const visible = startupWarnings.filter((warning) => !dismissed.has(warning));
  if (visible.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-start gap-2 border-b border-warn bg-surface px-4 py-2 text-[11px] text-ink"
    >
      <AlertTriangleIcon size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">启动时发现问题</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {visible.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
        </ul>
      </div>
      <button
        type="button"
        aria-label="关闭启动警告"
        title="关闭（这次运行中不再显示）"
        onClick={() => setDismissed((current) => new Set([...current, ...visible]))}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-subtle hover:bg-sunken hover:text-ink"
      >
        <XIcon size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function App() {
  // The lookup and OCR windows are small separate webviews that never show the
  // library, so they must not pay for loading all of it on every cold start, nor
  // carry the main window's banners (an update notice is no use in a 420 px popup).
  const lightweightWindow = ['/lookup', '/ocr-select'].includes(window.location.pathname);
  return (
    <LexNoteProvider loadWords={!lightweightWindow}>
      <BrowserRouter>
        <div className="flex h-full w-full flex-col bg-canvas text-ink">
          {lightweightWindow ? null : (
            <>
              <NativeThemeSync />
              <UpdateBanner />
              <StartupWarningsBanner />
            </>
          )}
          <div className="min-h-0 flex-1">
            <MainRouter />
          </div>
        </div>
      </BrowserRouter>
    </LexNoteProvider>
  );
}
